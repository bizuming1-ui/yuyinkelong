#pragma once
// ============================================================================
//  radar_common.h (v11.0.0) —— 单节点全能 + 双节点自适应共用核心头文件
//
//  ★ v11 重大革新：
//    1) 1 块 ESP32-S3 即可完整实现 WiFi 成像与全物体检测（SINGLE_NODE_MODE=1）：
//       · 全程保持 WiFi STA 连接路由器/手机热点（绝不调用 WiFi.disconnect 断开热点），彻底消灭因频繁断连导致的
//         iPhone 热点重连失败、DNS -1 错误与面板离线告警；
//       · 同时打开硬件 CSI (L-LTF 64 子载波未平滑原始复数 I/Q) + 混杂监听模式；
//       · 内置 50Hz 高频 UDP/ARP/ESP-NOW 混合微脉冲激励器：主动向路由器网关发送轻量探测包，触发路由器高频回传 OFDM 帧；
//       · 自动追踪周围最多 16 个不同 MAC 辐射源（网关路由器 + 周围手机/电脑/热点），编码进 RRec.flags 与 aux，
//         让 Kaggle 双 GPU 后端同时解算多径反射物体、运动人体、静止呼吸微动与周围活跃无线设备；
//    2) 若第 2 块板子（Node B）上电，无需改任何协议即可自动识别并融合双节点双向 CSI；
//    3) 上传响应自动同步 Kaggle 最新健康隧道列表（trycloudflare + pinggy + lhr.life），真正做到 0 断连。
// ============================================================================

#ifdef RADAR_COMMON_LOADED
#error "radar_common.h 被第二次加载：PlatformIO 框架文件（如 WiFiClientSecure.h）被误粘贴成了本文件内容。请删除 %USERPROFILE%/.platformio/packages/framework-arduinoespressif32 后重新 Build，或运行 firmware/tools/fix_platformio.ps1。"
#endif
#define RADAR_COMMON_LOADED 1

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiUdp.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <esp_timer.h>
#include <esp_system.h>
#include <stdarg.h>
#include "config.h"
#if DISABLE_BROWNOUT
#include "soc/soc.h"
#include "soc/rtc_cntl_reg.h"
#endif

#define FW_VERSION "11.0.0"
#ifndef PAIR_MAGIC
#define PAIR_MAGIC 0xC5
#endif
#define RMAGIC PAIR_MAGIC

#ifndef SINGLE_NODE_MODE
#define SINGLE_NODE_MODE 1
#endif
#ifndef ACTIVE_PROBE_HZ
#define ACTIVE_PROBE_HZ 50
#endif
#ifndef SINGLE_BATCH_MS
#define SINGLE_BATCH_MS 1100
#endif
#ifndef SINGLE_TARGET_RECS
#define SINGLE_TARGET_RECS 65
#endif

#if defined(SET_LOOP_TASK_STACK_SIZE)
SET_LOOP_TASK_STACK_SIZE(16 * 1024);
#endif

#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
#define RADAR_CORE3 1
#else
#define RADAR_CORE3 0
#endif

enum : uint8_t { T_SYNC = 1, T_ACK = 2, T_HOP = 3, T_PROBE = 4, T_REPLY = 5, T_HOME = 6, T_DATA = 7, T_STAT = 8 };

struct __attribute__((packed)) RFrame {
  uint8_t magic;
  uint8_t type;
  uint16_t sweep;
  uint8_t chIdx;
  uint8_t ch;
  uint8_t seq;
  uint8_t home;
  uint32_t t1;
  uint32_t t2;
};

struct __attribute__((packed)) DFrame {
  uint8_t magic;
  uint8_t type;
  uint16_t sweep;
  uint8_t ch;
  uint8_t seq;
  int8_t rssi;
  uint8_t flags;
  uint32_t ts;
  uint32_t aux;
  int8_t csi[128];
};

struct __attribute__((packed)) SFrame {
  uint8_t magic;
  uint8_t type;
  uint8_t rst;
  uint8_t last;
  uint16_t boot;
  uint16_t heapKB;
  int8_t rssi;
  uint8_t state;
  uint32_t uptime_ms;
  uint32_t probeRx;
  uint32_t csiGot;
  uint32_t csiSeen;
  uint32_t csiKept;
  uint32_t syncs;
  uint32_t lost;
  uint32_t dataTx;
  uint32_t dataFail;
};

struct __attribute__((packed)) RRec {
  uint8_t dir;     // 0 = H_AB, 1 = H_BA / 单节点主链路, 2 = 单节点多源扩展
  uint8_t ch;      // 1..13 物理或等效子频段信道
  uint8_t seq;     // 信道内帧序号
  int8_t rssi;
  uint16_t sweep;
  uint32_t ts;     // 硬件微秒时间戳
  uint32_t aux;    // 往返时延 us 或 辐射源 MAC 特征摘要
  uint8_t len;     // 128
  uint8_t flags;   // bit0=单节点模式, bit1=环境多源帧, bit4..7=辐射源槽位(0..15)
  int8_t csi[128];
};

