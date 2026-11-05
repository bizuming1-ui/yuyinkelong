// ============================================================================
//  ESP32-S3 N16R8 · 三节点 WiFi CSI 感知固件 v4.0（A / B / C 共用同一份代码，config.h 的 NODE_ROLE 决定角色）
//
//    A（TX） ──ESP-NOW 广播(HT MCS0, 100Hz, 带序列号)──▶  B（RX1） / C（RX2）
//                                                         │ CSI 回调（只拷贝，不做任何耗时操作）
//    A/B/C ── WiFi ─▶ MQTT ◀── 浏览器（同时连多个服务器，任意断线不中断）
//
//  设计原则（来自仓库「提示词」文件）：
//   · 不做 13 信道扫频/拼接；三块板固定在路由器当前信道（HT20），B/C 只收 A 的探测帧；路由器不是探测源
//   · CSI 回调内：只读元数据 + memcpy 128 字节 + 入环形缓冲 + 计数；JSON/MQTT/浮点全部在 loop 里
//   · 原始 I/Q int8 原样上传，不做不可逆归一化；每条记录带 A 的序列号配对标志、rxCnt（可检测丢包）、boot_id
//   · 有界队列（PSRAM 1024 条），队列满则丢新数据并计数（drop）；断网时丢弃旧数据，不无限堆积
//   · 状态机：BOOT → WIFI_CONNECT → MQTT_CONNECT → RUNNING / NO_PROBE(B/C 没收到 A)；状态+计数器通过 MQTT 与串口可查
// ============================================================================
#include <Arduino.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <esp_wifi.h>
#include <esp_now.h>
#include <esp_task_wdt.h>
#include "config.h"

#define FW_VERSION   "4.0"
#define IS_TX        (NODE_ROLE == ROLE_A)
#define PKT_MAGIC    0xB8
#define PKT_VER      4
#define CSI_BYTES    128   // L-LTF：64 个子载波 × (虚部,实部) 各 int8
#define RING_N       1024  // 环形缓冲条数（PSRAM），必须是 2 的幂
#define FRAME_MAGIC  0xC5  // MQTT 二进制批包头
#define FRAME_VER    3
#define HDR_BYTES    8
#define FLAG_PAIRED  0x01
#define FLAG_HT      0x02

// A → B/C 探测帧（14 字节）
struct __attribute__((packed)) Probe {
  uint8_t  magic, ver, sender, ch;
  uint16_t boot, seq;
  uint32_t txc;      // 发射计数
  uint8_t  bw, marker;
};

// 线上记录（140 字节，与浏览器 src/lib/tri/protocol.ts 完全一致）
struct __attribute__((packed)) WireRec {
  uint8_t  flags, ch;
  int8_t   rssi, noise;
  uint16_t seqA, cnt;
  uint32_t tms;
  int8_t   csi[CSI_BYTES];
};
static_assert(sizeof(WireRec) == 140, "WireRec must be 140 bytes");

