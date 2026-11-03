#pragma once
// ============================================================================
//  radar_common.h —— Node A / Node B 共用：协议、CSI 环形缓冲、ESP-NOW、WiFi 上传（Node A、Node B 内容相同）
//
//  物理模型：A→B 探测包让 B 得到 H_AB，B→A 回复让 A 得到 H_BA。主机端计算 H_AB × H_BA，
//  两端本振/PLL 的随机相位互相抵消（Chronos 思路），再用相邻信道重叠子载波做相位拼接。
//  CSI 只取 L-LTF（64 子载波，128 字节 int8：每子载波 [imag, real]）。
// ============================================================================
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

#define FW_VERSION "8.0.0"
#define RMAGIC 0xC5

enum : uint8_t { T_SYNC = 1, T_ACK = 2, T_HOP = 3, T_PROBE = 4, T_REPLY = 5, T_HOME = 6 };

// ESP-NOW 帧（19 字节）
struct __attribute__((packed)) RFrame {
  uint8_t magic;   // 0xC5
  uint8_t type;    // T_*
  uint16_t sweep;  // 扫描轮号（由 A 决定）
  uint8_t chIdx;   // HOP: 信道在计划中的序号
  uint8_t ch;      // HOP/HOME: 目标信道；PROBE/REPLY: 当前信道
  uint8_t seq;     // 本信道内的交换序号
  uint8_t home;    // SYNC: 会合信道
  uint32_t t1;     // PROBE: A 发送时刻(us)；REPLY: 回显 A 发送时刻
  uint32_t t2;     // REPLY: B 的周转时间(us)
};

// 上传给主机的一条 CSI 记录（144 字节）
struct __attribute__((packed)) RRec {
  uint8_t dir;     // 0 = B 收到 A 的探测 (H_AB)；1 = A 收到 B 的回复 (H_BA)
  uint8_t ch;
  uint8_t seq;
  int8_t rssi;
  uint16_t sweep;
  uint32_t ts;     // 硬件接收时间戳(us, rx_ctrl.timestamp)
  uint32_t aux;    // dir0: A 发送时刻(us)；dir1: 往返时间扣除 B 周转后(us)
  uint8_t len;     // CSI 字节数 (128)
  uint8_t flags;
  int8_t csi[128];
};

struct __attribute__((packed)) RHdr {
  char magic[2];   // 'R','C'
  uint8_t ver;     // 1
  uint8_t node;    // 0 = A, 1 = B
  uint16_t nrec;
  uint16_t boot;   // 开机随机 ID
  uint32_t uptime_ms;
  uint32_t dropped;
};

#if CHANNEL_PLAN == 1
static const uint8_t PLAN[] = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13};
#else
static const uint8_t PLAN[] = {1, 6, 11};
#endif
#define NPLAN ((int)sizeof(PLAN))
#define RECS_CAP (NPLAN * EXCHANGES_PER_CH * (SWEEPS_PER_UPLOAD + 1))
#define CSI_RING 24
#define MATCH_US 1500

