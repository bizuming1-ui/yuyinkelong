// ============================================================================
//  ESP32-S3 N16R8 · 双节点 WiFi CSI 雷达固件 v2.0（ESP32-1 / ESP32-2 共用同一份代码）
//
//  数据流（全程无线，不需要 USB 连电脑）：
//    ESP32-1 <== ESP-NOW(HT MCS0 帧，每帧触发硬件 CSI) ==> ESP32-2
//         │ 每个节点把自己"收到的对端帧"的 CSI 打包                │
//         └──── WiFi ──▶ MQTT(公共 broker，自动轮换) ◀──── WiFi ──┘
//                              │
//                              ▼  WebSocket(MQTT over WSS)
//                       浏览器 3D 模拟器（多信道拼接 + 路径长度剖面）
//
//  多信道拼接：ESP32-1 每隔 SWEEP_PERIOD_MS 广播"扫频命令"，两块板子按同一时间表在
//  1..13 信道上各停留 SWEEP_DWELL_MS，互发探测帧；扫完立刻回到路由器信道，MQTT/WiFi 不断线。
//
//  稳定性：任务看门狗 + WiFi 自动重连/备用热点 + MQTT 多服务器轮换 + 环形缓冲(PSRAM) + 遗嘱消息。
// ============================================================================
#include <Arduino.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <esp_wifi.h>
#include <esp_now.h>
#include <esp_task_wdt.h>
#include "config.h"

// ---------------------------------------------------------------- 常量与数据结构
#define FW_VERSION      "2.0"
#define PKT_MAGIC       0xB7
#define PKT_PROBE       1
#define PKT_SWEEP       2
#define LINK_PEER       0     // 来自另一块 ESP32
#define LINK_AP         1     // 来自路由器（信标）
#define CSI_BYTES       128   // L-LTF：64 个子载波 × (虚部,实部) 各 int8
#define RING_N          1024  // 环形缓冲条数（PSRAM）
#define FRAME_MAGIC     0xC5  // MQTT 二进制批包头
#define FRAME_VER       2

struct __attribute__((packed)) CsiRec {
  uint8_t  link;
  uint8_t  ch;
  int8_t   rssi;
  uint8_t  sweepId;   // 0 = 不在扫频中
  uint16_t cnt;
  uint32_t tms;
  int8_t   csi[CSI_BYTES];
};  // 138 字节

struct __attribute__((packed)) Pkt {
  uint8_t  magic, type, node, ch;
  uint16_t seq;
  uint8_t  sweepId, startMs, dwellMs, nch, chFirst;
};

struct Broker { const char* host; uint16_t port; };
static const Broker BROKERS[] = MQTT_BROKERS;

