// ESP32-S3 WiFi Radar 固件 v5.0（新增 CSI 真实 WiFi 感知：RADARCSI 行）
// 流程：上电/复位 -> 立刻输出 RADARHELLO -> 扫描周围 AP -> 立刻输出 RADARJSON（不等联网）
//       -> 周期性嗅探周围设备 -> 有配置时再连接 WiFi 并 HTTPS POST 到 Kaggle 的 /api/ingest
//
// 输出协议（每行一条，115200，UTF-8）：
//   RADARHELLO:{...}   设备信息（开机 + 每 10 秒 + 收到 "hello" 命令时）
//   RADARHB:{...}      心跳（每秒，由独立任务发出：即使正在扫描/连 WiFi 也不会中断）
//   RADARJSON:{...}    一帧扫描结果（网页 / serial_bridge.py 解析后上传）
//   其它行             人类可读日志
//
// 串口输出同时走两个口（USB 原生口 + UART0），所以插哪个口都能收到：
//   ARDUINO_USB_CDC_ON_BOOT=1 时  Serial = 原生 USB(HWCDC)，Serial0 = UART0(CH340/CP2102)
//   ARDUINO_USB_CDC_ON_BOOT=0 时  Serial = UART0
//
// 串口命令：help / hello / show / ssid <x> / pass <x> / url <x> / key <x> / clear / reboot
#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <stdarg.h>
#include "esp_wifi.h"
#include "esp_system.h"
#include "config.h"
#if ENABLE_CSI
#include "ping/ping_sock.h"
#include "lwip/ip_addr.h"
#include <math.h>
#endif

#define FW_VERSION "5.0.0"

#if ARDUINO_USB_CDC_ON_BOOT
#define HAS_USB_PORT 1
#define UART_SER Serial0
#else
#define HAS_USB_PORT 0
#define UART_SER Serial
#endif

// ---------------- 双口输出 ----------------
static SemaphoreHandle_t outMux = nullptr;

static void rawWrite(const char* s, size_t n) {
  if (!n) return;
#if HAS_USB_PORT
  Serial.write((const uint8_t*)s, n);
#endif
#if HAS_USB_PORT == 0 || MIRROR_UART_PORT
  UART_SER.write((const uint8_t*)s, n);
#endif
}

// 一整行原子输出（多任务不会交错）
static void outLine(const char* prefix, const char* body) {
  if (outMux) xSemaphoreTake(outMux, portMAX_DELAY);
  rawWrite(prefix, strlen(prefix));
  rawWrite(body, strlen(body));
  rawWrite("\n", 1);
  if (outMux) xSemaphoreGive(outMux);
}

static void logf(const char* fmt, ...) {
  char b[400];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(b, sizeof(b), fmt, ap);
  va_end(ap);
  outLine("", b);
}

// ---------------- 嗅探到的周围设备 ----------------
struct Sta {
  uint8_t mac[6];
  uint8_t bssid[6];
  int8_t rssi;
  uint8_t ch;
  uint16_t cnt;
  bool hasBssid;
};
static Sta stas[MAX_STATIONS];
static volatile int staCount = 0;
static portMUX_TYPE staMux = portMUX_INITIALIZER_UNLOCKED;

static Preferences prefs;
static String cfgSsid, cfgPass, cfgUrl, cfgKey;
static String nodeId;
static uint32_t seqNo = 0, cycleNo = 0;
static uint32_t okCount = 0, failCount = 0;
static volatile const char* gState = "boot";
static volatile int gLastAps = -1;
static volatile int gLastHttp = 0;
static volatile uint32_t gScanMs = 0;
static bool wifiTried = false;
static uint32_t lastWifiTry = 0;
static uint32_t lastHello = 0;
// v4：自动发现网址（Kaggle 把最新网址发布到 ntfy.sh/<RADAR_TOPIC>）
static String activeUrl;            // 当前实际使用的服务器网址（来自汇合点或 config.h）
static uint32_t lastResolve = 0;
static bool everResolved = false;
static int consecFail = 0;
static volatile int gResolveCode = 0;

static const char* resetReason() {
  switch (esp_reset_reason()) {
    case ESP_RST_POWERON: return "POWERON";
    case ESP_RST_EXT: return "EXT_RESET";
    case ESP_RST_SW: return "SW_RESET";
    case ESP_RST_PANIC: return "PANIC";
    case ESP_RST_INT_WDT: return "INT_WDT";
    case ESP_RST_TASK_WDT: return "TASK_WDT";
    case ESP_RST_WDT: return "WDT";
    case ESP_RST_DEEPSLEEP: return "DEEPSLEEP";
    case ESP_RST_BROWNOUT: return "BROWNOUT";
    default: return "OTHER";
  }
}

// ---------------- 状态灯(板载 RGB，没有就忽略) ----------------
static void led(uint8_t r, uint8_t g, uint8_t b) {
#ifdef RGB_BUILTIN
  neopixelWrite(RGB_BUILTIN, r, g, b);
#else
  (void)r; (void)g; (void)b;
#endif
}