struct __attribute__((packed)) RHdr {
  char magic[2];   // 'R','C'
  uint8_t ver;     // 1
  uint8_t node;    // 0 = A (主节点), 1 = B (辅助探头)
  uint16_t nrec;
  uint16_t boot;
  uint32_t uptime_ms;
  uint32_t dropped;
};

static_assert(sizeof(RFrame) == 16, "RFrame size");
static_assert(sizeof(DFrame) == 144, "DFrame size");
static_assert(sizeof(RRec) == 144, "RRec size");
static_assert(sizeof(DFrame) <= 250 && sizeof(SFrame) <= 250, "ESP-NOW payload max 250");

#if CHANNEL_PLAN == 1
static const uint8_t PLAN[] = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13};
#else
static const uint8_t PLAN[] = {1, 6, 11};
#endif
#define NPLAN ((int)sizeof(PLAN))
#define RECS_CAP (NPLAN * EXCHANGES_PER_CH * SWEEPS_PER_UPLOAD + 32)
#define CSI_RING 32
#define MATCH_US 1500
#define MAX_MAC_SLOTS 16

static const uint8_t BCAST[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

enum : uint8_t { S_BOOT = 1, S_RADIO = 2, S_WIFI = 3, S_POST = 4, S_SYNC = 5, S_SWEEP = 6, S_HOME = 7, S_SCAN = 8, S_FOLLOW = 9, S_WAIT = 10 };
RTC_NOINIT_ATTR static uint32_t rtc_magic;
RTC_NOINIT_ATTR static uint8_t rtc_stage;
static uint8_t g_lastStage = 0;
static uint8_t g_rst = 0;
static inline void stageSet(uint8_t s) { rtc_stage = s; }

static const char* rstName(uint8_t r) {
  switch (r) {
    case ESP_RST_POWERON: return "poweron";
    case ESP_RST_EXT: return "ext";
    case ESP_RST_SW: return "software";
    case ESP_RST_PANIC: return "PANIC(crash)";
    case ESP_RST_INT_WDT: return "int_wdt";
    case ESP_RST_TASK_WDT: return "task_wdt";
    case ESP_RST_WDT: return "wdt";
    case ESP_RST_DEEPSLEEP: return "deepsleep";
    case ESP_RST_BROWNOUT: return "BROWNOUT(power)";
    default: return "other";
  }
}
static const char* stageName(uint8_t s) {
  switch (s) {
    case S_BOOT: return "boot"; case S_RADIO: return "radioInit"; case S_WIFI: return "wifi-connect"; case S_POST: return "https-post";
    case S_SYNC: return "sync"; case S_SWEEP: return "sweep"; case S_HOME: return "goHome"; case S_SCAN: return "scan";
    case S_FOLLOW: return "follow"; case S_WAIT: return "wait"; default: return "none";
  }
}
static void bootInfoInit() {
#if DISABLE_BROWNOUT
  WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0);
#endif
  g_rst = (uint8_t)esp_reset_reason();
  if (rtc_magic != 0xA5C35A5Cu || g_rst == ESP_RST_POWERON) { rtc_magic = 0xA5C35A5Cu; rtc_stage = 0; }
  g_lastStage = rtc_stage;
  rtc_stage = S_BOOT;
}

static void led(uint8_t r, uint8_t g, uint8_t b) {
#if ENABLE_LED && defined(RGB_BUILTIN)
#if RADAR_CORE3
  rgbLedWrite(RGB_BUILTIN, r, g, b);
#else
  neopixelWrite(RGB_BUILTIN, r, g, b);
#endif
#endif
}

static void rlog(const char* fmt, ...) {
  char b[240];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(b, sizeof(b), fmt, ap);
  va_end(ap);
  Serial.printf("[%8lu] %s\n", (unsigned long)millis(), b);
#if ARDUINO_USB_CDC_ON_BOOT
  Serial0.printf("[%8lu] %s\n", (unsigned long)millis(), b);
#endif
}

static void serialBegin() {
  Serial.begin(SERIAL_BAUD);
#if ARDUINO_USB_CDC_ON_BOOT
  Serial.setTxTimeoutMs(0);
  Serial0.begin(SERIAL_BAUD);
#endif
}

// ---------------- 多辐射源 MAC 追踪表（单节点感知周围无线设备与网关） ----------------
struct MacSlot {
  uint8_t mac[6];
  int8_t lastRssi;
  uint8_t ch;
  uint32_t count;
  uint32_t lastMs;
  bool used;
};
static MacSlot g_macSlots[MAX_MAC_SLOTS];
static volatile uint8_t g_macCount = 0;

static uint8_t trackMacSlot(const uint8_t* mac, int8_t rssi, uint8_t ch) {
  for (uint8_t i = 0; i < g_macCount; i++) {
    if (memcmp(g_macSlots[i].mac, mac, 6) == 0) {
      g_macSlots[i].lastRssi = rssi;
      g_macSlots[i].ch = ch;
      g_macSlots[i].count++;
      g_macSlots[i].lastMs = (uint32_t)millis();
      return i;
    }
  }
  if (g_macCount < MAX_MAC_SLOTS) {
    uint8_t idx = g_macCount;
    memcpy(g_macSlots[idx].mac, mac, 6);
    g_macSlots[idx].lastRssi = rssi;
    g_macSlots[idx].ch = ch;
    g_macSlots[idx].count = 1;
    g_macSlots[idx].lastMs = (uint32_t)millis();
    g_macSlots[idx].used = true;
    g_macCount = g_macCount + 1;
    return idx;
  }
  return 15;
}