static const uint8_t BCAST[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

// ---------------------------------------------------------------- 全局状态
static CsiRec* ring = nullptr;
static volatile uint32_t rHead = 0, rTail = 0;
static volatile uint32_t statCsi = 0, statDrop = 0, statPub = 0, statPubFail = 0;
static volatile uint32_t statNowRx = 0, statNowTx = 0, statNowTxFail = 0;
static volatile uint16_t csiCounter = 0;

static uint8_t peerMac[6] = {0};
static volatile bool peerKnown = false;
static volatile uint32_t peerLastMs = 0;
static volatile uint8_t homeCh = 1;
static volatile uint8_t curSweepId = 0;
static volatile bool sweepActive = false;
static volatile bool pendingSweep = false;
static volatile uint32_t pendingT0 = 0;
static volatile uint8_t pendingId = 0, pendingDwell = SWEEP_DWELL_MS, pendingNch = SWEEP_CH_COUNT, pendingFirst = SWEEP_CH_FIRST;
static volatile uint8_t lastSweepIdSeen = 0;
static volatile uint32_t nextSweepMs = 0;
static volatile uint32_t statSweeps = 0;
static volatile bool wifiUp = false;
static uint8_t apBssid[6] = {0};
static volatile uint32_t lastApMs = 0;
static volatile bool csiOk = false;

static WiFiClient net;
static PubSubClient mqtt(net);
static char topicCsi[96], topicStatus[96], topicCmd[96], clientId[40], willMsg[64];
static uint8_t txbuf[4 + BATCH_MAX * sizeof(CsiRec)];

static uint8_t brokerIdx = 0;
static uint32_t mqttRetryAt = 0, mqttBackoff = 1000;
static uint32_t lastStatusMs = 0, lastLogMs = 0, wifiTryAt = 0, wifiSince = 0;
static uint8_t wifiSlot = 0;
static volatile bool wantStatus = false;

// ---------------------------------------------------------------- LED
static void led(uint8_t r, uint8_t g, uint8_t b) {
#if LED_BRIGHTNESS > 0 && defined(RGB_BUILTIN)
  neopixelWrite(RGB_BUILTIN, (r * LED_BRIGHTNESS) / 255, (g * LED_BRIGHTNESS) / 255, (b * LED_BRIGHTNESS) / 255);
#else
  (void)r; (void)g; (void)b;
#endif
}

// ---------------------------------------------------------------- 信道切换（连着 WiFi 也能切）
static void hopTo(uint8_t ch) {
  esp_wifi_set_promiscuous(true);
  esp_wifi_set_channel(ch, WIFI_SECOND_CHAN_NONE);
  esp_wifi_set_promiscuous(false);
}

// ---------------------------------------------------------------- CSI 回调（WiFi 任务里，必须极快）
static void csiCb(void* ctx, wifi_csi_info_t* info) {
  (void)ctx;
  if (!info || !info->buf || info->len != CSI_BYTES) return;
  uint8_t link;
  uint32_t now = millis();
  if (peerKnown && memcmp(info->mac, peerMac, 6) == 0) {
    link = LINK_PEER;
  } else if (memcmp(info->mac, apBssid, 6) == 0) {
    if (sweepActive) return;                                  // 扫频期间只要对端帧
    if (now - lastApMs < (1000 / AP_CSI_MAX_HZ)) return;
    lastApMs = now;
    link = LINK_AP;
  } else {
    return;
  }
  uint32_t h = rHead;
  if (h - rTail >= RING_N) { statDrop++; return; }
  CsiRec* r = &ring[h & (RING_N - 1)];
  r->link = link;
  r->ch = info->rx_ctrl.channel;
  r->rssi = info->rx_ctrl.rssi;
  r->sweepId = curSweepId;
  r->cnt = csiCounter++;
  r->tms = now;
  memcpy(r->csi, info->buf, CSI_BYTES);
  __sync_synchronize();
  rHead = h + 1;
  statCsi++;
}

// ---------------------------------------------------------------- ESP-NOW
static void onNowRecv(const uint8_t* mac, const uint8_t* data, int len) {
  if (len < (int)sizeof(Pkt)) return;
  const Pkt* p = (const Pkt*)data;
  if (p->magic != PKT_MAGIC || p->node == NODE_ID) return;
  if (!peerKnown || memcmp(peerMac, mac, 6) != 0) { memcpy(peerMac, mac, 6); peerKnown = true; }
  peerLastMs = millis();
  statNowRx++;
  if (p->type == PKT_SWEEP && NODE_ID != 1 && !sweepActive && p->sweepId != lastSweepIdSeen) {
    lastSweepIdSeen = p->sweepId;
    pendingId = p->sweepId;
    pendingDwell = p->dwellMs;
    pendingNch = p->nch;
    pendingFirst = p->chFirst;
    pendingT0 = millis() + p->startMs;
    pendingSweep = true;
  }
}

static void onNowSent(const uint8_t* mac, esp_now_send_status_t st) {
  (void)mac;
  if (st != ESP_NOW_SEND_SUCCESS) statNowTxFail++;
}

static uint16_t probeSeq = 0;
static void sendProbe() {
  Pkt p = {PKT_MAGIC, PKT_PROBE, NODE_ID, 0, probeSeq++, curSweepId, 0, 0, 0, 0};
  uint8_t cur = 0; wifi_second_chan_t s2;
  esp_wifi_get_channel(&cur, &s2);
  p.ch = cur;
  if (esp_now_send(BCAST, (const uint8_t*)&p, sizeof(p)) == ESP_OK) statNowTx++;
}

static bool initNow() {
  if (esp_now_init() != ESP_OK) return false;
  esp_now_register_recv_cb(onNowRecv);
  esp_now_register_send_cb(onNowSent);
  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, BCAST, 6);
  peer.channel = 0;
  peer.ifidx = WIFI_IF_STA;
  peer.encrypt = false;
  if (esp_now_add_peer(&peer) != ESP_OK) return false;
  // 关键：ESP-NOW 默认 1Mbps 的 11b 帧没有 OFDM 训练序列，不会产生 CSI；改成 HT MCS0 才有 L-LTF
  esp_err_t e = esp_wifi_config_espnow_rate(WIFI_IF_STA, WIFI_PHY_RATE_MCS0_LGI);
  if (e != ESP_OK) Serial.printf("[NOW] 设置速率失败 %d\n", (int)e);
  return true;
}