// ---------------- 配置 ----------------
static bool isPlaceholder(const char* s) {
  return s == nullptr || strlen(s) == 0 || strstr(s, "YOUR") != nullptr;
}

static void applyHeader(const char* key, const char* value) {
#if CONFIG_FROM_HEADER
  if (isPlaceholder(value)) return;
  String hk = String("h_") + key;
  if (prefs.getString(hk.c_str(), "") != value) {  // 重新烧录了新的 config.h
    prefs.putString(key, value);
    prefs.putString(hk.c_str(), value);
  }
#else
  (void)key; (void)value;
#endif
}

static void loadConfig() {
  prefs.begin("wradar", false);
  applyHeader("ssid", WIFI_SSID);
  applyHeader("pass", WIFI_PASS);
  applyHeader("url", SERVER_URL);
  applyHeader("key", API_KEY);
  cfgSsid = prefs.getString("ssid", isPlaceholder(WIFI_SSID) ? "" : WIFI_SSID);
  cfgPass = prefs.getString("pass", isPlaceholder(WIFI_PASS) ? "" : WIFI_PASS);
  cfgUrl = prefs.getString("url", isPlaceholder(SERVER_URL) ? "" : SERVER_URL);
  cfgKey = prefs.getString("key", API_KEY);
  while (cfgUrl.endsWith("/")) cfgUrl.remove(cfgUrl.length() - 1);
}

static void showConfig() {
  logf("[cfg] node=%s ssid='%s' pass=%s url='%s' key=%s", nodeId.c_str(), cfgSsid.c_str(),
       cfgPass.length() ? "****" : "(empty)", cfgUrl.c_str(), cfgKey.c_str());
}

static void sendHello() {
  JsonDocument d;
  d["fw"] = FW_VERSION;
  d["node"] = nodeId;
  d["chip"] = ESP.getChipModel();
  d["rev"] = ESP.getChipRevision();
  d["cores"] = ESP.getChipCores();
  d["flash"] = ESP.getFlashChipSize();
  d["psram"] = ESP.getPsramSize();
  d["heap"] = ESP.getFreeHeap();
  d["mac"] = WiFi.macAddress();
  d["rst"] = resetReason();
  d["usb"] = HAS_USB_PORT;
  d["mirror"] = (HAS_USB_PORT == 0 || MIRROR_UART_PORT) ? 1 : 0;
  d["up"] = millis() / 1000;
  d["ssid"] = cfgSsid;
  d["url"] = activeUrl.length() ? activeUrl : cfgUrl;
  d["topic"] = RADAR_TOPIC;
  d["wifi"] = (int)WiFi.status();
  d["sdk"] = ESP.getSdkVersion();
  d["csi"] = ENABLE_CSI;
  d["csihz"] = CSI_EMIT_HZ;
  String out;
  serializeJson(d, out);
  outLine("RADARHELLO:", out.c_str());
  lastHello = millis();
}

static String lineBuf;
static void feedChar(char c) {
  if (c == '\r') return;
  if (c != '\n') {
    if (lineBuf.length() < 200) lineBuf += c;
    return;
  }
  lineBuf.trim();
  String cmd = lineBuf, arg = "";
  int sp = lineBuf.indexOf(' ');
  if (sp > 0) { cmd = lineBuf.substring(0, sp); arg = lineBuf.substring(sp + 1); arg.trim(); }
  cmd.toLowerCase();
  if (cmd == "ssid") { prefs.putString("ssid", arg); cfgSsid = arg; wifiTried = false; logf("[cfg] ssid saved"); }
  else if (cmd == "pass") { prefs.putString("pass", arg); cfgPass = arg; wifiTried = false; logf("[cfg] pass saved"); }
  else if (cmd == "url") {
    while (arg.endsWith("/")) arg.remove(arg.length() - 1);
    prefs.putString("url", arg); cfgUrl = arg; logf("[cfg] url saved");
  }
  else if (cmd == "key") { prefs.putString("key", arg); cfgKey = arg; logf("[cfg] key saved"); }
  else if (cmd == "clear") { prefs.clear(); logf("[cfg] cleared, rebooting"); delay(300); ESP.restart(); }
  else if (cmd == "reboot") { ESP.restart(); }
  else if (cmd == "show") { showConfig(); }
  else if (cmd == "hello") { sendHello(); }
  else if (cmd == "help") { logf("[cmd] hello | show | ssid <x> | pass <x> | url <x> | key <x> | clear | reboot"); }
  else if (cmd.length()) { logf("[cmd] unknown '%s', type help", cmd.c_str()); }
  lineBuf = "";
}

static void handleSerial() {
#if HAS_USB_PORT
  while (Serial.available()) feedChar((char)Serial.read());
#endif
  while (UART_SER.available()) feedChar((char)UART_SER.read());
}