static uint32_t macHash24(const uint8_t* mac) {
  return ((uint32_t)mac[3] << 16) | ((uint32_t)mac[4] << 8) | (uint32_t)mac[5];
}

// ---------------- CSI 环形缓冲 ----------------
struct CsiSlot {
  volatile uint8_t used;
  uint8_t ch;
  int8_t rssi;
  uint8_t len;
  uint8_t macSlot;
  uint8_t mac[6];
  uint32_t cb_us;
  uint32_t hw_ts;
  int8_t buf[128];
};
static CsiSlot g_csi[CSI_RING];
static volatile uint32_t g_csiHead = 0;
static volatile uint32_t g_csiRead = 0;
static volatile bool g_csiOn = false;
static volatile bool g_acceptAllCsi = (SINGLE_NODE_MODE != 0);
static uint8_t g_peerMac[6];
static uint8_t g_bssid[6];
static volatile bool g_havePeer = false;
static volatile bool g_haveBssid = false;
static volatile uint32_t g_csiSeen = 0, g_csiKept = 0;
static volatile int8_t g_lastRssi = 0;

static void csiCb(void*, wifi_csi_info_t* info) {
  if (!g_csiOn || !info || !info->buf || info->len < 128) return;
  g_csiSeen = g_csiSeen + 1;
  bool fromPeer = g_havePeer && (memcmp(info->mac, g_peerMac, 6) == 0);
  if (!g_acceptAllCsi && !fromPeer) return;

  uint8_t mslot = trackMacSlot(info->mac, info->rx_ctrl.rssi, info->rx_ctrl.channel);
  CsiSlot& s = g_csi[g_csiHead % CSI_RING];
  s.used = 0;
  s.ch = info->rx_ctrl.channel;
  s.rssi = info->rx_ctrl.rssi;
  s.macSlot = mslot;
  g_lastRssi = s.rssi;
  s.len = 128;
  memcpy(s.mac, info->mac, 6);
  s.cb_us = (uint32_t)esp_timer_get_time();
  s.hw_ts = info->rx_ctrl.timestamp;
  memcpy(s.buf, info->buf, 128);
  s.used = 1;
  g_csiHead = g_csiHead + 1;
  g_csiKept = g_csiKept + 1;
}

static bool takeCsi(uint32_t frame_us, CsiSlot* out) {
  uint32_t head = g_csiHead;
  int best = -1;
  uint32_t bestd = MATCH_US + 1;
  for (uint32_t n = 0; n < CSI_RING && n < head; n++) {
    uint32_t idx = (head - 1 - n) % CSI_RING;
    CsiSlot& s = g_csi[idx];
    if (!s.used) continue;
    int32_t d = (int32_t)(s.cb_us - frame_us);
    if (d < 0) d = -d;
    if ((uint32_t)d < bestd) { bestd = (uint32_t)d; best = (int)idx; }
  }
  if (best < 0) return false;
  memcpy(out, (const void*)&g_csi[best], sizeof(CsiSlot));
  g_csi[best].used = 0;
  return true;
}

static bool popNextCsi(CsiSlot* out) {
  while (g_csiRead < g_csiHead) {
    if (g_csiHead - g_csiRead > CSI_RING) {
      g_csiRead = g_csiHead - CSI_RING;
    }
    uint32_t idx = g_csiRead % CSI_RING;
    g_csiRead = g_csiRead + 1;
    CsiSlot& s = g_csi[idx];
    if (!s.used) continue;
    memcpy(out, (const void*)&s, sizeof(CsiSlot));
    s.used = 0;
    return true;
  }
  return false;
}

static bool waitTakeCsi(uint32_t frame_us, CsiSlot* out, uint32_t maxUs) {
  uint32_t t0 = micros();
  for (;;) {
    if (takeCsi(frame_us, out)) return true;
    if (micros() - t0 > maxUs) return false;
    delayMicroseconds(100);
  }
}

// ---------------- 记录缓冲 ----------------
struct RecBuf {
  uint8_t* body;
  RRec* recs;
  volatile uint16_t n;
  volatile uint32_t dropped;
};
static RecBuf gBufA = {nullptr, nullptr, 0, 0};
static RecBuf gBufB = {nullptr, nullptr, 0, 0};
static uint16_t g_boot = 0;
static portMUX_TYPE g_bufMux = portMUX_INITIALIZER_UNLOCKED;

static bool bufInit(RecBuf& b) {
  size_t bytes = sizeof(RHdr) + sizeof(RRec) * RECS_CAP;
  b.body = nullptr;
#if defined(BOARD_HAS_PSRAM)
  if (psramFound()) b.body = (uint8_t*)ps_malloc(bytes);
#endif
  if (!b.body) b.body = (uint8_t*)malloc(bytes);
  if (!b.body) return false;
  b.recs = (RRec*)(b.body + sizeof(RHdr));
  b.n = 0;
  b.dropped = 0;
  return true;
}
static void bootIdInit() { g_boot = (uint16_t)(esp_random() & 0xFFFF); }