// ---------------------------------------------------------------- 扫频任务（精确到 1ms，独立任务）
static void issueSweep() {
  static uint8_t seqId = 0;
  seqId = (seqId % 254) + 1;
  uint32_t t0 = millis() + SWEEP_LEAD_MS;
  for (int i = 0; i < 3; i++) {                      // 连发 3 次，防止对端漏收
    int32_t remain = (int32_t)(t0 - millis());
    if (remain < 0) remain = 0;
    Pkt p = {PKT_MAGIC, PKT_SWEEP, NODE_ID, homeCh, 0, seqId, (uint8_t)remain, SWEEP_DWELL_MS, SWEEP_CH_COUNT, SWEEP_CH_FIRST};
    esp_now_send(BCAST, (const uint8_t*)&p, sizeof(p));
    vTaskDelay(pdMS_TO_TICKS(3));
  }
  pendingId = seqId;
  pendingDwell = SWEEP_DWELL_MS;
  pendingNch = SWEEP_CH_COUNT;
  pendingFirst = SWEEP_CH_FIRST;
  pendingT0 = t0;
  pendingSweep = true;
}

static void runSweep() {
  uint32_t t0 = pendingT0;
  uint8_t id = pendingId, dwell = pendingDwell, nch = pendingNch, first = pendingFirst;
  pendingSweep = false;
  while ((int32_t)(millis() - t0) < 0) vTaskDelay(1);
  sweepActive = true;
  curSweepId = id;
  uint8_t guard = 4;
  for (uint8_t i = 0; i < nch; i++) {
    uint8_t ch = first + i;
    uint32_t tStart = t0 + (uint32_t)i * dwell;
    uint32_t tEnd = tStart + dwell;
    while ((int32_t)(millis() - tStart) < 0) vTaskDelay(1);
    hopTo(ch);
    vTaskDelay(pdMS_TO_TICKS(guard));
    while ((int32_t)(millis() - (tEnd - 3)) < 0) {
      sendProbe();
      vTaskDelay(pdMS_TO_TICKS(4));
    }
    while ((int32_t)(millis() - tEnd) < 0) vTaskDelay(1);
  }
  hopTo(homeCh);
  vTaskDelay(pdMS_TO_TICKS(5));
  curSweepId = 0;
  sweepActive = false;
  statSweeps++;
  nextSweepMs = millis() + SWEEP_PERIOD_MS;
}

static void probeTask(void*) {
  TickType_t wake = xTaskGetTickCount();
  uint32_t lastProbe = 0;
  const uint32_t period = 1000 / PROBE_HZ;
  for (;;) {
    uint32_t now = millis();
#if SWEEP_ENABLE
    if (NODE_ID == 1 && wifiUp && csiOk && !sweepActive && !pendingSweep && peerKnown &&
        (now - peerLastMs) < 3000 && (int32_t)(now - nextSweepMs) >= 0) {
      issueSweep();
    }
#endif
    if (pendingSweep && !sweepActive) {
      runSweep();
    } else if (!sweepActive && (now - lastProbe) >= period) {
      lastProbe = now;
      sendProbe();
    }
    vTaskDelayUntil(&wake, pdMS_TO_TICKS(1));
  }
}