// ---------------- 混杂模式回调：只记录 "设备作为发送方" 的帧 ----------------
static void sniffer(void* buf, wifi_promiscuous_pkt_type_t type) {
  if (type != WIFI_PKT_MGMT && type != WIFI_PKT_DATA) return;
  const wifi_promiscuous_pkt_t* p = (const wifi_promiscuous_pkt_t*)buf;
  if (p->rx_ctrl.sig_len < 24) return;
  const uint8_t* f = p->payload;
  uint8_t ftype = (f[0] >> 2) & 3;
  uint8_t subtype = (f[0] >> 4) & 0x0F;
  bool toDS = f[1] & 0x01;
  bool fromDS = f[1] & 0x02;
  const uint8_t* sta = nullptr;
  const uint8_t* bss = nullptr;
  if (ftype == 2) {                       // 数据帧：只取 ToDS(设备 -> AP)，此时 addr2 是设备本身
    if (toDS && !fromDS) { bss = f + 4; sta = f + 10; }
    else return;
  } else if (ftype == 0) {                // 管理帧
    if (subtype == 4) { sta = f + 10; }                     // Probe Request
    else if (subtype == 0 || subtype == 2) { sta = f + 10; bss = f + 4; }  // (Re)Association Request
    else return;
  } else return;
  if (sta[0] & 0x01) return;              // 组播/广播
  if (p->rx_ctrl.rssi < -95) return;

  portENTER_CRITICAL(&staMux);
  int idx = -1;
  for (int i = 0; i < staCount; i++) {
    if (memcmp(stas[i].mac, sta, 6) == 0) { idx = i; break; }
  }
  if (idx < 0 && staCount < MAX_STATIONS) {
    idx = staCount++;
    memcpy(stas[idx].mac, sta, 6);
    stas[idx].rssi = p->rx_ctrl.rssi;
    stas[idx].ch = p->rx_ctrl.channel;
    stas[idx].cnt = 0;
    stas[idx].hasBssid = false;
  }
  if (idx >= 0) {
    Sta& s = stas[idx];
    s.rssi = (int8_t)((s.rssi * 3 + p->rx_ctrl.rssi) / 4);
    s.ch = p->rx_ctrl.channel;
    if (s.cnt < 65535) s.cnt++;
    if (bss && !(bss[0] & 0x01) && memcmp(bss, sta, 6) != 0) { memcpy(s.bssid, bss, 6); s.hasBssid = true; }
  }
  portEXIT_CRITICAL(&staMux);
}

#if ENABLE_CSI
static void csiStopPing();
#endif
static void sniffRound() {
  gState = "sniff";
#if ENABLE_CSI
  csiStopPing();
#endif
  wifiTried = false;   // v4 修复：嗅探会主动断开 WiFi，结束后要立刻重连上传，不能被 30 秒重试节流挡住
  WiFi.disconnect(false, false);
  WiFi.mode(WIFI_STA);
  delay(80);
  portENTER_CRITICAL(&staMux);
  staCount = 0;
  portEXIT_CRITICAL(&staMux);
  wifi_promiscuous_filter_t filt;
  filt.filter_mask = WIFI_PROMIS_FILTER_MASK_MGMT | WIFI_PROMIS_FILTER_MASK_DATA;
  esp_wifi_set_promiscuous_filter(&filt);
  esp_wifi_set_promiscuous_rx_cb(&sniffer);
  esp_wifi_set_promiscuous(true);
  for (uint8_t ch = 1; ch <= SNIFF_MAX_CH; ch++) {
    esp_wifi_set_channel(ch, WIFI_SECOND_CHAN_NONE);
    delay(SNIFF_DWELL_MS);
  }
  esp_wifi_set_promiscuous(false);
}

static String macStr(const uint8_t* m) {
  char b[18];
  snprintf(b, sizeof(b), "%02X:%02X:%02X:%02X:%02X:%02X", m[0], m[1], m[2], m[3], m[4], m[5]);
  return String(b);
}

// ======================================================================
//  v5：CSI（信道状态信息）—— 真正的 WiFi 感知数据源
//  RSSI 只有 “一个数字/热点”，测不到人；CSI 是每个包 64 个子载波的幅度，人体走动/呼吸会让它抖动。
//  两种取数方式：
//   1) STA 模式（推荐）：ESP32 连上你的路由器，每秒对网关发 CSI_PING_HZ 次 ping，路由器的每个回包都带 CSI
//   2) 被动模式（实验）：没配 WiFi 时，停在最强热点的信道上收它的信标帧（部分路由器信标是 11b 速率，没有 CSI）
//  每包输出一行：RADARCSI:{"t":毫秒,"r":rssi,"c":信道,"m":平均幅度,"d":湍流(1-相邻包相关系数),"a":"64个子载波幅度(十六进制)"}
// ======================================================================
#if ENABLE_CSI
struct CsiPkt { uint32_t t; int8_t rssi; uint8_t ch; uint8_t n; float m; float d; uint8_t a[64]; };
struct CsiFeat { uint32_t t; int8_t r; uint16_t m10; uint16_t d1000; };
static QueueHandle_t csiQ = nullptr;
static CsiFeat csiFeat[CSI_FEAT_N];
static volatile uint32_t csiFeatN = 0;
static portMUX_TYPE csiMux = portMUX_INITIALIZER_UNLOCKED;
static volatile uint32_t csiRaw = 0, csiKept = 0, csiDrop = 0;
static uint32_t csiLastKeep = 0;
static uint8_t csiPrev[64];
static bool csiHasPrev = false;
static volatile int gCsiMode = 0;        // 0 关闭 1 STA(ping 路由器) 2 被动(信标)
static volatile int gCsiRate = 0;        // 最近 1 秒收到的 CSI 包数（未抽稀前）
static volatile int gCsiErr = 0;         // esp_wifi_set_csi* 的错误码（0=正常）
static bool csiCfgDone = false;
static esp_ping_handle_t pingH = nullptr;
static uint32_t pingGw = 0;
static uint8_t gBestCh = 6;

