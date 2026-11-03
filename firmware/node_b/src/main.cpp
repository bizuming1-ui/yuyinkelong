// ============================================================================
//  Node B（响应端）—— 跟随 A 的换台指令，收到 PROBE 立即 REPLY，并记录 H_AB
//  状态机：UPLOAD（回路由器上传）→ READY（等 A 的 SYNC，回 ACK）→ FOLLOW（跟随换台/回复探测）→ 收到 HOME 或超时 → UPLOAD
//  READY 超过 4 秒没听到 A：在 1..13 信道轮流监听（每信道 120ms）直到听到 A 的 SYNC。
// ============================================================================
#include "radar_common.h"

enum : uint8_t { ST_UPLOAD = 0, ST_READY = 1, ST_FOLLOW = 2 };

struct RxItem {
  RFrame f;
  uint8_t mac[6];
  uint32_t cb;
};

static QueueHandle_t gQ;
static volatile uint8_t gState = ST_UPLOAD;
static volatile uint32_t gLastRx = 0;
static volatile uint8_t gCurCh = 0;
static uint8_t gHomeCh = HOME_CHANNEL;
static uint32_t gReadySince = 0, gLost = 0, gSyncs = 0, gProbeRx = 0, gCsiGot = 0, gLastStat = 0;

static void onRecv(const uint8_t* mac, const uint8_t* d, int len) {
  if (len < (int)sizeof(RFrame) || d[0] != RMAGIC) return;
  RxItem it;
  memcpy(&it.f, d, sizeof(RFrame));
  memcpy(it.mac, mac, 6);
  it.cb = (uint32_t)esp_timer_get_time();
  xQueueSend(gQ, &it, 0);
}

static void radioTask(void*) {
  RxItem it;
  for (;;) {
    if (xQueueReceive(gQ, &it, portMAX_DELAY) != pdTRUE) continue;
    const RFrame& f = it.f;
    switch (f.type) {
      case T_SYNC:
        if (gState == ST_READY) {
          memcpy(g_peerMac, it.mac, 6);
          g_havePeer = true;
          gHomeCh = f.home;
          RFrame a;
          memset(&a, 0, sizeof(a));
          a.magic = RMAGIC; a.type = T_ACK; a.sweep = f.sweep;
          sendFrame(a);
          gCurCh = 0;
          gLastRx = millis();
          gSyncs++;
          gState = ST_FOLLOW;
        }
        break;
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
            recAdd(0, f.ch, f.seq, f.sweep, s, f.t1);
            gCsiGot++;
          }
        }
        break;
      case T_HOME:
        if (gState == ST_FOLLOW) {
          gHomeCh = f.ch;
          esp_wifi_set_channel(f.ch, WIFI_SECOND_CHAN_NONE);
          gCurCh = f.ch;
          gState = ST_UPLOAD;
        }
        break;
      default: break;
    }
  }
}

static void scanForA() {
  rlog("[scan] 4 秒没听到 Node A，轮流监听 1..13 信道 …");
  for (int ch = 1; ch <= 13 && gState == ST_READY; ch++) {
    esp_wifi_set_channel(ch, WIFI_SECOND_CHAN_NONE);
    for (int i = 0; i < 24 && gState == ST_READY; i++) delay(5);
  }
  if (gState == ST_READY) esp_wifi_set_channel(gHomeCh, WIFI_SECOND_CHAN_NONE);
  gReadySince = millis();
}

void setup() {
  serialBegin();
  delay(300);
  rlog("==== ESP32-S3 CSI Radar  Node B (响应端)  fw %s ====", FW_VERSION);
  if (!recsInit()) rlog("❌ 内存不足");
  gQ = xQueueCreate(24, sizeof(RxItem));
  radioInit(onRecv);
  xTaskCreatePinnedToCore(radioTask, "radio", 6144, nullptr, 10, nullptr, 1);
  rlog("MAC = %s", WiFi.macAddress().c_str());
}

void loop() {
  switch (gState) {
    case ST_UPLOAD: {
      homeUpload(1, &gHomeCh);
      radioSweepMode(gHomeCh);
      gReadySince = millis();
      gState = ST_READY;
      rlog("[ready] 在信道 %d 等待 Node A 的 SYNC", gHomeCh);
      break;
    }
    case ST_READY:
      if (millis() - gReadySince > 4000) scanForA();
      else delay(5);
      break;
    case ST_FOLLOW:
      if (millis() - gLastRx > 400) {
        gLost++;
        rlog("[sync] ⚠ 400ms 没听到 A，同步丢失，回家信道 %d (累计 %lu 次)", gHomeCh, (unsigned long)gLost);
        esp_wifi_set_channel(gHomeCh, WIFI_SECOND_CHAN_NONE);
        gCurCh = gHomeCh;
        gState = ST_UPLOAD;
      } else delay(5);
      break;
  }
  if (millis() - gLastStat > 3000) {
    gLastStat = millis();
    rlog("[stat] state=%d ch=%d | 同步 %lu 次 丢失 %lu | 收到探测 %lu CSI %lu | 待传 %u | CSI回调 %lu/%lu", (int)gState, (int)gCurCh,
         (unsigned long)gSyncs, (unsigned long)gLost, (unsigned long)gProbeRx, (unsigned long)gCsiGot, (unsigned)g_nrec,
         (unsigned long)g_csiKept, (unsigned long)g_csiSeen);
  }
}
