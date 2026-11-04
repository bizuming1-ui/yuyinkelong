// ============================================================================
//  ESP32-S3 WiFi CSI 成像与全物体检测雷达 主节点固件 (v11.0.0)
//  ★ 1 块 ESP32-S3 即可完整运行整个系统（SINGLE_NODE_MODE=1 默认开启）：
//    · 全程保持 WiFi 连接路由器/手机热点，不切台、不断线；
//    · 50Hz 高频 UDP/ESP-NOW 混合微脉冲激励路由器回包，触发 64 子载波原始复数 CSI；
//    · 同时捕获同信道周围所有无线设备与多径反射体，每 ~1.1 秒向 Kaggle 上传一批完整剖面数据；
//    · 若第 2 块板子（Node B）上电，无需重烧即可自动接收 B 的 T_DATA / T_STAT 数据帧协同工作。
// ============================================================================
#include "radar_common.h"

static volatile bool gAck = false;
static volatile bool gRepFlag = false;
static volatile uint8_t gExpectSeq = 255;
static volatile uint16_t gExpectSweep = 0;
static RFrame gRep;
static volatile uint32_t gRepCb = 0;

static uint16_t gSweep = 0;
static uint8_t gHomeCh = HOME_CHANNEL;
static uint32_t gSweepsDone = 0;

static void onData(const uint8_t* d) {
  DFrame f;
  memcpy(&f, d, sizeof(f));
  bufAddEx(gBufB, 0, f.ch, f.seq, f.sweep, f.rssi, f.ts, f.aux, f.flags, f.csi);
  gDataRx = gDataRx + 1;
}

static void onRecv(const uint8_t* mac, const uint8_t* d, int len) {
  if (len < 2 || d[0] != RMAGIC) return;
  uint32_t cb = (uint32_t)esp_timer_get_time();
  uint8_t type = d[1];
  if (type == T_DATA) {
    if (len >= (int)sizeof(DFrame)) onData(d);
    return;
  }
  if (type == T_STAT) {
    if (len >= (int)sizeof(SFrame)) {
      portENTER_CRITICAL(&g_bufMux);
      memcpy(&gSt, d, sizeof(SFrame));
      gStMs = millis();
      portEXIT_CRITICAL(&g_bufMux);
      gStatRx = gStatRx + 1;
      if (!g_havePeer) { memcpy(g_peerMac, mac, 6); g_havePeer = true; }
    }
    return;
  }
  if (len < (int)sizeof(RFrame)) return;
  RFrame f;
  memcpy(&f, d, sizeof(f));
  if (f.type == T_ACK) {
    memcpy(g_peerMac, mac, 6);
    g_havePeer = true;
    gAck = true;
  } else if (f.type == T_REPLY && f.sweep == gExpectSweep && f.seq == gExpectSeq) {
    gRep = f;
    gRepCb = cb;
    gRepFlag = true;
  }
}

static void sendType(uint8_t type, uint16_t sweep, uint8_t chIdx, uint8_t ch, uint8_t home) {
  RFrame f;
  memset(&f, 0, sizeof(f));
  f.magic = RMAGIC; f.type = type; f.sweep = sweep; f.chIdx = chIdx; f.ch = ch; f.home = home;
  sendFrame(f);
}

static bool exchange(uint16_t sweep, uint8_t ch, uint8_t seq) {
  RFrame p;
  memset(&p, 0, sizeof(p));
  p.magic = RMAGIC; p.type = T_PROBE; p.sweep = sweep; p.ch = ch; p.seq = seq;
  gRepFlag = false;
  gExpectSeq = seq;
  gExpectSweep = sweep;
  uint32_t tx = (uint32_t)esp_timer_get_time();
  p.t1 = tx;
  sendFrame(p);
  gProbeTx++;
  uint32_t t0 = micros();
  while (!gRepFlag && micros() - t0 < 3500) delayMicroseconds(50);
  if (!gRepFlag) return false;
  gReplyRx++;
  CsiSlot s;
  if (!waitTakeCsi(gRepCb, &s, 2000)) return false;
  uint32_t rtt = (gRepCb - tx);
  uint32_t aux = rtt > gRep.t2 ? rtt - gRep.t2 : 0;
  bufAdd(gBufA, 1, ch, seq, sweep, s.rssi, s.hw_ts, aux, s.buf);
  gCsiPaired++;
  return true;
}

static void doSweep() {
  uint16_t sweep = ++gSweep;
  for (int i = 0; i < NPLAN; i++) {
    uint8_t ch = PLAN[i];
    uint32_t tc = millis();
    for (int r = 0; r < 3; r++) {
      sendType(T_HOP, sweep, (uint8_t)i, ch, gHomeCh);
      delay(2);
    }
    esp_wifi_set_channel(ch, WIFI_SECOND_CHAN_NONE);
    delay(3);
    uint32_t t0 = millis();
    for (int s = 0; s < EXCHANGES_PER_CH; s++) {
      exchange(sweep, ch, (uint8_t)s);
      uint32_t due = t0 + (uint32_t)(s + 1) * EXCH_GAP_MS;
      while ((int32_t)(millis() - due) < 0) delay(1);
    }
    while (millis() - tc < DWELL_MS) delay(1);
  }
  gSweepsDone++;
}