static void csiCb(void*, wifi_csi_info_t* info) {
  if (!info || !info->buf || info->len < 16) return;
  csiRaw++;
  uint32_t ms = millis();
  if (ms - csiLastKeep < (uint32_t)(1000 / CSI_EMIT_HZ)) return;   // 抽稀到 CSI_EMIT_HZ
  csiLastKeep = ms;
  CsiPkt p;
  int n = info->len / 2;
  if (n > 64) n = 64;
  const int8_t* b = (const int8_t*)info->buf;
  float sum = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  int kc = 0, k = 0;
  for (int i = 0; i < n; i++) {
    float im = b[2 * i], re = b[2 * i + 1];
    float amp = sqrtf(re * re + im * im);
    uint8_t q = amp > 255.f ? 255 : (uint8_t)(amp + 0.5f);
    p.a[i] = q;
    if (q > 0) {
      sum += q; kc++;
      if (csiHasPrev && csiPrev[i] > 0) { float x = q, y = csiPrev[i]; sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y; k++; }
    }
  }
  for (int i = n; i < 64; i++) p.a[i] = 0;
  float d = 0;
  if (csiHasPrev && k > 8) {
    float cov = sab - sa * sb / k, va = saa - sa * sa / k, vb = sbb - sb * sb / k;
    if (va > 1e-3f && vb > 1e-3f) { d = 1.f - cov / sqrtf(va * vb); if (d < 0) d = 0; if (d > 2) d = 2; }
  }
  memcpy(csiPrev, p.a, 64);
  csiHasPrev = true;
  p.t = ms; p.rssi = info->rx_ctrl.rssi; p.ch = info->rx_ctrl.channel; p.n = (uint8_t)n;
  p.m = kc ? sum / kc : 0; p.d = d;
  csiKept++;
  portENTER_CRITICAL(&csiMux);
  CsiFeat& f = csiFeat[csiFeatN % CSI_FEAT_N];
  f.t = ms; f.r = p.rssi; f.m10 = (uint16_t)(p.m * 10.f); f.d1000 = (uint16_t)(d * 1000.f);
  csiFeatN++;
  portEXIT_CRITICAL(&csiMux);
  if (csiQ && xQueueSend(csiQ, &p, 0) != pdTRUE) csiDrop++;
}

static bool csiEnable() {
  if (!csiCfgDone) {
    wifi_csi_config_t c;
    memset(&c, 0, sizeof(c));
    c.lltf_en = true;            // 只取 L-LTF：固定 64 个子载波，兼容 11g/11n 所有包
    c.htltf_en = false;
    c.stbc_htltf2_en = false;
    c.ltf_merge_en = true;
    c.channel_filter_en = false; // 关闭平滑，保留人体引起的子载波细节
    c.manu_scale = false;
    c.shift = 0;
    esp_err_t e1 = esp_wifi_set_csi_config(&c);
    esp_err_t e2 = esp_wifi_set_csi_rx_cb(csiCb, nullptr);
    esp_err_t e3 = esp_wifi_set_csi(true);
    gCsiErr = (e1 != ESP_OK) ? (int)e1 : (e2 != ESP_OK) ? (int)e2 : (int)e3;
    if (gCsiErr) { logf("[csi] ❌ 启用失败 err=0x%x/0x%x/0x%x（固件的 SDK 可能没开 CONFIG_ESP32_WIFI_CSI_ENABLED）", (unsigned)e1, (unsigned)e2, (unsigned)e3); return false; }
    csiCfgDone = true;
    logf("[csi] ✅ CSI 已启用（L-LTF 64 子载波，≤%d 包/秒输出）", CSI_EMIT_HZ);
  }
  return true;
}

static void csiStopPing() {
  if (pingH) { esp_ping_stop(pingH); esp_ping_delete_session(pingH); pingH = nullptr; pingGw = 0; }
}