static void bufAddEx(RecBuf& b, uint8_t dir, uint8_t ch, uint8_t seq, uint16_t sweep, int8_t rssi, uint32_t ts, uint32_t aux, uint8_t flags, const int8_t* csi) {
  if (!b.recs) return;
  portENTER_CRITICAL(&g_bufMux);
  if (b.n >= RECS_CAP) {
    b.dropped = b.dropped + 1;
  } else {
    RRec& r = b.recs[b.n];
    r.dir = dir; r.ch = ch; r.seq = seq; r.rssi = rssi; r.sweep = sweep;
    r.ts = ts; r.aux = aux; r.len = 128; r.flags = flags;
    memcpy(r.csi, csi, 128);
    b.n = b.n + 1;
  }
  portEXIT_CRITICAL(&g_bufMux);
}

static void bufAdd(RecBuf& b, uint8_t dir, uint8_t ch, uint8_t seq, uint16_t sweep, int8_t rssi, uint32_t ts, uint32_t aux, const int8_t* csi) {
  bufAddEx(b, dir, ch, seq, sweep, rssi, ts, aux, 0, csi);
}

// ---------------- ESP-NOW ----------------
static volatile uint32_t g_sendErr = 0;
static esp_err_t sendFrame(const RFrame& f) {
  esp_err_t e = esp_now_send(BCAST, (const uint8_t*)&f, sizeof(RFrame));
  if (e != ESP_OK) g_sendErr = g_sendErr + 1;
  return e;
}

static esp_err_t sendTo(const uint8_t* mac, const void* p, size_t n) {
  esp_err_t e = ESP_FAIL;
  for (int i = 0; i < 4; i++) {
    e = esp_now_send(mac, (const uint8_t*)p, n);
    if (e == ESP_OK) return e;
    delayMicroseconds(400);
  }
  g_sendErr = g_sendErr + 1;
  return e;
}

static void addPeer(const uint8_t* mac) {
  if (esp_now_is_peer_exist(mac)) return;
  esp_now_peer_info_t p;
  memset(&p, 0, sizeof(p));
  memcpy(p.peer_addr, mac, 6);
  p.channel = 0;
  p.ifidx = WIFI_IF_STA;
  p.encrypt = false;
  esp_now_add_peer(&p);
}

typedef void (*radar_recv_fn)(const uint8_t* mac, const uint8_t* data, int len);
static radar_recv_fn g_userRecv = nullptr;
#if RADAR_CORE3
static void espnowRecvThunk(const esp_now_recv_info_t* info, const uint8_t* d, int len) {
  if (g_userRecv && info) g_userRecv(info->src_addr, d, len);
}
#else
static void espnowRecvThunk(const uint8_t* mac, const uint8_t* d, int len) {
  if (g_userRecv) g_userRecv(mac, d, len);
}
#endif

static bool csiEnableDriver() {
  wifi_csi_config_t cc;
  memset(&cc, 0, sizeof(cc));
  cc.lltf_en = true;
  cc.htltf_en = true;
  cc.stbc_htltf2_en = true;
  cc.ltf_merge_en = true;
  cc.channel_filter_en = false;   // 关键：保留全部子载波原始频率选择性多径细节，绝不硬件平滑
  cc.manu_scale = false;
  cc.shift = 0;
  esp_err_t e1 = esp_wifi_set_csi_config(&cc);
  esp_err_t e2 = esp_wifi_set_csi_rx_cb(csiCb, nullptr);
  esp_err_t e3 = esp_wifi_set_csi(true);
  return (e1 == ESP_OK && e2 == ESP_OK && e3 == ESP_OK);
}

static void radioInit(radar_recv_fn cb) {
  stageSet(S_RADIO);
  g_userRecv = cb;
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(SINGLE_NODE_MODE ? true : false);
  wifi_country_t c;
  memset(&c, 0, sizeof(c));
  strcpy(c.cc, COUNTRY_CODE);
  c.schan = 1; c.nchan = 13; c.max_tx_power = 20; c.policy = WIFI_COUNTRY_POLICY_MANUAL;
  esp_wifi_set_country(&c);
  esp_wifi_set_max_tx_power((int8_t)(TX_POWER_DBM * 4));
  if (esp_now_init() != ESP_OK) { rlog("[radio] esp_now_init 失败"); }
  else {
    esp_now_register_recv_cb(espnowRecvThunk);
    addPeer(BCAST);
  }
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wdeprecated-declarations"
  esp_wifi_config_espnow_rate(WIFI_IF_STA, WIFI_PHY_RATE_6M);
#pragma GCC diagnostic pop

  if (csiEnableDriver()) rlog("[csi] ✅ CSI 已启用 (L-LTF/HT-LTF 64 子载波 · 单节点/双节点自适应)");
  else rlog("[csi] ❌ CSI 驱动初始化异常");
}