// ---------------------------------------------------------------- WiFi
static void onWiFiEvent(WiFiEvent_t ev) {
  switch (ev) {
    case ARDUINO_EVENT_WIFI_STA_GOT_IP: {
      uint8_t ch = 0; wifi_second_chan_t s2;
      esp_wifi_get_channel(&ch, &s2);
      if (ch >= 1 && ch <= 14) homeCh = ch;
      wifi_ap_record_t ap;
      if (esp_wifi_sta_get_ap_info(&ap) == ESP_OK) memcpy(apBssid, ap.bssid, 6);
      wifiUp = true;
      wifiSince = millis();
      Serial.printf("[WiFi] 已连接 %s 信道=%u IP=%s\n", WiFi.SSID().c_str(), homeCh, WiFi.localIP().toString().c_str());
      break;
    }
    case ARDUINO_EVENT_WIFI_STA_DISCONNECTED:
      wifiUp = false;
      break;
    default: break;
  }
}

static void wifiBegin() {
  const char* ssid = WIFI_SSID; const char* pass = WIFI_PASS;
  if (wifiSlot == 1 && strlen(WIFI2_SSID) > 0) { ssid = WIFI2_SSID; pass = WIFI2_PASS; }
  Serial.printf("[WiFi] 连接 %s ...\n", ssid);
  WiFi.disconnect(false, false);
  WiFi.begin(ssid, pass);
  wifiTryAt = millis();
}

static void wifiMaintain() {
  if (WiFi.status() == WL_CONNECTED) { wifiUp = true; return; }
  wifiUp = false;
  if (millis() - wifiTryAt > WIFI_RETRY_MS) {
    wifiSlot = (wifiSlot + 1) % (strlen(WIFI2_SSID) > 0 ? 2 : 1);
    wifiBegin();
  }
}

// ---------------------------------------------------------------- MQTT
static void onMqtt(char* topic, uint8_t* payload, unsigned int len) {
  (void)topic;
  char buf[64]; unsigned n = len < 63 ? len : 63;
  memcpy(buf, payload, n); buf[n] = 0;
  if (strstr(buf, "reboot")) { delay(100); ESP.restart(); }
  if (strstr(buf, "sweep")) nextSweepMs = 0;
  if (strstr(buf, "ping") || strstr(buf, "hello")) wantStatus = true;
}