// STA 已连接：对网关高频 ping，让路由器持续回包 -> 每个回包产生一条 CSI
static void csiStartPing() {
  if (WiFi.status() != WL_CONNECTED) return;
  IPAddress g = WiFi.gatewayIP();
  uint32_t gw = (uint32_t)g;
  if (gw == 0) return;
  if (pingH && pingGw == gw) { gCsiMode = 1; return; }
  csiStopPing();
  if (!csiEnable()) return;
  ip_addr_t target;
  IP_ADDR4(&target, g[0], g[1], g[2], g[3]);
  esp_ping_config_t cfg = ESP_PING_DEFAULT_CONFIG();
  cfg.target_addr = target;
  cfg.count = ESP_PING_COUNT_INFINITE;
  cfg.interval_ms = 1000 / CSI_PING_HZ;
  cfg.timeout_ms = 1000;
  cfg.data_size = 16;
  esp_ping_callbacks_t cbs;
  memset(&cbs, 0, sizeof(cbs));
  if (esp_ping_new_session(&cfg, &cbs, &pingH) == ESP_OK && esp_ping_start(pingH) == ESP_OK) {
    pingGw = gw; gCsiMode = 1;
    logf("[csi] ping 网关 %s @%dHz 开始：路由器每个回包都会带一条 CSI", g.toString().c_str(), CSI_PING_HZ);
  } else { pingH = nullptr; logf("[csi] ❌ 无法启动对网关的 ping"); }
}

static void noopSniffer(void*, wifi_promiscuous_pkt_type_t) {}

// 被动模式：停在最强热点的信道上收包
static void csiPassiveBegin() {
  csiStopPing();
  WiFi.disconnect(false, false);
  WiFi.mode(WIFI_STA);
  delay(30);
  if (!csiEnable()) return;
  wifi_promiscuous_filter_t filt;
  filt.filter_mask = WIFI_PROMIS_FILTER_MASK_MGMT | WIFI_PROMIS_FILTER_MASK_DATA;
  esp_wifi_set_promiscuous_filter(&filt);
  esp_wifi_set_promiscuous_rx_cb(&noopSniffer);
  esp_wifi_set_promiscuous(true);
  esp_wifi_set_channel(gBestCh, WIFI_SECOND_CHAN_NONE);
  gCsiMode = 2;
}
static void csiPassiveEnd() {
  if (gCsiMode == 2) { esp_wifi_set_promiscuous(false); gCsiMode = 0; }
}

// 独立任务：把队列里的 CSI 包输出到串口
static void csiTask(void*) {
  CsiPkt p;
  char line[420];
  uint32_t rateT = millis(), rateRaw = 0;
  for (;;) {
    if (xQueueReceive(csiQ, &p, 200 / portTICK_PERIOD_MS) == pdTRUE) {
      char hex[130];
      static const char* H = "0123456789abcdef";
      for (int i = 0; i < p.n; i++) { hex[2 * i] = H[p.a[i] >> 4]; hex[2 * i + 1] = H[p.a[i] & 15]; }
      hex[2 * p.n] = 0;
      snprintf(line, sizeof(line), "{\"t\":%lu,\"r\":%d,\"c\":%u,\"m\":%.1f,\"d\":%.4f,\"a\":\"%s\"}", (unsigned long)p.t, (int)p.rssi, (unsigned)p.ch, p.m, p.d, hex);
      outLine("RADARCSI:", line);
    }
    uint32_t now = millis();
    if (now - rateT >= 1000) { gCsiRate = (int)(csiRaw - rateRaw); rateRaw = csiRaw; rateT = now; }
  }
}

// 把最近的 CSI 特征（≈10 秒）附加到上传的帧里：服务器/网页用同一套算法做存在/运动/呼吸检测
static void csiAppendSeries(String& body) {
  if (csiFeatN == 0 || body.length() < 2) return;
  CsiFeat tmp[CSI_FEAT_N];
  uint32_t n;
  portENTER_CRITICAL(&csiMux);
  n = csiFeatN;
  memcpy(tmp, csiFeat, sizeof(tmp));
  portEXIT_CRITICAL(&csiMux);
  uint32_t cnt = n < CSI_FEAT_N ? n : CSI_FEAT_N, start = n - cnt;
  body.remove(body.length() - 1);
  body += ",\"cs\":{\"now\":";
  body += String((unsigned long)millis());
  body += ",\"v\":[";
  for (uint32_t i = 0; i < cnt; i++) {
    const CsiFeat& f = tmp[(start + i) % CSI_FEAT_N];
    if (i) body += ",";
    char b[48];
    snprintf(b, sizeof(b), "[%lu,%d,%u,%u]", (unsigned long)f.t, (int)f.r, (unsigned)f.m10, (unsigned)f.d1000);
    body += b;
  }
  body += "]}}";
}
#endif  // ENABLE_CSI

static bool hasTopic();
static bool hasTarget();