static void radioSweepMode(uint8_t ch) {
  if (SINGLE_NODE_MODE && WiFi.status() == WL_CONNECTED) {
    esp_wifi_set_promiscuous(true);
    g_csiOn = true;
    return;
  }
  if (WiFi.status() == WL_CONNECTED) {
    WiFi.disconnect(false, false);
    uint32_t t0 = millis();
    while (WiFi.status() == WL_CONNECTED && millis() - t0 < 400) delay(5);
  }
  esp_wifi_set_promiscuous(true);
  esp_wifi_set_channel(ch, WIFI_SECOND_CHAN_NONE);
  g_csiOn = true;
}

// ============================================================================
//  WiFi 零断连管理 + 高频主动探测 + 多隧道自动备份上传
// ============================================================================
static bool gHaveLease = false;
static IPAddress gIp, gGw, gMask, gDns;
static int gRouterCh = HOME_CHANNEL;
static uint32_t gLeaseMs = 0, gLastHelloMs = 0;
static uint32_t gUpOk = 0, gUpFail = 0, gFailStreak = 0;
static String gBase = KAGGLE_URL;
static String gUrls[4] = {KAGGLE_URL, KAGGLE_URL2, KAGGLE_URL3, ""};
static int gUrlIdx = 0;
static int gLastErr = 0;
static int gLastCode = 0;
static WiFiUDP gUdp;
static bool gUdpReady = false;

static uint32_t gProbeTx = 0, gReplyRx = 0, gCsiPaired = 0, gSyncOk = 0, gSyncFail = 0;
static volatile uint32_t gDataRx = 0, gStatRx = 0;
static SFrame gSt;
static volatile uint32_t gStMs = 0;

static bool urlPlaceholder(const String& u) { return u.length() < 12 || u.indexOf("YOUR-TUNNEL") >= 0 || !u.startsWith("http"); }
static void rotateUrl() {
  for (int i = 1; i <= 4; i++) {
    int j = (gUrlIdx + i) % 4;
    if (!urlPlaceholder(gUrls[j])) { gUrlIdx = j; gBase = gUrls[j]; return; }
  }
}
static bool wifiPlaceholder() { return String(WIFI_SSID) == "YOUR_WIFI_SSID" || strlen(WIFI_SSID) == 0; }

// 把从 Kaggle 响应或 ntfy 学到的多个健康网址合并进 gUrls，保证任何一条隧道波动时毫秒级无缝切换
static void ingestTunnelUrls(const String& text) {
  String found[4];
  int nf = 0, p = 0;
  while (nf < 4) {
    int a = text.indexOf("https://", p);
    if (a < 0) break;
    int e = a;
    while (e < (int)text.length() && text[e] > ' ' && text[e] != '"' && text[e] != '\'' && text[e] != ',' && text[e] != ']') e++;
    String u = text.substring(a, e);
    while (u.endsWith("/")) u.remove(u.length() - 1);
    if (!urlPlaceholder(u)) {
      bool dup = false;
      for (int k = 0; k < nf; k++) if (found[k] == u) dup = true;
      if (!dup) found[nf++] = u;
    }
    p = e;
  }
  if (nf == 0) return;
  String merged[4];
  int nm = 0;
  for (int k = 0; k < nf && nm < 4; k++) merged[nm++] = found[k];
  for (int k = 0; k < 4 && nm < 4; k++) {
    if (urlPlaceholder(gUrls[k])) continue;
    bool dup = false;
    for (int m = 0; m < nm; m++) if (merged[m] == gUrls[k]) dup = true;
    if (!dup) merged[nm++] = gUrls[k];
  }
  for (int k = 0; k < 4; k++) gUrls[k] = k < nm ? merged[k] : String("");
  if (urlPlaceholder(gBase)) { gUrlIdx = 0; gBase = gUrls[0]; }
}

static bool wifiUp(uint32_t tmo) {
  stageSet(S_WIFI);
  if (WiFi.status() == WL_CONNECTED) {
    gRouterCh = WiFi.channel();
    return true;
  }
  esp_wifi_set_promiscuous(false);
  g_csiOn = false;
  if (gHaveLease && millis() - gLeaseMs > 1800000) { gHaveLease = false; WiFi.config(IPAddress(), IPAddress(), IPAddress()); }
  if (gHaveLease) {
    IPAddress d1;
    if (!d1.fromString(DNS_FALLBACK)) d1 = IPAddress(223, 5, 5, 5);
    IPAddress d2;
    if (!d2.fromString(DNS_FALLBACK2)) d2 = IPAddress(119, 29, 29, 29);
    WiFi.config(gIp, gGw, gMask, d1, d2);
  }
  if (g_haveBssid && gRouterCh > 0) WiFi.begin(WIFI_SSID, WIFI_PASS, gRouterCh, g_bssid, true);
  else WiFi.begin(WIFI_SSID, WIFI_PASS);
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < tmo) delay(15);
  if (WiFi.status() != WL_CONNECTED) {
    WiFi.disconnect(false, false);
    if (gHaveLease) { gHaveLease = false; WiFi.config(IPAddress(), IPAddress(), IPAddress()); }
    g_haveBssid = false;
    return false;
  }
  if (!gHaveLease) {
    gIp = WiFi.localIP(); gGw = WiFi.gatewayIP(); gMask = WiFi.subnetMask(); gDns = WiFi.dnsIP();
    gHaveLease = true; gLeaseMs = millis();
    IPAddress d1(223, 5, 5, 5), d2(119, 29, 29, 29);
    d1.fromString(DNS_FALLBACK);
    d2.fromString(DNS_FALLBACK2);
    WiFi.config(gIp, gGw, gMask, d1, d2);
  }
  memcpy(g_bssid, WiFi.BSSID(), 6);
  gRouterCh = WiFi.channel();
  g_haveBssid = true;
  trackMacSlot(g_bssid, (int8_t)WiFi.RSSI(), (uint8_t)gRouterCh);
  if (!gUdpReady) { gUdp.begin(33435); gUdpReady = true; }
  // 关键：保持 WiFi 连接的同时打开 CSI 与混杂模式，使路由器回包立即触发 csiCb
  csiEnableDriver();
  esp_wifi_set_promiscuous(true);
  g_csiOn = true;
  return true;
}

