// ============================================================================
//  Node A（网关 + 指挥）v10
//  循环：回路由器信道上传（A 自己的 H_BA + B 转来的 H_AB）→ 在会合信道广播 SYNC 等 B 的 ACK → 逐信道扫描
//        （每信道：广播 3 次 HOP 换台指令 → 自己换台 → 多次 PROBE/REPLY 双向交换）→ 广播 HOME 一起回家。
//  A 收到 B 的 REPLY 时得到 H_BA（dir=1，A 自己存）；B 收到 A 的 PROBE 时得到 H_AB，立刻用 T_DATA 单播发回 A（dir=0，A 替 B 上传）。
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

// 收到 B 发来的 H_AB：直接放进“B 的缓冲”，上传时当作 node=1
static void onData(const uint8_t* d) {
  DFrame f;
  memcpy(&f, d, sizeof(f));
  bufAdd(gBufB, 0, f.ch, f.seq, f.sweep, f.rssi, f.ts, f.aux, f.csi);
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

// 一次双向交换：A→B PROBE，B→A REPLY（+ B→A DATA）。成功返回 true 并记录 H_BA。
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
    for (int r = 0; r < 3; r++) {            // 3 次换台指令（ESP-NOW 广播无 ACK，靠重复提高到达率）
      sendType(T_HOP, sweep, (uint8_t)i, ch, gHomeCh);
      delay(2);
    }
    esp_wifi_set_channel(ch, WIFI_SECOND_CHAN_NONE);
    delay(3);                                 // 等 B 换完台、射频稳定
    uint32_t t0 = millis();
    for (int s = 0; s < EXCHANGES_PER_CH; s++) {
      exchange(sweep, ch, (uint8_t)s);
      uint32_t due = t0 + (uint32_t)(s + 1) * EXCH_GAP_MS;
      while ((int32_t)(millis() - due) < 0) delay(1);
    }
    while (millis() - tc < DWELL_MS) delay(1);   // 凑满最小停留时间
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
  delay(300);
  led(30, 30, 30);
  rlog("==== ESP32-S3 CSI Radar  Node A (网关+指挥)  fw %s ====", FW_VERSION);
  rlog("上次复位原因: %s | 复位前阶段: %s", rstName(g_rst), stageName(g_lastStage));
  rlog("信道计划: %d 个信道, 每信道 %d ms, 每信道 %d 次双向交换, 发射功率 %d dBm", NPLAN, DWELL_MS, EXCHANGES_PER_CH, (int)TX_POWER_DBM);
  bootIdInit();
  if (!bufInit(gBufA) || !bufInit(gBufB)) rlog("❌ 内存不足");
  rlog("缓冲 2×%u 条 · 空闲堆 %u 字节", (unsigned)RECS_CAP, (unsigned)ESP.getFreeHeap());
  radioInit(onRecv);
  rlog("MAC = %s", WiFi.macAddress().c_str());
}

void loop() {
  homeUpload(&gHomeCh);
  radioSweepMode(gHomeCh);
  led(30, 0, 30);   // 紫：等 Node B
  rlog("[sync] 在信道 %d 等待 Node B …", gHomeCh);
  if (!syncWithB(SYNC_WAIT_MS)) {
    gSyncFail++;
    rlog("[sync] ⚠ %d 秒没有收到 Node B 的 ACK（B 没上电 / 距离太远 / PAIR_MAGIC 不一致）累计失败 %u 次，收到 B 状态 %u 次", SYNC_WAIT_MS / 1000, (unsigned)gSyncFail, (unsigned)gStatRx);
    return;
  }
  gSyncOk++;
  led(0, 30, 30);   // 青：扫描中
  rlog("[sync] ✅ Node B 已就绪，开始扫描");
  delay(25);        // 给 B 发完 ACK 之后的状态帧留一点时间
  stageSet(S_SWEEP);
  uint32_t t0 = millis();
  uint32_t p0 = gProbeTx, c0 = gCsiPaired, d0 = gDataRx;
  for (int s = 0; s < SWEEPS_PER_UPLOAD; s++) doSweep();
  goHome();
  uint32_t dt = millis() - t0;
  uint32_t px = gProbeTx - p0, cx = gCsiPaired - c0, dx = gDataRx - d0;
  rlog("[sweep] %d 轮 %lu ms | 探测 %lu 回复成功 %lu (%.0f%%) | B 的数据 %lu 条 | 待上传 A:%u B:%u | 轮号 %u | CSI回调 %lu/%lu", SWEEPS_PER_UPLOAD,
       (unsigned long)dt, (unsigned long)px, (unsigned long)cx, px ? 100.f * cx / px : 0.f, (unsigned long)dx, (unsigned)gBufA.n, (unsigned)gBufB.n,
       (unsigned)gSweep, (unsigned long)g_csiKept, (unsigned long)g_csiSeen);
  if (px > 0 && cx == 0)
    rlog("[link] ⚠ 发了 %lu 个探测包但 B 一个回复都没有：B 没有跟上换台（距离/干扰）或 B 的 ESP-NOW 没起来", (unsigned long)px);
  else if (cx > 0 && dx == 0)
    rlog("[link] ⚠ 有回复但没收到 B 的 CSI 数据帧(T_DATA)：B 的 CSI 没触发（看 B 串口 [csi]）");
}