// ---------------- WiFi 连接 / 上传（不阻塞：连不上就先放弃，30 秒后再试） ----------------
static bool wifiReady() {
  if (cfgSsid.length() == 0 || !hasTarget()) return false;
  if (WiFi.status() == WL_CONNECTED) return true;
  if (wifiTried && millis() - lastWifiTry < WIFI_RETRY_MS) return false;
  wifiTried = true;
  lastWifiTry = millis();
  gState = "wifi";
  WiFi.mode(WIFI_STA);
  WiFi.begin(cfgSsid.c_str(), cfgPass.c_str());
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < WIFI_CONNECT_MS) { delay(100); handleSerial(); }
  if (WiFi.status() == WL_CONNECTED) {
    logf("[wifi] connected ip=%s rssi=%d ch=%d", WiFi.localIP().toString().c_str(), WiFi.RSSI(), WiFi.channel());
    wifiTried = false;   // v4 修复：重试节流只针对“连接失败”；成功后（含嗅探断线后）必须能立刻重连
    return true;
  }
  logf("[wifi] connect timeout (检查 SSID/密码，必须是 2.4GHz)；%d 秒后重试，期间只做串口输出", WIFI_RETRY_MS / 1000);
  return false;
}

// ---------------- v4：从汇合点读取 Kaggle 最新网址 ----------------
static bool hasTopic() { return strlen(RADAR_TOPIC) > 0; }
static bool hasTarget() { return cfgUrl.length() > 0 || hasTopic(); }

// 读取 ntfy.sh/<topic> 最近 30 分钟内的消息，取时间最新的一条（Kaggle 每 4 分钟重发一次，所以始终有）
static bool resolveUrl() {
  lastResolve = millis();
  if (!hasTopic() || WiFi.status() != WL_CONNECTED) return false;
  String full = String("http://ntfy.sh/") + RADAR_TOPIC + "/json?poll=1&since=30m";
  String payload;
  int code = -1;
  for (int attempt = 0; attempt < 2 && code != 200; attempt++) {
    HTTPClient http;
    http.setTimeout(8000);
    if (attempt == 0) {
      WiFiClient c;
      if (!http.begin(c, full)) continue;
      code = http.GET();
      if (code == 200) payload = http.getString();
      http.end();
    } else {  // http 不通时改用 https
      WiFiClientSecure sc;
      sc.setInsecure();
      full.replace("http://", "https://");
      if (!http.begin(sc, full)) continue;
      code = http.GET();
      if (code == 200) payload = http.getString();
      http.end();
    }
  }
  gResolveCode = code;
  if (code != 200) {
    logf("[topic] 读取汇合点失败 HTTP %d (%s)：检查 ESP32 是否真的能上外网", code, HTTPClient::errorToString(code).c_str());
    return false;
  }
  String best = "";
  uint32_t bestT = 0;
  int pos = 0;
  while (pos < (int)payload.length()) {
    int nl = payload.indexOf('\n', pos);
    if (nl < 0) nl = payload.length();
    String line = payload.substring(pos, nl);
    pos = nl + 1;
    line.trim();
    if (line.length() < 10) continue;
    JsonDocument d;
    if (deserializeJson(d, line)) continue;
    if (String((const char*)(d["event"] | "")) != "message") continue;
    uint32_t t = d["time"] | 0;
    String m = String((const char*)(d["message"] | ""));
    m.trim();
    if (m.startsWith("http") && t >= bestT) { bestT = t; best = m; }
  }
  while (best.endsWith("/")) best.remove(best.length() - 1);
  if (best.length() == 0) {
    logf("[topic] 汇合点 '%s' 里还没有 Kaggle 发布的网址：请先在 Kaggle 运行脚本（它会自动发布）", RADAR_TOPIC);
    return false;
  }
  if (best != activeUrl) logf("[topic] ✅ 发现 Kaggle 最新网址：%s", best.c_str());
  activeUrl = best;
  everResolved = true;
  return true;
}

static int postFrame(const String& body) {
  String url = activeUrl + "/api/ingest";
  HTTPClient http;
  int code = -1;
  if (activeUrl.startsWith("https://")) {
    WiFiClientSecure client;
    client.setInsecure();  // 隧道证书由 Cloudflare 签发；此处不校验证书链，数据本身不含隐私密钥
    if (!http.begin(client, url)) return -1;
    http.setTimeout(9000);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("X-Key", cfgKey);
    code = http.POST((uint8_t*)body.c_str(), body.length());
    http.end();
  } else {
    WiFiClient client;
    if (!http.begin(client, url)) return -1;
    http.setTimeout(9000);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("X-Key", cfgKey);
    code = http.POST((uint8_t*)body.c_str(), body.length());
    http.end();
  }
  return code;
}