static void goHome() {
  stageSet(S_HOME);
  for (int r = 0; r < 3; r++) {
    sendType(T_HOME, gSweep, 0, gHomeCh, gHomeCh);
    delay(3);
  }
  esp_wifi_set_channel(gHomeCh, WIFI_SECOND_CHAN_NONE);
}

static bool syncWithB(uint32_t timeoutMs) {
  stageSet(S_SYNC);
  gAck = false;
  uint32_t t0 = millis();
  while (millis() - t0 < timeoutMs) {
    sendType(T_SYNC, gSweep, 0, gHomeCh, gHomeCh);
    for (int i = 0; i < 8 && !gAck; i++) delay(3);
    if (gAck) return true;
  }
  return false;
}

void setup() {
  bootInfoInit();
  serialBegin();
  delay(250);
  led(30, 30, 30);
  rlog("==== ESP32-S3 CSI Radar v%s (%s) ====", FW_VERSION, SINGLE_NODE_MODE ? "单节点零断连全能模式 · 1块ESP32-S3即可运行" : "双节点跳频模式");
  rlog("上次复位原因: %s | 复位前阶段: %s", rstName(g_rst), stageName(g_lastStage));
  bootIdInit();
  if (!bufInit(gBufA) || !bufInit(gBufB)) rlog("❌ 内存不足");
  rlog("缓冲 2×%u 条 · 空闲堆 %u 字节 · 主动探测 %d Hz", (unsigned)RECS_CAP, (unsigned)ESP.getFreeHeap(), (int)ACTIVE_PROBE_HZ);
  radioInit(onRecv);
  rlog("MAC = %s", WiFi.macAddress().c_str());
}

void loop() {
#if SINGLE_NODE_MODE
  // ★ 单节点零断连主循环：全程保持 WiFi 在线，连续采集高频 CSI 剖面并上传 Kaggle
  uint32_t t0 = millis();
  uint32_t p0 = gProbeTx, c0 = gCsiPaired;
  singleNodeCollectBatch(++gSweep, &gHomeCh);
  gSweepsDone++;
  uint32_t dt = millis() - t0;
  uint32_t px = gProbeTx - p0, cx = gCsiPaired - c0;
  rlog("[single] 轮号 %u | 用时 %lu ms | 主动脉冲 %lu | 捕获CSI %lu 条 | 辐射源 %u 个 | 待上传 %u 条 | 累计回调 %lu/%lu",
       (unsigned)gSweep, (unsigned long)dt, (unsigned long)px, (unsigned long)cx,
       (unsigned)g_macCount, (unsigned)gBufA.n, (unsigned long)g_csiKept, (unsigned long)g_csiSeen);
  homeUpload(&gHomeCh);
#else
  homeUpload(&gHomeCh);
  radioSweepMode(gHomeCh);
  led(30, 0, 30);
  rlog("[sync] 在信道 %d 等待 Node B …", gHomeCh);
  if (!syncWithB(SYNC_WAIT_MS)) {
    gSyncFail++;
    rlog("[sync] ⚠ 未检测到 Node B，自动切换单节点全能采集模式（确保 1 块 ESP32-S3 也能完整出图）");
    singleNodeCollectBatch(++gSweep, &gHomeCh);
    gSweepsDone++;
    return;
  }
  gSyncOk++;
  g_acceptAllCsi = false;
  led(0, 30, 30);
  rlog("[sync] ✅ Node B 已就绪，开始双节点跳频扫描");
  delay(25);
  stageSet(S_SWEEP);
  uint32_t t0 = millis();
  uint32_t p0 = gProbeTx, c0 = gCsiPaired, d0 = gDataRx;
  for (int s = 0; s < SWEEPS_PER_UPLOAD; s++) doSweep();
  goHome();
  uint32_t dt = millis() - t0;
  uint32_t px = gProbeTx - p0, cx = gCsiPaired - c0, dx = gDataRx - d0;
  rlog("[sweep] %d 轮 %lu ms | 探测 %lu 回复 %lu (%.0f%%) | B数据 %lu 条 | 待上传 A:%u B:%u | 轮号 %u",
       SWEEPS_PER_UPLOAD, (unsigned long)dt, (unsigned long)px, (unsigned long)cx,
       px ? 100.f * cx / px : 0.f, (unsigned long)dx, (unsigned)gBufA.n, (unsigned)gBufB.n, (unsigned)gSweep);
#endif
}