struct Slot { WireRec w; uint32_t tus; };
struct Pend { uint32_t idx; uint32_t tus; };
struct Broker { const char* host; uint16_t port; };
static const Broker BROKERS[] = MQTT_BROKERS;
static const uint8_t BCAST[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

// ---------------------------------------------------------------- 全局状态
static portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;
static Slot* ring = nullptr;
static volatile uint32_t rHead = 0, rTail = 0;
static Pend pend[16];
static volatile uint8_t pendHead = 0, pendTail = 0;

static volatile uint32_t statCsi = 0, statDrop = 0, statPub = 0, statPubFail = 0;
static volatile uint32_t statNowRx = 0, statNowTx = 0, statNowTxFail = 0;
static volatile uint32_t statPaired = 0, statUnpaired = 0, statChChg = 0, statReconn = 0;
static volatile uint16_t csiCounter = 0;
static volatile uint16_t seqA = 0;
static uint16_t bootId = 0;
static char lastErr[32] = "none";

static uint8_t aMac[6] = {0};
static volatile bool aKnown = false;
static volatile uint32_t aLastMs = 0;
static volatile uint8_t homeCh = 0;
static volatile bool wifiUp = false;
static volatile bool csiOk = false;
static volatile bool nowOk = false;

static WiFiClient net;
static PubSubClient mqtt(net);
static char topicCsi[96], topicStatus[96], topicCmd[96], clientId[40], willMsg[64];
static uint8_t txbuf[HDR_BYTES + BATCH_MAX * sizeof(WireRec)];

static uint8_t brokerIdx = 0;
static uint32_t mqttRetryAt = 0, mqttBackoff = 1000;
static uint32_t lastStatusMs = 0, lastLogMs = 0, wifiTryAt = 0, wifiDownSince = 0, lastChkCh = 0;
static uint8_t wifiSlot = 0;
static volatile bool wantStatus = false;
static bool mqttWas = false;

// ---------------------------------------------------------------- LED
static void led(uint8_t r, uint8_t g, uint8_t b) {
#if LED_BRIGHTNESS > 0 && defined(RGB_BUILTIN)
  neopixelWrite(RGB_BUILTIN, (r * LED_BRIGHTNESS) / 255, (g * LED_BRIGHTNESS) / 255, (b * LED_BRIGHTNESS) / 255);
#else
  (void)r; (void)g; (void)b;
#endif
}

static const char* stateName() {
  if (!wifiUp) return "WIFI_CONNECT";
  if (!mqtt.connected()) return "MQTT_CONNECT";
  if (IS_TX) return "RUNNING";
  return (aKnown && (millis() - aLastMs) < 3000) ? "RUNNING" : "NO_PROBE";
}

// ---------------------------------------------------------------- CSI 回调（WiFi 任务里：只拷贝，立即返回）
static void csiCb(void* ctx, wifi_csi_info_t* info) {
  (void)ctx;
  if (!info || !info->buf || info->len < CSI_BYTES) return;
  if (!aKnown || memcmp(info->mac, aMac, 6) != 0) return;      // 只要 A 发来的帧
  uint32_t h = rHead;
  if (h - rTail >= RING_N) { statDrop++; return; }              // 队列满：丢新数据并计数
  uint32_t tus = micros();
  Slot* s = &ring[h & (RING_N - 1)];
  s->w.flags = info->rx_ctrl.sig_mode ? FLAG_HT : 0;
  s->w.ch = info->rx_ctrl.channel;
  s->w.rssi = info->rx_ctrl.rssi;
  s->w.noise = (int8_t)info->rx_ctrl.noise_floor;
  s->w.seqA = 0;
  s->w.cnt = csiCounter++;
  s->w.tms = millis();
  s->tus = tus;
  memcpy(s->w.csi, info->buf, CSI_BYTES);
  portENTER_CRITICAL(&mux);
  uint8_t nx = (pendHead + 1) & 15;
  if (nx == pendTail) pendTail = (pendTail + 1) & 15;           // 待配对队列满：丢最旧
  pend[pendHead].idx = h;
  pend[pendHead].tus = tus;
  pendHead = nx;
  portEXIT_CRITICAL(&mux);
  __sync_synchronize();
  rHead = h + 1;
  statCsi++;
}

// ---------------------------------------------------------------- ESP-NOW
static void onNowRecv(const uint8_t* mac, const uint8_t* data, int len) {
  if (IS_TX || len < (int)sizeof(Probe)) return;
  const Probe* p = (const Probe*)data;
  if (p->magic != PKT_MAGIC || p->ver != PKT_VER || p->sender != ROLE_A) return;
  if (!aKnown || memcmp(aMac, mac, 6) != 0) { memcpy(aMac, mac, 6); aKnown = true; }
  aLastMs = millis();
  seqA = p->seq;
  statNowRx++;
  uint32_t tus = micros();
  bool done = false;
  portENTER_CRITICAL(&mux);
  // FIFO 配对：取时间窗内「最旧的」未配对 CSI（同一帧的 CSI 回调总是先于 ESP-NOW 回调）
  while (pendTail != pendHead) {
    Pend e = pend[pendTail];
    pendTail = (pendTail + 1) & 15;
    int32_t age = (int32_t)(tus - e.tus);
    if (age > (int32_t)PAIR_WINDOW_US) continue;               // 过期：该 CSI 以「未配对」发布
    Slot* s = &ring[e.idx & (RING_N - 1)];
    s->w.seqA = p->seq;
    s->w.flags |= FLAG_PAIRED;
    done = true;
    break;
  }
  portEXIT_CRITICAL(&mux);
  if (done) statPaired++; else statUnpaired++;                  // 收到探测帧却没有对应 CSI（CSI 被丢/未触发）
}

static void onNowSent(const uint8_t* mac, esp_now_send_status_t st) {
  (void)mac;
  if (st != ESP_NOW_SEND_SUCCESS) statNowTxFail++;
}

static uint16_t probeSeq = 0;
static uint32_t probeTxc = 0;
static void sendProbe() {
  Probe p = {PKT_MAGIC, PKT_VER, ROLE_A, homeCh, bootId, probeSeq++, probeTxc++, 20, 0x5A};
  esp_err_t e = esp_now_send(BCAST, (const uint8_t*)&p, sizeof(p));
  if (e == ESP_OK) statNowTx++;
  else { statNowTxFail++; snprintf(lastErr, sizeof(lastErr), "now_send_%d", (int)e); }
}

static bool initNow() {
  if (esp_now_init() != ESP_OK) return false;
  esp_now_register_recv_cb(onNowRecv);
  esp_now_register_send_cb(onNowSent);
  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, BCAST, 6);
  peer.channel = 0;                 // 0 = 跟随当前 STA 信道
  peer.ifidx = WIFI_IF_STA;
  peer.encrypt = false;
  if (esp_now_add_peer(&peer) != ESP_OK) return false;
  // 关键：ESP-NOW 默认 1Mbps 的 11b 帧没有 OFDM 训练序列，不会产生 CSI；改成 HT MCS0 才有 L-LTF
  esp_err_t e = esp_wifi_config_espnow_rate(WIFI_IF_STA, WIFI_PHY_RATE_MCS0_LGI);
  if (e != ESP_OK) Serial.printf("[NOW] 设置速率失败 %d\n", (int)e);
  return true;
}

