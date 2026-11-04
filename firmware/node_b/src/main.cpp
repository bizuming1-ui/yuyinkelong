// ============================================================================
//  Node B（纯射频探头）v10 —— 不连路由器、不做 TLS，只用 ESP-NOW 跟 A 配合
//  状态机：SCAN（轮流监听 1..13 信道找 A 的 SYNC）→ FOLLOW（跟随 A 换台；收到 PROBE 立刻 REPLY，再把 H_AB 用 T_DATA 单播发回 A）
//          → 收到 HOME / 400ms 听不到 A → WAIT（停在会合信道 = A 的路由器信道，每 1.5 秒给 A 发一次状态 T_STAT，等 A 上传完回来再 SYNC）
//          → WAIT 超过 B_WAIT_MS 没等到 A → 回到 SCAN。B 不依赖“和 A 同时上传”，任何时候上电/掉线都能自己找回 A。
// ============================================================================
#include "radar_common.h"

enum : uint8_t { ST_SCAN = 0, ST_WAIT = 1, ST_FOLLOW = 2 };

struct RxItem {
  RFrame f;
  uint8_t mac[6];
  uint32_t cb;
};

static QueueHandle_t gQ;
static volatile uint8_t gState = ST_SCAN;
static volatile uint32_t gLastRx = 0;
static volatile uint8_t gCurCh = 0;
static volatile uint8_t gHomeCh = HOME_CHANNEL;
static uint32_t gLost = 0, gSyncs = 0, gProbeRx = 0, gCsiGot = 0, gDataTx = 0, gDataFail = 0, gLastStat = 0, gLastStatTx = 0;
static uint32_t gQDrop = 0;

static void onRecv(const uint8_t* mac, const uint8_t* d, int len) {
  if (len < (int)sizeof(RFrame) || d[0] != RMAGIC) return;
  uint8_t t = d[1];
  if (t != T_SYNC && t != T_HOP && t != T_PROBE && t != T_HOME) return;   // B 只关心 A 发来的这四种
  RxItem it;
  memcpy(&it.f, d, sizeof(RFrame));
  memcpy(it.mac, mac, 6);
  it.cb = (uint32_t)esp_timer_get_time();
  if (xQueueSend(gQ, &it, 0) != pdTRUE) gQDrop++;
}

static void sendStat() {
  if (!g_havePeer) return;
  SFrame s;
  memset(&s, 0, sizeof(s));
  s.magic = RMAGIC; s.type = T_STAT; s.rst = g_rst; s.last = g_lastStage; s.boot = g_boot;
  s.heapKB = (uint16_t)(ESP.getFreeHeap() / 1024); s.rssi = g_lastRssi; s.state = gState;
  s.uptime_ms = millis(); s.probeRx = gProbeRx; s.csiGot = gCsiGot; s.csiSeen = g_csiSeen; s.csiKept = g_csiKept;
  s.syncs = gSyncs; s.lost = gLost; s.dataTx = gDataTx; s.dataFail = gDataFail;
  sendTo(g_peerMac, &s, sizeof(s));
  gLastStatTx = millis();
}

static void enterWait(uint8_t ch) {
  esp_wifi_set_channel(ch, WIFI_SECOND_CHAN_NONE);
  gCurCh = ch;
  gHomeCh = ch;
  gLastRx = millis();
  gState = ST_WAIT;
  stageSet(S_WAIT);
  led(30, 0, 30);   // 紫：等 A
}

