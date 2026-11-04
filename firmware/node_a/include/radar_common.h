#pragma once
// ============================================================================
//  radar_common.h  (v10)  —— Node A / Node B 共用（两个工程里这个文件内容完全相同）
//
//  v10 架构：A = 网关 + 指挥（连路由器、HTTPS 上传、发起跳频）；B = 纯射频探头（只用 ESP-NOW，不连路由器、不做 TLS）。
//    · A→B 探测包让 B 得到 H_AB；B 把这份 CSI 用 ESP-NOW 单播(T_DATA, 有 MAC 层 ACK+重传)直接发回 A。
//    · B→A 回复包让 A 得到 H_BA。A 把“自己的 H_BA”和“B 发来的 H_AB”分两次 POST 给 Kaggle（node=0 / node=1），
//      Kaggle 主机端协议完全不变。
//    · 好处：B 不再需要和 A 在“上传时间窗”上碰运气（v9 的会合失败/反复重启根因之一）；B 没有 TLS，供电峰值小；
//      只有 A 需要 WiFi 密码；B 随时掉线随时自动重新找 A（扫 1..13 信道）。
//  CSI 只取 L-LTF（64 子载波，128 字节 int8：每子载波 [imag, real]）。
// ============================================================================
// ---- 自检：如果下面这行 #error 在编译时出现，说明 PlatformIO 的框架文件被误粘贴成了本文件的内容 ----
// 典型现象：报错路径指向 ...\.platformio\packages\framework-arduinoespressif32\libraries\...\WiFiClientSecure.h 等框架文件，
//           且几百行 "'WiFiClientSecure' was not declared in this scope"。这不是代码问题，是框架被污染。
// 修复：删除文件夹 %USERPROFILE%\.platformio\packages\framework-arduinoespressif32 后重新 Build（会自动重新下载），
//       或运行 firmware/tools/fix_platformio.ps1；详见复制代码界面 ③ 最上方红色卡片。
#ifdef RADAR_COMMON_LOADED
#error "radar_common.h 被第二次加载：PlatformIO 框架文件（如 WiFiClientSecure.h）被误粘贴成了本文件内容。请删除 %USERPROFILE%/.platformio/packages/framework-arduinoespressif32 后重新 Build，并且不要点进 #include <...> 的框架头文件去粘贴代码。"
#endif
#define RADAR_COMMON_LOADED 1

#include <Arduino.h>
#include <WiFi.h>
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

#define FW_VERSION "10.0.0"
#ifndef PAIR_MAGIC
#define PAIR_MAGIC 0xC5
#endif
#define RMAGIC PAIR_MAGIC

// loop 任务栈加大：TLS 握手 + String 操作在默认 8KB 栈上偶发溢出 → 重启（core 2.0.8+ / 3.x 支持这个宏）
#if defined(SET_LOOP_TASK_STACK_SIZE)
SET_LOOP_TASK_STACK_SIZE(16 * 1024);
#endif

// ---- Arduino-ESP32 core 2.x 与 core 3.x 兼容层 ----
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
#define RADAR_CORE3 1
#else
#define RADAR_CORE3 0
#endif

enum : uint8_t { T_SYNC = 1, T_ACK = 2, T_HOP = 3, T_PROBE = 4, T_REPLY = 5, T_HOME = 6, T_DATA = 7, T_STAT = 8 };

// ESP-NOW 控制帧（16 字节）
struct __attribute__((packed)) RFrame {
  uint8_t magic;
  uint8_t type;    // T_*
  uint16_t sweep;  // 扫描轮号（由 A 决定）
  uint8_t chIdx;   // HOP: 信道在计划中的序号
  uint8_t ch;      // HOP/HOME: 目标信道；PROBE/REPLY/SYNC: 当前信道
  uint8_t seq;     // 本信道内的交换序号
  uint8_t home;    // SYNC/HOME: 会合信道（= A 连接的路由器信道）
  uint32_t t1;     // PROBE: A 发送时刻(us)；REPLY: 回显 A 发送时刻
  uint32_t t2;     // REPLY: B 的周转时间(us)
};