// ---------------- 扫描并组帧 ----------------
static String buildFrame(bool includeSta, int& apCount) {
  JsonDocument doc;
  doc["v"] = 1;
  doc["node"] = nodeId;
  doc["seq"] = ++seqNo;
  doc["up"] = millis() / 1000;
  doc["x"] = NODE_X;
  doc["y"] = NODE_Y;
  doc["fw"] = FW_VERSION;
  JsonArray aps = doc["aps"].to<JsonArray>();
  uint32_t t0 = millis();
  int n = WiFi.scanNetworks(false, true, false, SCAN_MS_PER_CH);
  if (n < 0) {                    // 扫描失败（嗅探刚结束时偶发）：复位射频后重试一次
    WiFi.scanDelete();
    WiFi.disconnect(false, false);
    WiFi.mode(WIFI_OFF);
    delay(50);
    WiFi.mode(WIFI_STA);
    delay(50);
    n = WiFi.scanNetworks(false, true, false, SCAN_MS_PER_CH);
  }
  gScanMs = millis() - t0;
  doc["ms"] = gScanMs;
  if (n < 0) doc["err"] = n;
  apCount = 0;
  if (n > 0) {
    for (int i = 0; i < n && apCount < MAX_APS; i++) {
      JsonObject o = aps.add<JsonObject>();
      o["b"] = WiFi.BSSIDstr(i);
      o["s"] = WiFi.SSID(i);
      o["r"] = WiFi.RSSI(i);
      o["c"] = WiFi.channel(i);
      o["a"] = (int)WiFi.encryptionType(i);
      apCount++;
    }
  }
#if ENABLE_CSI
  { int bestR = -127; for (int i = 0; i < n; i++) if (WiFi.RSSI(i) > bestR && WiFi.channel(i) >= 1 && WiFi.channel(i) <= 14) { bestR = WiFi.RSSI(i); gBestCh = WiFi.channel(i); } }
#endif
  WiFi.scanDelete();
  if (includeSta) {
    JsonArray st = doc["st"].to<JsonArray>();
    portENTER_CRITICAL(&staMux);
    for (int i = 0; i < staCount; i++) {
      JsonObject o = st.add<JsonObject>();
      o["m"] = macStr(stas[i].mac);
      o["r"] = stas[i].rssi;
      o["c"] = stas[i].ch;
      o["n"] = stas[i].cnt;
      if (stas[i].hasBssid) o["b"] = macStr(stas[i].bssid);
    }
    portEXIT_CRITICAL(&staMux);
  }
  String out;
  serializeJson(doc, out);
  return out;
}

// ---------------- 心跳任务：独立于主循环，扫描/连 WiFi 期间也每秒一行 ----------------
static void hbTask(void*) {
  for (;;) {
    vTaskDelay(HEARTBEAT_MS / portTICK_PERIOD_MS);
    char b[460];
    snprintf(b, sizeof(b),
             "{\"fw\":\"%s\",\"node\":\"%s\",\"up\":%lu,\"st\":\"%s\",\"cyc\":%lu,\"seq\":%lu,\"aps\":%d,\"scanms\":%lu,"
             "\"ok\":%lu,\"fail\":%lu,\"http\":%d,\"heap\":%lu,\"wifi\":%d,\"rssi\":%d,\"csi\":%lu,\"csir\":%d,\"csim\":%d,\"csie\":%d,\"csid\":%lu}",
             FW_VERSION, nodeId.c_str(), (unsigned long)(millis() / 1000), (const char*)gState, (unsigned long)cycleNo,
             (unsigned long)seqNo, (int)gLastAps, (unsigned long)gScanMs, (unsigned long)okCount, (unsigned long)failCount,
             (int)gLastHttp, (unsigned long)ESP.getFreeHeap(), (int)WiFi.status(),
             WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0,
#if ENABLE_CSI
             (unsigned long)csiRaw, (int)gCsiRate, (int)gCsiMode, (int)gCsiErr, (unsigned long)csiDrop);
#else
             0UL, 0, 0, 0, 0UL);
#endif
    outLine("RADARHB:", b);
  }
}

void setup() {
  outMux = xSemaphoreCreateMutex();
#if HAS_USB_PORT
  Serial.setTxBufferSize(8192);     // 一帧 RADARJSON 可达 6KB：给足发送缓冲，避免电脑端来不及读时丢字节
  Serial.begin(115200);             // 原生 USB：波特率无意义
  Serial.setTxTimeoutMs(300);       // 仅在电脑已打开串口、但读得慢时才会等待；没人读取时 HWCDC 会直接丢弃，不阻塞
#endif
  UART_SER.begin(SERIAL_BAUD);
  delay(250);
  led(32, 0, 0);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  String mac = WiFi.macAddress();
  mac.replace(":", "");
  nodeId = "S3-" + mac.substring(6);
  loadConfig();
  logf("");
  logf("=====================================");
  logf(" ESP32-S3 WiFi Radar v%s  (reset: %s)", FW_VERSION, resetReason());
  logf("=====================================");
  logf("[port] USB原生口=%s  UART口=%s", HAS_USB_PORT ? "输出" : "无(未启用CDC)", (HAS_USB_PORT == 0 || MIRROR_UART_PORT) ? "输出" : "关闭");
  showConfig();
  if (cfgSsid.length() == 0) logf("[info] 未配置 WiFi：只做串口输出（网页 USB 直连 / tools/serial_bridge.py 转发）");
  else if (!hasTarget()) logf("[info] 未配置 SERVER_URL/RADAR_TOPIC：只做串口输出");
  else logf("[info] 自动发现网址：汇合点 ntfy.sh/%s（Kaggle 重开后网址变化也不用重新烧录）", RADAR_TOPIC);
  sendHello();
#if ENABLE_CSI
  csiQ = xQueueCreate(CSI_QUEUE_LEN, sizeof(CsiPkt));
  xTaskCreatePinnedToCore(csiTask, "csi", 6144, nullptr, 2, nullptr, 0);
  logf("[csi] 已开启 CSI 感知：%s", cfgSsid.length() ? "已配置 WiFi -> 连上后对网关 ping，取路由器回包的 CSI" : "未配置 WiFi -> 被动模式（实验）；要稳定的 CSI 请在 config.h 填 WIFI_SSID/WIFI_PASS");
#endif
  xTaskCreatePinnedToCore(hbTask, "hb", 4096, nullptr, 1, nullptr, 0);
  logf("[boot] 开始扫描…（第一帧约 2 秒内）");
  led(0, 0, 40);
}