// A：固定周期发射探测帧（独立任务，不受 MQTT 阻塞影响）
static void probeTask(void*) {
  TickType_t wake = xTaskGetTickCount();
  const TickType_t period = pdMS_TO_TICKS(1000 / PROBE_HZ);
  for (;;) {
    if (wifiUp && nowOk) sendProbe();           // 只有连上路由器（信道与 B/C 一致）才发射
    vTaskDelayUntil(&wake, period);
  }
}

// ---------------------------------------------------------------- WiFi
static void onWiFiEvent(WiFiEvent_t ev) {
  switch (ev) {
    case ARDUINO_EVENT_WIFI_STA_GOT_IP: {
      uint8_t ch = 0; wifi_second_chan_t s2;
      esp_wifi_get_channel(&ch, &s2);
      if (ch >= 1 && ch <= 14) homeCh = ch;
      wifiUp = true;
      Serial.printf("[WiFi] 已连接 %s 信道=%u IP=%s\n", WiFi.SSID().c_str(), homeCh, WiFi.localIP().toString().c_str());
      break;
    }
    case ARDUINO_EVENT_WIFI_STA_DISCONNECTED:
      if (wifiUp) { statReconn++; snprintf(lastErr, sizeof(lastErr), "wifi_drop"); }
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
  if (WiFi.status() == WL_CONNECTED) { wifiUp = true; wifiDownSince = 0; return; }
  wifiUp = false;
  uint32_t now = millis();
  if (!wifiDownSince) wifiDownSince = now;
  if (now - wifiDownSince > (uint32_t)WIFI_REBOOT_S * 1000UL) { Serial.println("[WiFi] 长时间断开，重启"); delay(100); ESP.restart(); }
  if (now - wifiTryAt > WIFI_RETRY_MS) {
    wifiSlot = (wifiSlot + 1) % (strlen(WIFI2_SSID) > 0 ? 2 : 1);
    wifiBegin();
  }
}

// 信道核验：AP 自动换信道时记录事件（提示词 1.2：禁止 AP 自动切换信道，或检测后安全重新同步）
static void channelVerify() {
  uint32_t now = millis();
  if (!wifiUp || now - lastChkCh < 2000) return;
  lastChkCh = now;
  uint8_t ch = 0; wifi_second_chan_t s2;
  if (esp_wifi_get_channel(&ch, &s2) == ESP_OK && ch >= 1 && ch <= 14 && ch != homeCh) {
    Serial.printf("[CH] 信道变化 %u → %u（建议在路由器里固定信道）\n", homeCh, ch);
    homeCh = ch;
    statChChg++;
    snprintf(lastErr, sizeof(lastErr), "channel_change");
  }
}

// ---------------------------------------------------------------- MQTT
static void onMqtt(char* topic, uint8_t* payload, unsigned int len) {
  (void)topic;
  char buf[64]; unsigned n = len < 63 ? len : 63;
  memcpy(buf, payload, n); buf[n] = 0;
  if (strstr(buf, "reboot")) { delay(100); ESP.restart(); }
  if (strstr(buf, "ping") || strstr(buf, "hello")) wantStatus = true;
}

static void publishStatus() {
  char js[640];
  uint32_t up = millis() / 1000;
  int n = snprintf(js, sizeof(js),
    "{\"id\":%d,\"online\":true,\"role\":\"%c\",\"fw\":\"%s\",\"boot\":%u,\"up\":%lu,\"heap\":%u,\"psram\":%u,\"rssi\":%d,\"ch\":%u,\"ip\":\"%s\","
    "\"state\":\"%s\",\"csi\":%lu,\"drop\":%lu,\"pub\":%lu,\"pubFail\":%lu,\"nowTx\":%lu,\"nowTxFail\":%lu,\"nowRx\":%lu,"
    "\"paired\":%lu,\"unpaired\":%lu,\"chChg\":%lu,\"reconnects\":%lu,\"seqA\":%u,\"broker\":%u,\"csiOk\":%s,\"err\":\"%s\"}",
    NODE_ROLE, 'A' + NODE_ROLE - 1, FW_VERSION, (unsigned)bootId, (unsigned long)up, (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getFreePsram(),
    (int)WiFi.RSSI(), homeCh, WiFi.localIP().toString().c_str(), stateName(),
    (unsigned long)statCsi, (unsigned long)statDrop, (unsigned long)statPub, (unsigned long)statPubFail,
    (unsigned long)(IS_TX ? statNowTx : 0), (unsigned long)statNowTxFail, (unsigned long)statNowRx,
    (unsigned long)statPaired, (unsigned long)statUnpaired, (unsigned long)statChChg, (unsigned long)statReconn,
    (unsigned)(IS_TX ? probeSeq : seqA), brokerIdx, csiOk ? "true" : "false", lastErr);
  if (n > 0 && n < (int)sizeof(js)) mqtt.publish(topicStatus, (const uint8_t*)js, (unsigned)n, true);
}

static void mqttMaintain() {
  if (mqtt.connected()) return;
  if (mqttWas) { mqttWas = false; statReconn++; snprintf(lastErr, sizeof(lastErr), "mqtt_drop"); }
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
    mqttWas = true;
    publishStatus();
    lastStatusMs = millis();
  } else {
    Serial.printf("[MQTT] 失败 rc=%d，换下一个服务器\n", mqtt.state());
    brokerIdx = (brokerIdx + 1) % MQTT_BROKER_COUNT;
    mqttRetryAt = millis() + mqttBackoff;
    mqttBackoff = mqttBackoff < 5000 ? mqttBackoff * 2 : 5000;
  }
}

// B/C：把环形缓冲里已「配对完成或等待超时」的记录批量发布
static void drainAndPublish() {
  uint32_t now = millis();
  static uint32_t firstSeenMs = 0, lastPubMs = 0;
  if (now - lastPubMs < PUBLISH_MIN_MS) return;       // 限速：公共服务器会丢弃超速消息
  uint32_t t = rTail, h = rHead;
  uint32_t avail = h - t;
  if (!avail) { firstSeenMs = 0; return; }
  // 统计已就绪条数（已配对，或已超过 HOLD_US 不会再被配对）
  uint32_t ready = 0, tus = micros();
  while (ready < avail && ready < BATCH_MAX) {
    const Slot* s = &ring[(t + ready) & (RING_N - 1)];
    if (!(s->w.flags & FLAG_PAIRED) && (int32_t)(tus - s->tus) < (int32_t)HOLD_US) break;
    ready++;
  }
  if (!ready) return;
  if (ready < BATCH_MAX) {
    if (!firstSeenMs) firstSeenMs = now;
    if (now - firstSeenMs < BATCH_MAX_AGE_MS) return;
  }
  firstSeenMs = 0;
  portENTER_CRITICAL(&mux);
  for (uint32_t i = 0; i < ready; i++) memcpy(txbuf + HDR_BYTES + i * sizeof(WireRec), &ring[(t + i) & (RING_N - 1)].w, sizeof(WireRec));
  rTail = t + ready;
  portEXIT_CRITICAL(&mux);
  txbuf[0] = FRAME_MAGIC; txbuf[1] = FRAME_VER; txbuf[2] = NODE_ROLE; txbuf[3] = (uint8_t)ready;
  txbuf[4] = bootId & 0xFF; txbuf[5] = bootId >> 8;
  uint16_t dr = (uint16_t)(statDrop & 0xFFFF);
  txbuf[6] = dr & 0xFF; txbuf[7] = dr >> 8;
  size_t len = HDR_BYTES + ready * sizeof(WireRec);
  lastPubMs = now;
  if (mqtt.publish(topicCsi, txbuf, len)) statPub++;
  else { statPubFail++; snprintf(lastErr, sizeof(lastErr), "mqtt_pub_fail"); }
}

// ---------------------------------------------------------------- setup / loop
void setup() {
  Serial.begin(115200);
  delay(200);
  bootId = (uint16_t)(esp_random() & 0xFFFF);
  Serial.printf("\n[BOOT] ESP32-S3 CSI v%s role=%c node=%d boot_id=%u\n", FW_VERSION, 'A' + NODE_ROLE - 1, NODE_ROLE, (unsigned)bootId);

  esp_task_wdt_init(WDT_TIMEOUT_S, true);
  esp_task_wdt_add(NULL);

  if (!IS_TX) {
    ring = (Slot*)ps_malloc(sizeof(Slot) * RING_N);
    if (!ring) ring = (Slot*)malloc(sizeof(Slot) * RING_N);
    if (!ring) { Serial.println("[MEM] 内存不足，重启"); delay(500); ESP.restart(); }
    memset(ring, 0, sizeof(Slot) * RING_N);
    Serial.printf("[MEM] 环形缓冲 %u 字节 (%s) 空闲堆=%u PSRAM=%u\n", (unsigned)(sizeof(Slot) * RING_N),
                  psramFound() ? "PSRAM" : "内部RAM", (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getFreePsram());
  }

  uint64_t mac = ESP.getEfuseMac();
  snprintf(clientId, sizeof(clientId), "bzm-tri%c-%06lx", 'a' + NODE_ROLE - 1, (unsigned long)((mac >> 24) & 0xFFFFFF));
  if (!IS_TX) snprintf(topicCsi, sizeof(topicCsi), MQTT_ROOT "/n%d/csi", NODE_ROLE);
  snprintf(topicStatus, sizeof(topicStatus), MQTT_ROOT "/n%d/status", NODE_ROLE);
  snprintf(topicCmd, sizeof(topicCmd), MQTT_ROOT "/cmd");
  snprintf(willMsg, sizeof(willMsg), "{\"id\":%d,\"online\":false}", NODE_ROLE);

  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(true);
  WiFi.onEvent(onWiFiEvent);
  esp_wifi_set_ps(WIFI_PS_NONE);
  esp_wifi_set_bandwidth(WIFI_IF_STA, WIFI_BW_HT20);            // 先固定 HT20（提示词 1.2）
  esp_wifi_set_protocol(WIFI_IF_STA, WIFI_PROTOCOL_11B | WIFI_PROTOCOL_11G | WIFI_PROTOCOL_11N);
  esp_wifi_set_max_tx_power(TX_POWER_QDBM);
  static const char* hn[] = {"", "esp32-csi-a", "esp32-csi-b", "esp32-csi-c"};
  WiFi.setHostname(hn[NODE_ROLE]);

  nowOk = initNow();
  if (!nowOk) { Serial.println("[NOW] ESP-NOW 初始化失败！"); snprintf(lastErr, sizeof(lastErr), "espnow_init"); }

  if (!IS_TX) {
    wifi_csi_config_t cfg = {};
    cfg.lltf_en = true;
    cfg.htltf_en = false;
    cfg.stbc_htltf2_en = false;
    cfg.ltf_merge_en = false;
    cfg.channel_filter_en = false;   // 不做平滑：保留原始每包 CSI
    cfg.manu_scale = false;
    cfg.shift = 0;
    esp_err_t e1 = esp_wifi_set_csi_config(&cfg);
    esp_err_t e2 = esp_wifi_set_csi_rx_cb(csiCb, nullptr);
    esp_err_t e3 = esp_wifi_set_csi(true);
    csiOk = (e1 == ESP_OK && e2 == ESP_OK && e3 == ESP_OK);
    Serial.printf("[CSI] 配置=%d 回调=%d 使能=%d %s\n", (int)e1, (int)e2, (int)e3, csiOk ? "OK" : "失败(固件库未开启CSI?)");
    if (!csiOk) snprintf(lastErr, sizeof(lastErr), "csi_init");
  }

  mqtt.setBufferSize(sizeof(txbuf) + 128);
  mqtt.setKeepAlive(MQTT_KEEPALIVE_S);
  mqtt.setSocketTimeout(4);
  mqtt.setCallback(onMqtt);
  net.setTimeout(4);

  wifiBegin();
  if (IS_TX) xTaskCreatePinnedToCore(probeTask, "probe", 4096, nullptr, 3, nullptr, 1);
  led(0, 0, 255);
}

void loop() {
  esp_task_wdt_reset();
  wifiMaintain();
  channelVerify();

  if (wifiUp) {
    mqttMaintain();
    if (mqtt.connected()) {
      mqtt.loop();
      if (!IS_TX) drainAndPublish();
      uint32_t now = millis();
      if (wantStatus || now - lastStatusMs > STATUS_EVERY_MS) {
        wantStatus = false;
        lastStatusMs = now;
        publishStatus();
      }
      bool ok = IS_TX || (aKnown && (now - aLastMs) < 3000);
      if (ok) led(0, 255, 40); else led(0, 200, 200);
    } else if (!IS_TX) {
      rTail = rHead;                 // MQTT 断开：丢弃旧数据，避免恢复后发送过期数据
    }
  } else {
    if (!IS_TX) rTail = rHead;       // 没有 WiFi：丢弃旧数据，避免缓冲堆积
    led(0, 0, 255);
  }

  if (millis() - lastLogMs > 3000) {
    lastLogMs = millis();
    // 机器可解析：key=value
    Serial.printf("[状态] role=%c boot=%u state=%s wifi=%d mqtt=%d ch=%u rssi=%d A=%d csi=%lu paired=%lu unpaired=%lu drop=%lu pub=%lu pubFail=%lu nowTx=%lu nowTxFail=%lu reconn=%lu heap=%u err=%s\n",
                  'A' + NODE_ROLE - 1, (unsigned)bootId, stateName(), (int)wifiUp, (int)mqtt.connected(), homeCh, (int)WiFi.RSSI(),
                  (int)(IS_TX || (aKnown && millis() - aLastMs < 3000)), (unsigned long)statCsi, (unsigned long)statPaired, (unsigned long)statUnpaired,
                  (unsigned long)statDrop, (unsigned long)statPub, (unsigned long)statPubFail, (unsigned long)statNowTx, (unsigned long)statNowTxFail,
                  (unsigned long)statReconn, (unsigned)ESP.getFreeHeap(), lastErr);
  }
  delay(1);
}