// B → A：B 收到探测包时测得的 CSI（H_AB），单播（144 字节）
struct __attribute__((packed)) DFrame {
  uint8_t magic;
  uint8_t type;    // T_DATA
  uint16_t sweep;
  uint8_t ch;
  uint8_t seq;
  int8_t rssi;
  uint8_t flags;
  uint32_t ts;     // B 的硬件接收时间戳(us)
  uint32_t aux;    // A 发送探测包的时刻(us)
  int8_t csi[128];
};

// B → A：B 的状态（A 转发给 Kaggle，网页上显示 Node B 在线/重启原因/CSI 计数）
struct __attribute__((packed)) SFrame {
  uint8_t magic;
  uint8_t type;    // T_STAT
  uint8_t rst;     // 复位原因编码
  uint8_t last;    // 上次复位前所处阶段
  uint16_t boot;
  uint16_t heapKB;
  int8_t rssi;     // B 听 A 的信号强度
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

// 上传给主机的一条 CSI 记录（144 字节，与 v9 完全相同）
struct __attribute__((packed)) RRec {
  uint8_t dir;     // 0 = B 收到 A 的探测 (H_AB)；1 = A 收到 B 的回复 (H_BA)
  uint8_t ch;
  uint8_t seq;
  int8_t rssi;
  uint16_t sweep;
  uint32_t ts;
  uint32_t aux;    // dir0: A 发送时刻(us)；dir1: 往返时间扣除 B 周转后(us)
  uint8_t len;
  uint8_t flags;
  int8_t csi[128];
};

struct __attribute__((packed)) RHdr {
  char magic[2];   // 'R','C'
  uint8_t ver;     // 1
  uint8_t node;    // 0 = A, 1 = B
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
// 一批上传的记录数 = 信道数 × 每信道交换数 × 扫描轮数，再留 32 条余量（A 有两份缓冲，片内 RAM 紧张，不再多留一整轮）
#define RECS_CAP (NPLAN * EXCHANGES_PER_CH * SWEEPS_PER_UPLOAD + 32)
#define CSI_RING 24
#define MATCH_US 1500

static const uint8_t BCAST[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

// ---------------- 阶段标记（保存在 RTC 内存里，重启后还能知道“死在哪一步”） ----------------
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

// ---------------- 状态灯 ----------------
static void led(uint8_t r, uint8_t g, uint8_t b) {
#if ENABLE_LED && defined(RGB_BUILTIN)
#if RADAR_CORE3
  rgbLedWrite(RGB_BUILTIN, r, g, b);
#else
  neopixelWrite(RGB_BUILTIN, r, g, b);
#endif
#endif
}

// ---------------- 日志（USB 口和 UART 口同时输出） ----------------
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
  Serial.setTxTimeoutMs(0);   // 没连电脑时绝不阻塞
  Serial0.begin(SERIAL_BAUD);
#endif
}

// ---------------- CSI 环形缓冲 ----------------
struct CsiSlot {
  volatile uint8_t used;
  uint8_t ch;
  int8_t rssi;
  uint8_t len;
  uint8_t mac[6];
  uint32_t cb_us;
  uint32_t hw_ts;
  int8_t buf[128];
};
static CsiSlot g_csi[CSI_RING];
static volatile uint32_t g_csiHead = 0;
static volatile bool g_csiOn = false;
static uint8_t g_peerMac[6];
static volatile bool g_havePeer = false;
static volatile uint32_t g_csiSeen = 0, g_csiKept = 0;
static volatile int8_t g_lastRssi = 0;

static void csiCb(void*, wifi_csi_info_t* info) {
  if (!g_csiOn || !info || !info->buf || info->len < 128) return;
  g_csiSeen = g_csiSeen + 1;
  if (!g_havePeer || memcmp(info->mac, g_peerMac, 6) != 0) return;
  CsiSlot& s = g_csi[g_csiHead % CSI_RING];
  s.used = 0;
  s.ch = info->rx_ctrl.channel;
  s.rssi = info->rx_ctrl.rssi;
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

// 按“回调时间最接近”取出与某个 ESP-NOW 帧对应的 CSI
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

static bool waitTakeCsi(uint32_t frame_us, CsiSlot* out, uint32_t maxUs) {
  uint32_t t0 = micros();
  for (;;) {
    if (takeCsi(frame_us, out)) return true;
    if (micros() - t0 > maxUs) return false;
    delayMicroseconds(100);
  }
}

// ---------------- 记录缓冲（头部 + 记录连续存放，上传时零拷贝）：A 有两份（自己的 H_BA / B 发来的 H_AB） ----------------
struct RecBuf {
  uint8_t* body;
  RRec* recs;
  volatile uint16_t n;
  volatile uint32_t dropped;
};
static RecBuf gBufA = {nullptr, nullptr, 0, 0};   // node=0：A 自己收到的 H_BA
static RecBuf gBufB = {nullptr, nullptr, 0, 0};   // node=1：B 通过 T_DATA 发来的 H_AB
static uint16_t g_boot = 0;
static portMUX_TYPE g_bufMux = portMUX_INITIALIZER_UNLOCKED;

static bool bufInit(RecBuf& b) {
  size_t bytes = sizeof(RHdr) + sizeof(RRec) * RECS_CAP;
  b.body = nullptr;
#if defined(BOARD_HAS_PSRAM)
  if (psramFound()) b.body = (uint8_t*)ps_malloc(bytes);   // N16R8 / N8R8 板：用 8MB PSRAM，片内 RAM 留给 WiFi/TLS
#endif
  if (!b.body) b.body = (uint8_t*)malloc(bytes);
  if (!b.body) return false;
  b.recs = (RRec*)(b.body + sizeof(RHdr));
  b.n = 0;
  b.dropped = 0;
  return true;
}
static void bootIdInit() { g_boot = (uint16_t)(esp_random() & 0xFFFF); }

static void bufAdd(RecBuf& b, uint8_t dir, uint8_t ch, uint8_t seq, uint16_t sweep, int8_t rssi, uint32_t ts, uint32_t aux, const int8_t* csi) {
  if (!b.recs) return;
  portENTER_CRITICAL(&g_bufMux);
  if (b.n >= RECS_CAP) {
    b.dropped = b.dropped + 1;
  } else {
    RRec& r = b.recs[b.n];
    r.dir = dir; r.ch = ch; r.seq = seq; r.rssi = rssi; r.sweep = sweep;
    r.ts = ts; r.aux = aux; r.len = 128; r.flags = 0;
    memcpy(r.csi, csi, 128);
    b.n = b.n + 1;
  }
  portEXIT_CRITICAL(&g_bufMux);
}

// ---------------- ESP-NOW ----------------
static volatile uint32_t g_sendErr = 0;
static esp_err_t sendFrame(const RFrame& f) {
  esp_err_t e = esp_now_send(BCAST, (const uint8_t*)&f, sizeof(RFrame));
  if (e != ESP_OK) g_sendErr = g_sendErr + 1;
  return e;
}

// 单播（带 MAC 层 ACK 与重传）；上一帧还在发时 esp_now_send 会返回 NO_MEM，等一小会儿重试
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
  p.channel = 0;                 // 0 = 跟随当前信道
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

static void radioInit(radar_recv_fn cb) {
  stageSet(S_RADIO);
  g_userRecv = cb;
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(false);   // 否则协议栈会自己扫描信道，把我们的信道计划打乱
  WiFi.disconnect(false, false);
  wifi_country_t c;
  memset(&c, 0, sizeof(c));
  strcpy(c.cc, COUNTRY_CODE);
  c.schan = 1; c.nchan = 13; c.max_tx_power = 20; c.policy = WIFI_COUNTRY_POLICY_MANUAL;
  esp_wifi_set_country(&c);
  esp_wifi_set_max_tx_power((int8_t)(TX_POWER_DBM * 4));   // 单位 0.25dBm；两块板相距很近，不需要 19.5dBm，发射峰值小 = 不容易欠压重启
  if (esp_now_init() != ESP_OK) { rlog("[radio] esp_now_init 失败"); return; }
  esp_now_register_recv_cb(espnowRecvThunk);
  addPeer(BCAST);
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wdeprecated-declarations"
  esp_err_t r = esp_wifi_config_espnow_rate(WIFI_IF_STA, WIFI_PHY_RATE_6M);   // 6Mbps OFDM：稳、必带 L-LTF
#pragma GCC diagnostic pop
  if (r != ESP_OK) rlog("[radio] espnow_rate err=0x%x", (unsigned)r);

  wifi_csi_config_t cc;
  memset(&cc, 0, sizeof(cc));
  cc.lltf_en = true;
  cc.htltf_en = false;
  cc.stbc_htltf2_en = false;
  cc.ltf_merge_en = true;
  cc.channel_filter_en = false;   // 不做平滑：保留频率选择性（多径信息）
  cc.manu_scale = false;
  cc.shift = 0;
  esp_err_t e1 = esp_wifi_set_csi_config(&cc);
  esp_err_t e2 = esp_wifi_set_csi_rx_cb(csiCb, nullptr);
  esp_err_t e3 = esp_wifi_set_csi(true);
  if (e1 || e2 || e3) rlog("[csi] ❌ 启用失败 0x%x/0x%x/0x%x", (unsigned)e1, (unsigned)e2, (unsigned)e3);
  else rlog("[csi] ✅ CSI 已启用 (L-LTF 64 子载波)");
}

// 进入“扫描模式”：断开路由器、开混杂、打开 CSI、停在指定信道
static void radioSweepMode(uint8_t ch) {
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
//  以下只有 Node A 用到：WiFi 连接 + HTTPS 上传（Node B 不联网，这些函数不会被调用）
// ============================================================================
static bool gHaveLease = false, gHaveBssid = false;
static IPAddress gIp, gGw, gMask, gDns;
static uint8_t gBssid[6];
static int gRouterCh = 0;
static uint32_t gLeaseMs = 0, gLastHelloMs = 0;
static uint32_t gUpOk = 0, gUpFail = 0, gFailStreak = 0;
static String gBase = KAGGLE_URL;
static String gUrls[3] = {KAGGLE_URL, KAGGLE_URL2, KAGGLE_URL3};
static int gUrlIdx = 0;
static int gLastErr = 0;
static int gLastCode = 0;

// 链路统计（A 侧）：网页「检测日志」里直接显示，能一眼看出是哪一层不通
static uint32_t gProbeTx = 0, gReplyRx = 0, gCsiPaired = 0, gSyncOk = 0, gSyncFail = 0;
static volatile uint32_t gDataRx = 0, gStatRx = 0;
static SFrame gSt;                    // B 最近一次状态
static volatile uint32_t gStMs = 0;   // 收到时刻（millis，0=从未收到）

static bool urlPlaceholder(const String& u) { return u.length() < 12 || u.indexOf("YOUR-TUNNEL") >= 0 || !u.startsWith("http"); }
static void rotateUrl() {   // 上传失败后换下一个可用网址（trycloudflare / lhr.life / pinggy）
  for (int i = 1; i <= 3; i++) {
    int j = (gUrlIdx + i) % 3;
    if (!urlPlaceholder(gUrls[j])) { gUrlIdx = j; gBase = gUrls[j]; return; }
  }
}
static bool wifiPlaceholder() { return String(WIFI_SSID) == "YOUR_WIFI_SSID" || strlen(WIFI_SSID) == 0; }

static bool wifiUp(uint32_t tmo) {
  stageSet(S_WIFI);
  esp_wifi_set_promiscuous(false);
  g_csiOn = false;
  if (gHaveLease && millis() - gLeaseMs > 1200000) { gHaveLease = false; WiFi.config(IPAddress(), IPAddress(), IPAddress()); }
  if (gHaveLease) {                                      // 复用上次的 IP，省掉 DHCP；DNS = 路由器 + 备用 DNS
    IPAddress d1 = (gDns == IPAddress((uint32_t)0)) ? gGw : gDns;
    IPAddress d2;
    if (!d2.fromString(DNS_FALLBACK)) d2 = IPAddress(223, 5, 5, 5);
    WiFi.config(gIp, gGw, gMask, d1, d2);
  }
  if (gHaveBssid) WiFi.begin(WIFI_SSID, WIFI_PASS, gRouterCh, gBssid, true);
  else WiFi.begin(WIFI_SSID, WIFI_PASS);
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < tmo) delay(15);
  if (WiFi.status() != WL_CONNECTED) {
    WiFi.disconnect(false, false);
    if (gHaveLease) { gHaveLease = false; WiFi.config(IPAddress(), IPAddress(), IPAddress()); }
    gHaveBssid = false;
    return false;
  }
  if (!gHaveLease) {
    gIp = WiFi.localIP(); gGw = WiFi.gatewayIP(); gMask = WiFi.subnetMask(); gDns = WiFi.dnsIP();
    gHaveLease = true; gLeaseMs = millis();
  }
  memcpy(gBssid, WiFi.BSSID(), 6);
  gRouterCh = WiFi.channel();
  gHaveBssid = true;
  return true;
}

// 从 ntfy 读 Kaggle 最新发布的网址（空格分隔的多个）：发现的排在前面，config.h 里的排在后面，最多 3 个
static String discoverUrl() {
  if (strlen(RADAR_TOPIC) == 0) return "";
  WiFiClientSecure c;
  c.setInsecure();
  HTTPClient h;
  h.setTimeout(HTTP_TIMEOUT_MS);
  String u = String("https://ntfy.sh/") + RADAR_TOPIC + "/raw?poll=1&since=12h";
  if (!h.begin(c, u)) return "";
  int code = h.GET();
  String first = "";
  if (code == 200) {
    String s = h.getString();
    s.trim();
    int nl = s.lastIndexOf('\n');
    String line = nl >= 0 ? s.substring(nl + 1) : s;
    String found[3];
    int nf = 0, p = 0;
    while (nf < 3) {
      int a = line.indexOf("https://", p);
      if (a < 0) break;
      int e = a;
      while (e < (int)line.length() && line[e] > ' ') e++;
      found[nf++] = line.substring(a, e);
      p = e;
    }
    if (nf > 0) {
      String merged[3];
      int nm = 0;
      for (int k = 0; k < nf && nm < 3; k++) merged[nm++] = found[k];
      String cfg[3] = {KAGGLE_URL, KAGGLE_URL2, KAGGLE_URL3};
      for (int k = 0; k < 3 && nm < 3; k++) {
        if (urlPlaceholder(cfg[k])) continue;
        bool dup = false;
        for (int m = 0; m < nm; m++) if (merged[m] == cfg[k]) dup = true;
        if (!dup) merged[nm++] = cfg[k];
      }
      for (int k = 0; k < 3; k++) gUrls[k] = k < nm ? merged[k] : String("");
      gUrlIdx = 0;
      first = gUrls[0];
    }
  }
  h.end();
  rlog("[topic] ntfy -> HTTP %d  %s", code, first.c_str());
  return first;
}

// A 的 info（X-Radar-Info）：除 v9 的字段外，新增 rst(上次复位原因) last(复位前阶段) lnk(ESP-NOW 链路各层计数)
static void buildInfoA(char* out, size_t cap, const String& host) {
  snprintf(out, cap,
           "fw=%s;mac=%s;rssi=%d;ch=%d;ip=%s;heap=%u;up=%u;fail=%u;plan=%d;seen=%u;kept=%u;lerr=%d;url=%.40s;rst=%s;last=%s;"
           "lnk=sync:%u/%u,probe:%u,reply:%u,csi:%u,data:%u,stat:%u,txerr:%u;pwr=%d",
           FW_VERSION, WiFi.macAddress().c_str(), WiFi.RSSI(), WiFi.channel(), WiFi.localIP().toString().c_str(),
           (unsigned)ESP.getFreeHeap(), (unsigned)gUpOk, (unsigned)gUpFail, NPLAN, (unsigned)g_csiSeen, (unsigned)g_csiKept, gLastErr,
           host.c_str(), rstName(g_rst), stageName(g_lastStage),
           (unsigned)gSyncOk, (unsigned)(gSyncOk + gSyncFail), (unsigned)gProbeTx, (unsigned)gReplyRx, (unsigned)gCsiPaired,
           (unsigned)gDataRx, (unsigned)gStatRx, (unsigned)g_sendErr, (int)TX_POWER_DBM);
}

// B 的 info：来自 B 通过 ESP-NOW 发来的 T_STAT（B 没有 IP，ip 写 via-A）
static void buildInfoB(char* out, size_t cap, const uint8_t* mac, const SFrame& s) {
  snprintf(out, cap,
           "fw=%s;mac=%02X:%02X:%02X:%02X:%02X:%02X;rssi=%d;ch=%d;ip=ESP-NOW(via A);heap=%u;up=%u;fail=%u;plan=%d;seen=%u;kept=%u;lerr=0;url=via-A;rst=%s;last=%s;"
           "lnk=sync:%u,lost:%u,probe:%u,csi:%u,datatx:%u,datafail:%u;pwr=%d",
           FW_VERSION, mac[0], mac[1], mac[2], mac[3], mac[4], mac[5], (int)s.rssi, (int)gRouterCh, (unsigned)s.heapKB * 1024u, (unsigned)s.syncs,
           (unsigned)s.dataFail, NPLAN, (unsigned)s.csiSeen, (unsigned)s.csiKept, rstName(s.rst), stageName(s.last),
           (unsigned)s.syncs, (unsigned)s.lost, (unsigned)s.probeRx, (unsigned)s.csiGot, (unsigned)s.dataTx, (unsigned)s.dataFail, (int)TX_POWER_DBM);
}

// POST 一个缓冲（nrec=0 也可作为“在线心跳”）。返回 HTTP 码（<0 = 网络错误）
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
  http.setConnectTimeout(6000);
  String url = gBase + "/api/ingest";
  bool began = secure ? (cs.setInsecure(), http.begin(cs, url)) : http.begin(cp, url);
  if (!began) { gLastCode = -100; return -100; }
  http.addHeader("Content-Type", "application/octet-stream");
  http.addHeader("X-Radar-Key", API_KEY);
  http.addHeader("X-Radar-Info", info);
  int code = http.POST(b.body, bytes);
  gLastCode = code;
  String es = code < 0 ? http.errorToString(code) : String("");
  http.end();
  rlog("[upload] node=%c rec=%u bytes=%u -> HTTP %d %s  (%s)", node ? 'B' : 'A', (unsigned)n, (unsigned)bytes, code, es.c_str(), gBase.c_str());
  return code;
}

// 已连上路由器时调用：先传 A 自己的 H_BA（node=0），再传 B 经 ESP-NOW 转来的 H_AB（node=1）
static bool postAll() {
  stageSet(S_POST);
  if (urlPlaceholder(gBase) || gFailStreak >= 3) {
    String d = discoverUrl();
    if (d.length() > 12) { gBase = d; gFailStreak = 0; }
  }
  if (urlPlaceholder(gBase)) rotateUrl();
  if (urlPlaceholder(gBase)) { rlog("[upload] ❌ 没有 Kaggle 网址：请在 config.h 填 KAGGLE_URL"); return false; }
  while (gBase.endsWith("/")) gBase.remove(gBase.length() - 1);

  String host = gBase;
  host.replace("https://", ""); host.replace("http://", "");
  char info[520];
  buildInfoA(info, sizeof(info), host);
  int code = postBuf(gBufA, 0, g_boot, millis(), info);

  // Node B：只有最近 20 秒内听到过 B（或者手里有 B 的记录）才上报，网页上 B 的在线状态才是真的
  SFrame st;
  uint32_t stMs;
  portENTER_CRITICAL(&g_bufMux);
  memcpy(&st, &gSt, sizeof(st));
  stMs = gStMs;
  portEXIT_CRITICAL(&g_bufMux);
  bool bFresh = stMs != 0 && millis() - stMs < 20000;
  if (code == 200 && (gBufB.n > 0 || bFresh)) {
    if (stMs != 0) {
      buildInfoB(info, sizeof(info), g_peerMac, st);
      int cb = postBuf(gBufB, 1, st.boot, st.uptime_ms, info);   // B 的上传结果不影响 A 的成功判断
      if (cb == 200) gBufB.n = 0;
      else if (gBufB.n > RECS_CAP / 2) gBufB.n = 0;
    } else {
      gBufB.n = 0;
    }
  }
  if (code != 200) {
    gLastErr = code;
    // 失败时做一次 DNS / 公网体检，串口里直接看到原因
    String hh = gBase; hh.replace("https://", ""); hh.replace("http://", "");
    int sl = hh.indexOf('/'); if (sl > 0) hh = hh.substring(0, sl);
    IPAddress ip;
    bool dnsOk = WiFi.hostByName(hh.c_str(), ip) == 1;
    rlog("[diag] DNS %s -> %s %s | 提示：-1=连不上(DNS/被墙/网址旧) -11=超时 401=API_KEY不一致 530/1033=隧道已换 → 改 config.h 的 KAGGLE_URL 或填备用网址", hh.c_str(), dnsOk ? "OK" : "失败", dnsOk ? ip.toString().c_str() : "");
    rotateUrl();
  } else gLastErr = 0;
  return code == 200;
}

// 回到路由器信道并上传。更新会合信道 *homeCh（= 路由器信道）。无数据且最近报过平安时直接跳过，节省时间。
static void homeUpload(uint8_t* homeCh) {
#if ENABLE_UPLOAD
  // 无人值守看门狗：连续失败太多次 / 堆内存异常 → 自动重启
  if (gFailStreak >= 40 || ESP.getFreeHeap() < 16000) {
    rlog("[wdt] 连续失败 %u 次 / 堆内存 %u：自动重启", (unsigned)gFailStreak, (unsigned)ESP.getFreeHeap());
    delay(300);
    ESP.restart();
  }
  bool due = gBufA.n > 0 || gBufB.n > 0 || gLastHelloMs == 0 || millis() - gLastHelloMs > HELLO_EVERY_MS;
  if (!due) return;
  if (wifiPlaceholder()) { if (gLastHelloMs == 0) rlog("[wifi] 未填 WIFI_SSID：只做扫描，不上传"); gBufA.n = 0; gBufB.n = 0; gLastHelloMs = millis(); return; }
  uint32_t t0 = millis();
  led(0, 0, 40);   // 蓝：连路由器
  if (!wifiUp(WIFI_TIMEOUT_MS)) {
    led(60, 0, 0);
    gUpFail++; gFailStreak++;
    rlog("[wifi] ❌ 连接 %s 失败（SSID/密码错或是 5GHz？手机热点请打开“最大兼容性”=2.4GHz）", WIFI_SSID);
    if (gBufA.n > RECS_CAP / 2) gBufA.n = 0;
    if (gBufB.n > RECS_CAP / 2) gBufB.n = 0;
  } else {
    *homeCh = (uint8_t)WiFi.channel();
    led(40, 30, 0);  // 黄：上传中
    bool ok = postAll();
    led(ok ? 0 : 60, ok ? 40 : 0, 0);   // 绿=成功 红=失败
    if (ok) { gUpOk++; gFailStreak = 0; gBufA.n = 0; gLastHelloMs = millis(); }
    else { gUpFail++; gFailStreak++; if (gBufA.n > RECS_CAP / 2) gBufA.n = 0; if (gBufB.n > RECS_CAP / 2) gBufB.n = 0; }
    rlog("[wifi] ✅ RSSI=%d 信道=%d 用时 %lu ms", WiFi.RSSI(), WiFi.channel(), (unsigned long)(millis() - t0));
  }
#else
  gBufA.n = 0; gBufB.n = 0;
#endif
}