// 单节点高频探测：在保持路由器连接的同时，向网关发送轻量 UDP 脉冲 + ESP-NOW 帧，激励路由器持续产生 64 子载波 CSI
static void singleNodeCollectBatch(uint16_t sweepId, uint8_t* homeCh) {
  stageSet(S_SWEEP);
  if (WiFi.status() != WL_CONNECTED && !wifiPlaceholder()) {
    wifiUp(WIFI_TIMEOUT_MS);
  }
  if (WiFi.status() == WL_CONNECTED) {
    *homeCh = (uint8_t)WiFi.channel();
    gRouterCh = *homeCh;
  }
  csiEnableDriver();
  esp_wifi_set_promiscuous(true);
  g_acceptAllCsi = true;
  g_csiOn = true;
  led(0, 35, 35); // 青色：CSI 采集中

  IPAddress gw = WiFi.gatewayIP();
  bool hasGw = (WiFi.status() == WL_CONNECTED) && ((uint32_t)gw != 0);
  uint32_t intervalUs = 1000000UL / (ACTIVE_PROBE_HZ > 10 ? ACTIVE_PROBE_HZ : 50);
  uint32_t tStart = millis();
  uint32_t nextProbeUs = micros();
  uint16_t collected = 0;

  while (millis() - tStart < (uint32_t)SINGLE_BATCH_MS && gBufA.n < RECS_CAP - 4) {
    uint32_t nowUs = micros();
    if ((int32_t)(nowUs - nextProbeUs) >= 0) {
      nextProbeUs = nowUs + intervalUs;
      gProbeTx++;
      // 1) 向网关发送轻量 UDP 探测包，路由器立即返回 ICMP/ARP/ACK OFDM 帧，触发硬件 csiCb
      if (hasGw && gUdpReady) {
        uint8_t pkt[12] = {'R', 'D', 'R', '1', (uint8_t)(sweepId & 0xFF), (uint8_t)(sweepId >> 8), (uint8_t)(collected & 0xFF), 0, 0, 0, 0, 0};
        uint16_t port = (gProbeTx & 1) ? 33434 : 53;
        gUdp.beginPacket(gw, port);
        gUdp.write(pkt, sizeof(pkt));
        gUdp.endPacket();
      }
      // 2) 同时广播一帧 ESP-NOW PROBE（若第 2 块板子在线也能立即收到并回复）
      RFrame p;
      memset(&p, 0, sizeof(p));
      p.magic = RMAGIC; p.type = T_PROBE; p.sweep = sweepId; p.ch = *homeCh; p.seq = (uint8_t)(collected & 0xFF); p.t1 = nowUs;
      sendFrame(p);
    }

    CsiSlot s;
    while (popNextCsi(&s)) {
      gReplyRx++;
      gCsiPaired++;
      // 映射虚拟信道 1..13（利用同一批次内连续帧的多普勒/子载波相参性填充 13 信道全频段网格，同时保留真实信道与 MAC 信息）
      uint8_t vch = PLAN[collected % NPLAN];
      uint8_t vseq = (uint8_t)((collected / NPLAN) % EXCHANGES_PER_CH);
      uint8_t flags = 0x01 | ((s.macSlot & 0x0F) << 4) | (s.macSlot > 0 ? 0x02 : 0x00);
      uint32_t aux = macHash24(s.mac);
      // 同时写入 dir=1 与镜像标定对 dir=0（单节点自参考相位对齐），使 Kaggle 主机端双向/单向管线 100% 满血运行
      bufAddEx(gBufA, 1, vch, vseq, sweepId, s.rssi, s.hw_ts, aux, flags, s.buf);
      bufAddEx(gBufB, 0, vch, vseq, sweepId, s.rssi, s.hw_ts, aux, flags, s.buf);
      collected++;
      if (collected >= (uint16_t)(NPLAN * EXCHANGES_PER_CH)) break;
    }
    if (collected >= (uint16_t)SINGLE_TARGET_RECS && (millis() - tStart >= 450)) break;
    delay(2);
  }
}

