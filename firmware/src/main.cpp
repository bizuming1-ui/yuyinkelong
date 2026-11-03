// ESP32-S3 WiFi Radar 固件
// 流程：上电/复位 -> 扫描周围 AP(SSID/BSSID/RSSI/信道/加密) -> 周期性嗅探周围设备
//       -> 连接 WiFi -> HTTPS POST 到 Kaggle 的 /api/ingest -> 同时从串口输出 RADARJSON 行
// 串口命令(115200)：help / show / ssid <x> / pass <x> / url <x> / key <x> / clear / reboot
#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include "esp_wifi.h"
#include "config.h"

#define FW_VERSION "1.0.0"

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
  Serial.printf("[cfg] node=%s ssid='%s' pass=%s url='%s' key=%s\n", nodeId.c_str(), cfgSsid.c_str(),
                cfgPass.length() ? "****" : "(empty)", cfgUrl.c_str(), cfgKey.c_str());
}

static void handleSerial() {
  static String line;
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\r') continue;
    if (c != '\n') { if (line.length() < 200) line += c; continue; }
    line.trim();
    String cmd = line, arg = "";
    int sp = line.indexOf(' ');
    if (sp > 0) { cmd = line.substring(0, sp); arg = line.substring(sp + 1); arg.trim(); }
    cmd.toLowerCase();
    if (cmd == "ssid") { prefs.putString("ssid", arg); cfgSsid = arg; Serial.println("[cfg] ssid saved"); }
    else if (cmd == "pass") { prefs.putString("pass", arg); cfgPass = arg; Serial.println("[cfg] pass saved"); }
    else if (cmd == "url") {
      while (arg.endsWith("/")) arg.remove(arg.length() - 1);
      prefs.putString("url", arg); cfgUrl = arg; Serial.println("[cfg] url saved");
    }
    else if (cmd == "key") { prefs.putString("key", arg); cfgKey = arg; Serial.println("[cfg] key saved"); }
    else if (cmd == "clear") { prefs.clear(); Serial.println("[cfg] cleared, rebooting"); delay(300); ESP.restart(); }
    else if (cmd == "reboot") { ESP.restart(); }
    else if (cmd == "show") { showConfig(); }
    else if (cmd == "help") { Serial.println("[cmd] show | ssid <x> | pass <x> | url <x> | key <x> | clear | reboot"); }
    else if (cmd.length()) { Serial.println("[cmd] unknown, type help"); }
    line = "";
  }
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

static void sniffRound() {
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

// ---------------- WiFi 连接 / 上传 ----------------
static bool ensureWifi(uint32_t timeoutMs) {
  if (cfgSsid.length() == 0) return false;
  if (WiFi.status() == WL_CONNECTED) return true;
  WiFi.mode(WIFI_STA);
  WiFi.begin(cfgSsid.c_str(), cfgPass.c_str());
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < timeoutMs) { delay(150); handleSerial(); }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("[wifi] connected ip=%s rssi=%d ch=%d\n", WiFi.localIP().toString().c_str(), WiFi.RSSI(), WiFi.channel());
    return true;
  }
  Serial.println("[wifi] connect timeout (检查 SSID/密码，必须是 2.4GHz)");
  return false;
}

static int postFrame(const String& body) {
  String url = cfgUrl + "/api/ingest";
  HTTPClient http;
  int code = -1;
  if (cfgUrl.startsWith("https://")) {
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
  int n = WiFi.scanNetworks(false, true, false, SCAN_MS_PER_CH);
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

void setup() {
  Serial.begin(115200);
  delay(1200);
  led(32, 0, 0);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  String mac = WiFi.macAddress();
  mac.replace(":", "");
  nodeId = "S3-" + mac.substring(6);
  loadConfig();
  Serial.println();
  Serial.println("=====================================");
  Serial.println(" ESP32-S3 WiFi Radar v" FW_VERSION);
  Serial.println("=====================================");
  showConfig();
  if (cfgSsid.length() == 0) Serial.println("[warn] 未配置 WiFi：只做串口输出(可配合 tools/serial_bridge.py 上传)");
  else if (cfgUrl.length() == 0) Serial.println("[warn] 未配置 SERVER_URL：只做串口输出");
  Serial.println("[boot] 开始扫描…");
  led(0, 0, 40);
}

void loop() {
  handleSerial();
  uint32_t t0 = millis();
  bool doSniff = ENABLE_SNIFF && (cycleNo % SNIFF_EVERY == 0);
  if (doSniff) sniffRound();
  int apCount = 0;
  led(0, 20, 40);
  String body = buildFrame(doSniff, apCount);
  Serial.printf("[scan] #%u aps=%d%s\n", (unsigned)seqNo, apCount, doSniff ? "" : "");
  if (doSniff) Serial.printf("[sniff] stations=%d\n", (int)staCount);
  Serial.print("RADARJSON:");
  Serial.println(body);

  if (cfgSsid.length() && cfgUrl.length()) {
    if (ensureWifi(10000)) {
      int code = postFrame(body);
      if (code >= 200 && code < 300) { okCount++; led(0, 40, 0); }
      else { failCount++; led(40, 10, 0); }
      Serial.printf("[upload] HTTP %d (ok=%u fail=%u)\n", code, (unsigned)okCount, (unsigned)failCount);
    } else {
      failCount++;
      led(40, 0, 0);
    }
  }
  cycleNo++;
  uint32_t used = millis() - t0;
  if (used < SCAN_PERIOD_MS) {
    uint32_t until = millis() + (SCAN_PERIOD_MS - used);
    while ((int32_t)(until - millis()) > 0) { handleSerial(); delay(20); }
  }
}