static void radioTask(void*) {
  RxItem it;
  for (;;) {
    if (xQueueReceive(gQ, &it, portMAX_DELAY) != pdTRUE) continue;
    const RFrame& f = it.f;
    switch (f.type) {
      case T_SYNC: {
        memcpy(g_peerMac, it.mac, 6);
        g_havePeer = true;
        g_acceptAllCsi = false;
        RFrame a;
        memset(&a, 0, sizeof(a));
        a.magic = RMAGIC; a.type = T_ACK; a.sweep = f.sweep;
        sendFrame(a);                       // 先回 ACK（越快越好），再做其它事
        addPeer(g_peerMac);
        gHomeCh = f.home;
        gCurCh = f.ch;
        gLastRx = millis();
        gSyncs++;
        gState = ST_FOLLOW;
        stageSet(S_FOLLOW);
        led(0, 30, 30);                     // 青：跟随扫描
        sendStat();
        break;
      }
      case T_HOP:
        if (gState == ST_FOLLOW) {
          if (f.ch != gCurCh) {
            esp_wifi_set_channel(f.ch, WIFI_SECOND_CHAN_NONE);
            gCurCh = f.ch;
          }
          gLastRx = millis();
        }
        break;
      case T_PROBE:
        if (gState == ST_FOLLOW && f.ch == gCurCh) {
          RFrame r;
          memset(&r, 0, sizeof(r));
          r.magic = RMAGIC; r.type = T_REPLY; r.sweep = f.sweep; r.ch = f.ch; r.seq = f.seq; r.t1 = f.t1;
          r.t2 = (uint32_t)esp_timer_get_time() - it.cb;     // 周转时间
          sendFrame(r);
          gProbeRx++;
          gLastRx = millis();
          CsiSlot s;
          if (waitTakeCsi(it.cb, &s, 2500)) {
            DFrame df;
            df.magic = RMAGIC; df.type = T_DATA; df.sweep = f.sweep; df.ch = f.ch; df.seq = f.seq;
            df.rssi = s.rssi; df.flags = 0; df.ts = s.hw_ts; df.aux = f.t1;
            memcpy(df.csi, s.buf, 128);
            if (sendTo(g_peerMac, &df, sizeof(df)) == ESP_OK) gDataTx++; else gDataFail++;
            gCsiGot++;
          }
        }
        break;
      case T_HOME:
        if (gState == ST_FOLLOW) enterWait(f.home ? f.home : gHomeCh);
        break;
      default: break;
    }
  }
}

static void scanStep() {
  static uint8_t ch = 0;
  static uint32_t cycleStart = 0;
  ch = ch % 13 + 1;
  if (ch == 1) {
    if (cycleStart != 0) rlog("[scan] 找 A 中：已轮询 1..13 信道一圈（A 的 SYNC 还没听到；确认 A 已上电、PAIR_MAGIC 与 A 相同）");
    cycleStart = millis();
  }
  if (gState != ST_SCAN) return;     // 刚好在这一刻收到了 A 的 SYNC：不要再改信道
  esp_wifi_set_channel(ch, WIFI_SECOND_CHAN_NONE);
  if (gState == ST_SCAN) gCurCh = ch;
  for (int i = 0; i < (B_SCAN_DWELL_MS / 5) && gState == ST_SCAN; i++) delay(5);
}

void setup() {
  bootInfoInit();
  serialBegin();
  delay(300);
  led(30, 30, 30);
  rlog("==== ESP32-S3 CSI Radar  Node B (射频探头, 不联网)  fw %s ====", FW_VERSION);
  rlog("上次复位原因: %s | 复位前阶段: %s", rstName(g_rst), stageName(g_lastStage));
  bootIdInit();
  gQ = xQueueCreate(24, sizeof(RxItem));
  radioInit(onRecv);
  radioSweepMode(gHomeCh);   // 开混杂 + CSI；之后只用 ESP-NOW，不会再连路由器
  xTaskCreatePinnedToCore(radioTask, "radio", 8192, nullptr, 10, nullptr, 1);
  rlog("MAC = %s", WiFi.macAddress().c_str());
  stageSet(S_SCAN);
  led(30, 0, 30);
}

void loop() {
  switch (gState) {
    case ST_SCAN:
      stageSet(S_SCAN);
      scanStep();
      break;
    case ST_WAIT:
      if (millis() - gLastRx > B_WAIT_MS) {
        rlog("[wait] %d 秒没等到 A 回来，重新扫描 1..13 信道找 A", B_WAIT_MS / 1000);
        gState = ST_SCAN;
      } else delay(5);
      break;
    case ST_FOLLOW:
      stageSet(S_FOLLOW);
      if (millis() - gLastRx > 400) {
        gLost++;
        rlog("[sync] ⚠ 400ms 没听到 A，同步丢失，回会合信道 %d (累计 %lu 次)", (int)gHomeCh, (unsigned long)gLost);
        enterWait(gHomeCh);
      } else delay(5);
      break;
  }
  if (gState == ST_WAIT && g_havePeer && millis() - gLastStatTx > 1500) sendStat();
  if (millis() - gLastStat > 3000) {
    gLastStat = millis();
    rlog("[stat] state=%d ch=%d | 同步 %lu 次 丢失 %lu | 收到探测 %lu CSI %lu | 数据帧发出 %lu 失败 %lu | CSI回调 %lu/%lu | 队列丢 %lu", (int)gState, (int)gCurCh,
         (unsigned long)gSyncs, (unsigned long)gLost, (unsigned long)gProbeRx, (unsigned long)gCsiGot, (unsigned long)gDataTx,
         (unsigned long)gDataFail, (unsigned long)g_csiKept, (unsigned long)g_csiSeen, (unsigned long)gQDrop);
  }
}