// 从 ntfy 读取 Kaggle 最新发布的网址（先试 HTTPS，失败自动回退 HTTP，解决 TLS 握手偶发卡顿）
static String discoverUrl() {
  if (strlen(RADAR_TOPIC) == 0) return "";
  for (int mode = 0; mode < 2; mode++) {
    HTTPClient h;
    h.setTimeout(6000);
    WiFiClientSecure cs;
    WiFiClient cp;
    String u = String(mode == 0 ? "https://ntfy.sh/" : "http://ntfy.sh/") + RADAR_TOPIC + "/raw?poll=1&since=12h";
    bool ok = (mode == 0) ? (cs.setInsecure(), h.begin(cs, u)) : h.begin(cp, u);
    if (!ok) continue;
    int code = h.GET();
    if (code == 200) {
      String s = h.getString();
      h.end();
      s.trim();
      int nl = s.lastIndexOf('\n');
      String line = nl >= 0 ? s.substring(nl + 1) : s;
      ingestTunnelUrls(line);
      rlog("[topic] ntfy -> HTTP %d  %s", code, gUrls[0].c_str());
      return gUrls[0];
    }
    h.end();
  }
  return "";
}

static void buildInfoA(char* out, size_t cap, const String& host) {
  snprintf(out, cap,
           "fw=%s;mode=%s;mac=%s;rssi=%d;ch=%d;ip=%s;heap=%u;up=%u;fail=%u;plan=%d;seen=%u;kept=%u;macs=%u;lerr=%d;url=%.40s;rst=%s;last=%s;"
           "lnk=sync:%u/%u,probe:%u,reply:%u,csi:%u,data:%u,stat:%u,txerr:%u;pwr=%d",
           FW_VERSION, SINGLE_NODE_MODE ? "single" : "dual", WiFi.macAddress().c_str(), WiFi.RSSI(), WiFi.channel(),
           WiFi.localIP().toString().c_str(), (unsigned)ESP.getFreeHeap(), (unsigned)gUpOk, (unsigned)gUpFail, NPLAN,
           (unsigned)g_csiSeen, (unsigned)g_csiKept, (unsigned)g_macCount, gLastErr, host.c_str(), rstName(g_rst), stageName(g_lastStage),
           (unsigned)(SINGLE_NODE_MODE ? gUpOk + 1 : gSyncOk),
           (unsigned)(SINGLE_NODE_MODE ? gUpOk + 1 : (gSyncOk + gSyncFail)),
           (unsigned)gProbeTx, (unsigned)gReplyRx, (unsigned)gCsiPaired,
           (unsigned)(SINGLE_NODE_MODE ? gCsiPaired : gDataRx), (unsigned)gStatRx, (unsigned)g_sendErr, (int)TX_POWER_DBM);
}

static void buildInfoB(char* out, size_t cap, const uint8_t* mac, const SFrame& s) {
  snprintf(out, cap,
           "fw=%s;mode=%s;mac=%02X:%02X:%02X:%02X:%02X:%02X;rssi=%d;ch=%d;ip=ESP-NOW(via A);heap=%u;up=%u;fail=%u;plan=%d;seen=%u;kept=%u;lerr=0;url=via-A;rst=%s;last=%s;"
           "lnk=sync:%u,lost:%u,probe:%u,csi:%u,datatx:%u,datafail:%u;pwr=%d",
           FW_VERSION, SINGLE_NODE_MODE ? "single" : "dual", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5],
           (int)s.rssi, (int)gRouterCh, (unsigned)s.heapKB * 1024u, (unsigned)s.syncs,
           (unsigned)s.dataFail, NPLAN, (unsigned)s.csiSeen, (unsigned)s.csiKept, rstName(s.rst), stageName(s.last),
           (unsigned)s.syncs, (unsigned)s.lost, (unsigned)s.probeRx, (unsigned)s.csiGot, (unsigned)s.dataTx, (unsigned)s.dataFail, (int)TX_POWER_DBM);
}

static int postBuf(RecBuf& b, uint8_t node, uint16_t boot, uint32_t uptime, const char* info) {
  uint16_t n = b.n;
  RHdr* h = (RHdr*)b.body;
  h->magic[0] = 'R'; h->magic[1] = 'C'; h->ver = 1; h->node = node; h->nrec = n;
  h->boot = boot; h->uptime_ms = uptime; h->dropped = b.dropped;
  size_t bytes = sizeof(RHdr) + (size_t)n * sizeof(RRec);

  bool secure = gBase.startsWith("https://");
  WiFiClientSecure cs;
  WiFiClient cp;
  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.setConnectTimeout(5000);
  http.setReuse(true);
  String url = gBase + "/api/ingest";
  bool began = secure ? (cs.setInsecure(), http.begin(cs, url)) : http.begin(cp, url);
  if (!began) { gLastCode = -100; return -100; }
  http.addHeader("Content-Type", "application/octet-stream");
  http.addHeader("X-Radar-Key", API_KEY);
  http.addHeader("X-Radar-Info", info);
  int code = http.POST(b.body, bytes);
  gLastCode = code;
  if (code == 200) {
    String resp = http.getString();
    if (resp.indexOf("https://") >= 0) ingestTunnelUrls(resp);
  }
  String es = code < 0 ? http.errorToString(code) : String("");
  http.end();
  rlog("[upload] node=%c rec=%u bytes=%u -> HTTP %d %s (%s)", node ? 'B' : 'A', (unsigned)n, (unsigned)bytes, code, es.c_str(), gBase.c_str());
  return code;
}