static void publishStatus() {
  char js[420];
  uint32_t up = millis() / 1000;
  int n = snprintf(js, sizeof(js),
    "{\"id\":%d,\"online\":true,\"fw\":\"%s\",\"up\":%lu,\"heap\":%u,\"psram\":%u,\"rssi\":%d,\"ch\":%u,\"ip\":\"%s\","
    "\"csi\":%lu,\"drop\":%lu,\"pub\":%lu,\"pubFail\":%lu,\"nowRx\":%lu,\"nowTx\":%lu,\"nowTxFail\":%lu,\"sweeps\":%lu,"
    "\"peer\":%s,\"broker\":%u,\"sweepOn\":%d,\"csiOk\":%s}",
    NODE_ID, FW_VERSION, (unsigned long)up, (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getFreePsram(), (int)WiFi.RSSI(), homeCh,
    WiFi.localIP().toString().c_str(),
    (unsigned long)statCsi, (unsigned long)statDrop, (unsigned long)statPub, (unsigned long)statPubFail,
    (unsigned long)statNowRx, (unsigned long)statNowTx, (unsigned long)statNowTxFail, (unsigned long)statSweeps,
    (peerKnown && millis() - peerLastMs < 3000) ? "true" : "false", brokerIdx, SWEEP_ENABLE, csiOk ? "true" : "false");
  if (n > 0) mqtt.publish(topicStatus, (const uint8_t*)js, (unsigned)n, true);
}

static void mqttMaintain() {
  if (mqtt.connected()) return;
  uint32_t now = millis();
  if (now < mqttRetryAt) return;
  const Broker& b = BROKERS[brokerIdx];
  mqtt.setServer(b.host, b.port);
  Serial.printf("[MQTT] 连接 %s:%u ...\n", b.host, b.port);
  led(255, 160, 0);
  esp_task_wdt_reset();
  if (mqtt.connect(clientId, nullptr, nullptr, topicStatus, 0, true, willMsg, true)) {
    Serial.printf("[MQTT] 已连接 %s\n", b.host);
    mqtt.subscribe(topicCmd, 0);
    mqttBackoff = 1000;
    publishStatus();
    lastStatusMs = millis();
  } else {
    Serial.printf("[MQTT] 失败 rc=%d，换下一个服务器\n", mqtt.state());
    brokerIdx = (brokerIdx + 1) % MQTT_BROKER_COUNT;
    mqttRetryAt = millis() + mqttBackoff;
    mqttBackoff = mqttBackoff < 5000 ? mqttBackoff * 2 : 5000;
  }
}

static void drainAndPublish() {
  if (sweepActive) return;
  uint32_t now = millis();
  static uint32_t firstSeenMs = 0, lastPubMs = 0;
  if (now - lastPubMs < PUBLISH_MIN_MS) return;       // 限速：公共服务器会丢弃超速消息
  uint32_t t = rTail, h = rHead;
  uint32_t avail = h - t;
  if (!avail) { firstSeenMs = 0; return; }
  if (avail < BATCH_MAX) {
    if (!firstSeenMs) firstSeenMs = now;
    if (now - firstSeenMs < BATCH_MAX_AGE_MS) return;
  }
  firstSeenMs = 0;
  // 积压严重时优先发扫频数据，丢弃过期的连续流数据
  bool congested = avail > 240;
  uint32_t cnt = 0, scanned = 0;
  while (scanned < avail && cnt < BATCH_MAX) {
    const CsiRec* r = &ring[(t + scanned) & (RING_N - 1)];
    scanned++;
    if (congested && r->sweepId == 0) { statDrop++; continue; }
    memcpy(txbuf + 4 + cnt * sizeof(CsiRec), r, sizeof(CsiRec));
    cnt++;
  }
  rTail = t + scanned;
  if (!cnt) return;
  txbuf[0] = FRAME_MAGIC; txbuf[1] = FRAME_VER; txbuf[2] = NODE_ID; txbuf[3] = (uint8_t)cnt;
  size_t len = 4 + cnt * sizeof(CsiRec);
  lastPubMs = now;
  if (mqtt.publish(topicCsi, txbuf, len)) statPub++; else statPubFail++;
}

// ---------------------------------------------------------------- setup / loop
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.printf("\n=== ESP32-S3 CSI 雷达 v%s · 节点 ESP32-%d ===\n", FW_VERSION, NODE_ID);

  esp_task_wdt_init(WDT_TIMEOUT_S, true);
  esp_task_wdt_add(NULL);

  ring = (CsiRec*)ps_malloc(sizeof(CsiRec) * RING_N);
  if (!ring) ring = (CsiRec*)malloc(sizeof(CsiRec) * RING_N);
  if (!ring) { Serial.println("内存不足，重启"); delay(500); ESP.restart(); }
  Serial.printf("[MEM] 环形缓冲 %u 字节 (%s) 空闲堆=%u PSRAM=%u\n", (unsigned)(sizeof(CsiRec) * RING_N),
                psramFound() ? "PSRAM" : "内部RAM", (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getFreePsram());

  uint64_t mac = ESP.getEfuseMac();
  snprintf(clientId, sizeof(clientId), "bzm-n%d-%06lx", NODE_ID, (unsigned long)((mac >> 24) & 0xFFFFFF));
  snprintf(topicCsi, sizeof(topicCsi), MQTT_ROOT "/n%d/csi", NODE_ID);
  snprintf(topicStatus, sizeof(topicStatus), MQTT_ROOT "/n%d/status", NODE_ID);
  snprintf(topicCmd, sizeof(topicCmd), MQTT_ROOT "/cmd");
  snprintf(willMsg, sizeof(willMsg), "{\"id\":%d,\"online\":false}", NODE_ID);

  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(true);
  WiFi.onEvent(onWiFiEvent);
  esp_wifi_set_ps(WIFI_PS_NONE);
  esp_wifi_set_bandwidth(WIFI_IF_STA, WIFI_BW_HT20);
  esp_wifi_set_protocol(WIFI_IF_STA, WIFI_PROTOCOL_11B | WIFI_PROTOCOL_11G | WIFI_PROTOCOL_11N);
  esp_wifi_set_max_tx_power(TX_POWER_QDBM);
  WiFi.setHostname(NODE_ID == 1 ? "esp32-csi-1" : "esp32-csi-2");

  if (!initNow()) Serial.println("[NOW] ESP-NOW 初始化失败！");

  wifi_csi_config_t cfg = {};
  cfg.lltf_en = true;
  cfg.htltf_en = false;
  cfg.stbc_htltf2_en = false;
  cfg.ltf_merge_en = false;
  cfg.channel_filter_en = false;
  cfg.manu_scale = false;
  cfg.shift = 0;
  esp_err_t e1 = esp_wifi_set_csi_config(&cfg);
  esp_err_t e2 = esp_wifi_set_csi_rx_cb(csiCb, nullptr);
  esp_err_t e3 = esp_wifi_set_csi(true);
  csiOk = (e1 == ESP_OK && e2 == ESP_OK && e3 == ESP_OK);
  Serial.printf("[CSI] 配置=%d 回调=%d 使能=%d %s\n", (int)e1, (int)e2, (int)e3, csiOk ? "OK" : "失败(固件库未开启CSI?)");

  mqtt.setBufferSize(sizeof(txbuf) + 128);
  mqtt.setKeepAlive(MQTT_KEEPALIVE_S);
  mqtt.setSocketTimeout(4);
  mqtt.setCallback(onMqtt);
  net.setTimeout(4);

  wifiBegin();
  nextSweepMs = millis() + 6000;
  xTaskCreatePinnedToCore(probeTask, "probe", 4096, nullptr, 3, nullptr, 1);
  led(0, 0, 255);
}

void loop() {
  esp_task_wdt_reset();
  wifiMaintain();

  if (wifiUp) {
    mqttMaintain();
    if (mqtt.connected()) {
      mqtt.loop();
      drainAndPublish();
      uint32_t now = millis();
      if (wantStatus || now - lastStatusMs > STATUS_EVERY_MS) {
        wantStatus = false;
        lastStatusMs = now;
        publishStatus();
      }
      bool peerOk = peerKnown && (now - peerLastMs) < 3000;
      if (peerOk) led(0, 255, 40); else led(0, 200, 200);
    }
  } else {
    // 没有 WiFi 时丢弃旧数据，避免缓冲堆积
    rTail = rHead;
    led(0, 0, 255);
  }

  if (millis() - lastLogMs > 3000) {
    lastLogMs = millis();
    Serial.printf("[状态] wifi=%d mqtt=%d ch=%u rssi=%d 对端=%d csi=%lu 发布=%lu 失败=%lu 丢=%lu 扫频=%lu 堆=%u\n",
                  (int)wifiUp, (int)mqtt.connected(), homeCh, (int)WiFi.RSSI(), (int)(peerKnown && millis() - peerLastMs < 3000),
                  (unsigned long)statCsi, (unsigned long)statPub, (unsigned long)statPubFail, (unsigned long)statDrop,
                  (unsigned long)statSweeps, (unsigned)ESP.getFreeHeap());
  }
  delay(1);
}