static const uint8_t BCAST[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

// ---------------- 日志（同时输出到 USB 口和 UART 口，插哪个都能在串口监视器看到） ----------------
static void rlog(const char* fmt, ...) {
  char b[220];
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

static void csiCb(void*, wifi_csi_info_t* info) {
  if (!g_csiOn || !info || !info->buf || info->len < 128) return;
  g_csiSeen++;
  if (!g_havePeer || memcmp(info->mac, g_peerMac, 6) != 0) return;
  CsiSlot& s = g_csi[g_csiHead % CSI_RING];
  s.used = 0;
  s.ch = info->rx_ctrl.channel;
  s.rssi = info->rx_ctrl.rssi;
  s.len = 128;
  memcpy(s.mac, info->mac, 6);
  s.cb_us = (uint32_t)esp_timer_get_time();
  s.hw_ts = info->rx_ctrl.timestamp;
  memcpy(s.buf, info->buf, 128);
  s.used = 1;
  g_csiHead++;
  g_csiKept++;
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

// ---------------- 记录缓冲（头部 + 记录连续存放，上传时零拷贝） ----------------
static uint8_t* g_body = nullptr;
static RRec* g_recs = nullptr;
static volatile uint16_t g_nrec = 0;
static volatile uint32_t g_dropped = 0;
static uint16_t g_boot = 0;

static bool recsInit() {
  size_t bytes = sizeof(RHdr) + sizeof(RRec) * RECS_CAP;
  g_body = (uint8_t*)malloc(bytes);
  if (!g_body) return false;
  g_recs = (RRec*)(g_body + sizeof(RHdr));
  g_boot = (uint16_t)(esp_random() & 0xFFFF);
  return true;
}

static void recAdd(uint8_t dir, uint8_t ch, uint8_t seq, uint16_t sweep, const CsiSlot& s, uint32_t aux) {
  if (g_nrec >= RECS_CAP) { g_dropped++; return; }
  RRec& r = g_recs[g_nrec];
  r.dir = dir; r.ch = ch; r.seq = seq; r.rssi = s.rssi; r.sweep = sweep;
  r.ts = s.hw_ts; r.aux = aux; r.len = 128; r.flags = 0;
  memcpy(r.csi, s.buf, 128);
  g_nrec++;
}

// ---------------- ESP-NOW ----------------
static esp_err_t sendFrame(const RFrame& f) {
  return esp_now_send(BCAST, (const uint8_t*)&f, sizeof(RFrame));
}

static void radioInit(esp_now_recv_cb_t cb) {
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
  WiFi.setTxPower(WIFI_POWER_19_5dBm);
  if (esp_now_init() != ESP_OK) { rlog("[radio] esp_now_init 失败"); return; }
  esp_now_register_recv_cb(cb);
  esp_now_peer_info_t p;
  memset(&p, 0, sizeof(p));
  memcpy(p.peer_addr, BCAST, 6);
  p.channel = 0;
  p.ifidx = WIFI_IF_STA;
  p.encrypt = false;
  esp_now_add_peer(&p);
  esp_err_t r = esp_wifi_config_espnow_rate(WIFI_IF_STA, WIFI_PHY_RATE_6M);   // 6Mbps OFDM：稳、必带 L-LTF
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

// ---------------- WiFi / 上传 ----------------
static bool gHaveLease = false, gHaveBssid = false;
static IPAddress gIp, gGw, gMask, gDns;
static uint8_t gBssid[6];
static int gRouterCh = 0;
static uint32_t gLeaseMs = 0, gLastHelloMs = 0;
static uint32_t gUpOk = 0, gUpFail = 0, gFailStreak = 0;
static String gBase = KAGGLE_URL;
static int gLastCode = 0;

static bool urlPlaceholder(const String& u) { return u.length() < 12 || u.indexOf("YOUR-TUNNEL") >= 0; }
static bool wifiPlaceholder() { return String(WIFI_SSID) == "YOUR_WIFI_SSID" || strlen(WIFI_SSID) == 0; }

static bool wifiUp(uint32_t tmo) {
  esp_wifi_set_promiscuous(false);
  g_csiOn = false;
  if (gHaveLease && millis() - gLeaseMs > 1200000) { gHaveLease = false; WiFi.config(IPAddress(), IPAddress(), IPAddress()); }
  if (gHaveLease) WiFi.config(gIp, gGw, gMask, gDns);   // 复用上次的 IP，省掉 DHCP（重连更快）
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

static String discoverUrl() {
  if (strlen(RADAR_TOPIC) == 0) return "";
  WiFiClientSecure c;
  c.setInsecure();
  HTTPClient h;
  h.setTimeout(HTTP_TIMEOUT_MS);
  String u = String("https://ntfy.sh/") + RADAR_TOPIC + "/raw?poll=1&since=12h";
  if (!h.begin(c, u)) return "";
  int code = h.GET();
  String out = "";
  if (code == 200) {
    String s = h.getString();
    int p = s.lastIndexOf("https://");
    if (p >= 0) {
      int e = p;
      while (e < (int)s.length() && s[e] > ' ') e++;
      out = s.substring(p, e);
    }
  }
  h.end();
  rlog("[topic] %s -> HTTP %d %s", u.c_str(), code, out.c_str());
  return out;
}

// 已连上路由器时调用：POST 记录（nrec=0 也可作为“在线心跳”）
static bool postRecs(uint8_t node) {
  if (urlPlaceholder(gBase) || gFailStreak >= 3) {
    String d = discoverUrl();
    if (d.length() > 12) { gBase = d; gFailStreak = 0; }
  }
  if (urlPlaceholder(gBase)) { rlog("[upload] ❌ 没有 Kaggle 网址：请在 config.h 填 KAGGLE_URL"); return false; }
  while (gBase.endsWith("/")) gBase.remove(gBase.length() - 1);
  uint16_t n = g_nrec;
  RHdr* h = (RHdr*)g_body;
  h->magic[0] = 'R'; h->magic[1] = 'C'; h->ver = 1; h->node = node; h->nrec = n;
  h->boot = g_boot; h->uptime_ms = millis(); h->dropped = g_dropped;
  size_t bytes = sizeof(RHdr) + (size_t)n * sizeof(RRec);

  char info[240];
  snprintf(info, sizeof(info), "fw=%s;mac=%s;rssi=%d;ch=%d;ip=%s;heap=%u;up=%u;fail=%u;plan=%d;seen=%u;kept=%u",
           FW_VERSION, WiFi.macAddress().c_str(), WiFi.RSSI(), WiFi.channel(), WiFi.localIP().toString().c_str(),
           (unsigned)ESP.getFreeHeap(), (unsigned)gUpOk, (unsigned)gUpFail, NPLAN, (unsigned)g_csiSeen, (unsigned)g_csiKept);

  bool secure = gBase.startsWith("https://");
  WiFiClientSecure cs;
  WiFiClient cp;
  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.setConnectTimeout(6000);
  String url = gBase + "/api/ingest";
  bool began = secure ? (cs.setInsecure(), http.begin(cs, url)) : http.begin(cp, url);
  if (!began) { gLastCode = -100; return false; }
  http.addHeader("Content-Type", "application/octet-stream");
  http.addHeader("X-Radar-Key", API_KEY);
  http.addHeader("X-Radar-Info", info);
  int code = http.POST(g_body, bytes);
  gLastCode = code;
  http.end();
  rlog("[upload] node=%c rec=%u bytes=%u -> HTTP %d", node ? 'B' : 'A', (unsigned)n, (unsigned)bytes, code);
  return code == 200;
}

// 回到路由器信道并上传。返回会合信道（home）。无数据且最近报过平安时直接跳过，节省时间。
static void homeUpload(uint8_t node, uint8_t* homeCh) {
#if ENABLE_UPLOAD
  bool due = g_nrec > 0 || gLastHelloMs == 0 || millis() - gLastHelloMs > HELLO_EVERY_MS;
  if (!due) return;
  if (wifiPlaceholder()) { if (gLastHelloMs == 0) rlog("[wifi] 未填 WIFI_SSID：只做扫描，不上传"); g_nrec = 0; gLastHelloMs = millis(); return; }
  uint32_t t0 = millis();
  if (!wifiUp(WIFI_TIMEOUT_MS)) {
    gUpFail++; gFailStreak++;
    rlog("[wifi] ❌ 连接 %s 失败（SSID/密码错或是 5GHz？）", WIFI_SSID);
    if (g_nrec > RECS_CAP / 2) g_nrec = 0;
  } else {
    *homeCh = (uint8_t)WiFi.channel();
    bool ok = postRecs(node);
    if (ok) { gUpOk++; gFailStreak = 0; g_nrec = 0; gLastHelloMs = millis(); }
    else { gUpFail++; gFailStreak++; if (g_nrec > RECS_CAP / 2) g_nrec = 0; }
    rlog("[wifi] ✅ RSSI=%d 信道=%d 用时 %lu ms", WiFi.RSSI(), WiFi.channel(), (unsigned long)(millis() - t0));
  }
#else
  g_nrec = 0;
#endif
}