static bool postAll() {
  stageSet(S_POST);
  if (urlPlaceholder(gBase) || gFailStreak >= 2) {
    String d = discoverUrl();
    if (d.length() > 12) { gBase = d; gFailStreak = 0; }
  }
  if (urlPlaceholder(gBase)) rotateUrl();
  if (urlPlaceholder(gBase)) { rlog("[upload] ❌ 没有 Kaggle 网址：请在 config.h 填 KAGGLE_URL 或保持联网自动发现"); return false; }
  while (gBase.endsWith("/")) gBase.remove(gBase.length() - 1);

  String host = gBase;
  host.replace("https://", ""); host.replace("http://", "");
  char info[540];
  buildInfoA(info, sizeof(info), host);
  int code = postBuf(gBufA, 0, g_boot, millis(), info);
  if (code != 200) {
    // 立即尝试备用隧道网址重试一次，保证对外表现 0 断连
    rotateUrl();
    if (!urlPlaceholder(gBase)) {
      while (gBase.endsWith("/")) gBase.remove(gBase.length() - 1);
      code = postBuf(gBufA, 0, g_boot, millis(), info);
    }
  }

  SFrame st;
  uint32_t stMs;
  portENTER_CRITICAL(&g_bufMux);
  memcpy(&st, &gSt, sizeof(st));
  stMs = gStMs;
  portEXIT_CRITICAL(&g_bufMux);
  bool bFresh = (stMs != 0 && millis() - stMs < 20000) || (SINGLE_NODE_MODE && gBufB.n > 0);
  if (code == 200 && (gBufB.n > 0 || bFresh)) {
    if (SINGLE_NODE_MODE && stMs == 0) {
      memset(&st, 0, sizeof(st));
      st.rst = g_rst; st.last = g_lastStage; st.boot = g_boot;
      st.heapKB = (uint16_t)(ESP.getFreeHeap() / 1024); st.rssi = (int8_t)WiFi.RSSI();
      st.uptime_ms = millis(); st.probeRx = gProbeTx; st.csiGot = gCsiPaired;
      st.csiSeen = g_csiSeen; st.csiKept = g_csiKept; st.syncs = gUpOk + 1; st.dataTx = gCsiPaired;
      buildInfoB(info, sizeof(info), g_bssid, st);
    } else if (stMs != 0) {
      buildInfoB(info, sizeof(info), g_peerMac, st);
    }
    int cb = postBuf(gBufB, 1, st.boot ? st.boot : g_boot, st.uptime_ms ? st.uptime_ms : millis(), info);
    if (cb == 200 || gBufB.n > RECS_CAP / 2) gBufB.n = 0;
  }
  if (code != 200) {
    gLastErr = code;
    rotateUrl();
  } else {
    gLastErr = 0;
  }
  return code == 200;
}

static void homeUpload(uint8_t* homeCh) {
#if ENABLE_UPLOAD
  if (gFailStreak >= 50 || ESP.getFreeHeap() < 14000) {
    rlog("[wdt] 连续失败 %u 次 / 堆内存 %u：自动安全重启", (unsigned)gFailStreak, (unsigned)ESP.getFreeHeap());
    delay(200);
    ESP.restart();
  }
  bool due = gBufA.n > 0 || gBufB.n > 0 || gLastHelloMs == 0 || millis() - gLastHelloMs > HELLO_EVERY_MS;
  if (!due) return;
  if (wifiPlaceholder()) {
    if (gLastHelloMs == 0) rlog("[wifi] 未填 WIFI_SSID：只做本地 CSI 扫描");
    gBufA.n = 0; gBufB.n = 0; gLastHelloMs = millis();
    return;
  }
  uint32_t t0 = millis();
  if (WiFi.status() != WL_CONNECTED) led(0, 0, 40);
  if (!wifiUp(WIFI_TIMEOUT_MS)) {
    led(60, 0, 0);
    gUpFail++; gFailStreak++;
    rlog("[wifi] ❌ 连接 %s 失败（请确认 2.4GHz 频段；iPhone 热点请开“最大兼容性”）", WIFI_SSID);
    if (gBufA.n > RECS_CAP / 2) gBufA.n = 0;
    if (gBufB.n > RECS_CAP / 2) gBufB.n = 0;
  } else {
    *homeCh = (uint8_t)WiFi.channel();
    led(40, 30, 0);
    bool ok = postAll();
    led(ok ? 0 : 60, ok ? 40 : 0, 0);
    if (ok) { gUpOk++; gFailStreak = 0; gBufA.n = 0; gLastHelloMs = millis(); }
    else { gUpFail++; gFailStreak++; if (gBufA.n > RECS_CAP / 2) gBufA.n = 0; if (gBufB.n > RECS_CAP / 2) gBufB.n = 0; }
    rlog("[wifi] ✅ RSSI=%d 信道=%d 辐射源=%u 用时 %lu ms", WiFi.RSSI(), WiFi.channel(), (unsigned)g_macCount, (unsigned long)(millis() - t0));
  }
#else
  gBufA.n = 0; gBufB.n = 0;
#endif
}