void loop() {
  handleSerial();
  uint32_t t0 = millis();
  int sniffEvery = SNIFF_EVERY;
#if ENABLE_CSI
  if (WiFi.status() == WL_CONNECTED) sniffEvery = SNIFF_EVERY_CSI;   // CSI 模式下少断线：嗅探会中断 CSI
#endif
  bool doSniff = ENABLE_SNIFF && cycleNo > 0 && (cycleNo % sniffEvery == 0);
  if (doSniff) sniffRound();
  int apCount = 0;
  gState = "scan";
  led(0, 20, 40);
  String body = buildFrame(doSniff, apCount);
  gLastAps = apCount;
  gState = "emit";
  logf("[scan] #%u aps=%d scan=%ums%s", (unsigned)seqNo, apCount, (unsigned)gScanMs, doSniff ? "" : "");
  if (doSniff) logf("[sniff] stations=%d", (int)staCount);
  outLine("RADARJSON:", body.c_str());   // 先从串口输出，再尝试联网：联网失败不影响 3D 显示

  if (millis() - lastHello > HELLO_EVERY_MS) sendHello();
  bool wifiUp = wifiReady();
#if ENABLE_CSI
  if (wifiUp) csiStartPing();
#endif
  if (wifiUp) {
    // 取得服务器网址：优先用汇合点上 Kaggle 发布的最新网址，其次用 config.h 的 SERVER_URL
    if (hasTopic() && (!everResolved ? (lastResolve == 0 || millis() - lastResolve > 15000) : (millis() - lastResolve > TOPIC_REFRESH_MS || (consecFail >= 3 && millis() - lastResolve > 20000)))) {
      gState = "resolve";
      bool ok = resolveUrl();
      consecFail = 0;
      if (!ok && activeUrl.length() == 0) activeUrl = cfgUrl;
    }
    if (activeUrl.length() == 0) activeUrl = cfgUrl;
    if (activeUrl.length() == 0) {
      logf("[upload] 没有可用的服务器网址（汇合点里还没有，config.h 的 SERVER_URL 也没填）。USB 直连不受影响");
      gLastHttp = -100;
    } else {
      gState = "upload";
      String upBody = body;
#if ENABLE_CSI
      csiAppendSeries(upBody);   // 上传时附带最近 ≈10 秒的 CSI 特征序列
#endif
      int code = postFrame(upBody);
      gLastHttp = code;
      if (code >= 200 && code < 300) { okCount++; consecFail = 0; led(0, 40, 0); }
      else { failCount++; consecFail++; led(40, 10, 0); }
      if (code >= 200 && code < 300) logf("[upload] HTTP %d ✅ -> %s (ok=%u fail=%u)", code, activeUrl.c_str(), (unsigned)okCount, (unsigned)failCount);
      else if (code == 401) logf("[upload] HTTP 401：API_KEY 与 Kaggle 脚本不一致 (ok=%u fail=%u)", (unsigned)okCount, (unsigned)failCount);
      else logf("[upload] HTTP %d (%s) -> %s：网址可能已过期/Kaggle 已停，将重新读取汇合点 (ok=%u fail=%u)", code, HTTPClient::errorToString(code).c_str(), activeUrl.c_str(), (unsigned)okCount, (unsigned)failCount);
    }
  } else if (cfgSsid.length() && hasTarget()) {
    led(40, 0, 0);
  }
  cycleNo++;
  gState = "idle";
  uint32_t period = SCAN_PERIOD_MS;
#if ENABLE_CSI
  if (WiFi.status() == WL_CONNECTED) period = CSI_SCAN_PERIOD_MS;            // 已连路由器：长间隔，让 CSI 连续流动
  else {                                                                      // 没连上：被动 CSI 监听一段时间
    csiPassiveBegin();
    gState = "csi";
    uint32_t until2 = millis() + CSI_PASSIVE_MS;
    while ((int32_t)(until2 - millis()) > 0) { handleSerial(); delay(20); }
    csiPassiveEnd();
  }
#endif
  uint32_t used = millis() - t0;
  if (used < period) {
    uint32_t until = millis() + (period - used);
    while ((int32_t)(until - millis()) > 0) { handleSerial(); delay(20); }
  }
}
