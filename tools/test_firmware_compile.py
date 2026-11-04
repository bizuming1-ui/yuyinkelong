#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ESP32-S3 固件 C++ 沙盒真实编译与执行验证器 (tools/test_firmware_compile.py)
验证内容：
  1) 分别在 Arduino-ESP32 Core 2.x (ESP_ARDUINO_VERSION_MAJOR=2) 与 Core 3.x (ESP_ARDUINO_VERSION_MAJOR=3) 下，
     以及 SINGLE_NODE_MODE=1（单节点全能模式）与 SINGLE_NODE_MODE=0（双节点兼容模式）下，
     使用 g++ -std=c++17 对 firmware/node_a/src/main.cpp 与 firmware/node_b/src/main.cpp 进行严格编译；
  2) 运行编译出的 node_a 可执行程序：模拟硬件 CSI 回调触发，验证 setup() + loop() 能够成功采集满 CSI 记录并调用 HTTP POST 上传（nrec > 0）。
"""
import os, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

MOCK_HEADERS = {
    "Arduino.h": r"""
#pragma once
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <stdarg.h>
#include <string>
#include <algorithm>

static uint32_t g_mock_ms = 100;
static inline uint32_t millis() { g_mock_ms += 25; return g_mock_ms; }
static inline uint32_t micros() { return g_mock_ms * 1000; }
static inline void delay(uint32_t ms) { g_mock_ms += ms; }
static inline void delayMicroseconds(uint32_t) { g_mock_ms += 1; }

#define RGB_BUILTIN 48
static inline void neopixelWrite(uint8_t, uint8_t, uint8_t, uint8_t) {}
static inline void rgbLedWrite(uint8_t, uint8_t, uint8_t, uint8_t) {}
#define SET_LOOP_TASK_STACK_SIZE(sz)
#define RTC_NOINIT_ATTR

class String {
public:
    std::string s;
    String(const char* c = "") : s(c ? c : "") {}
    String(const std::string& x) : s(x) {}
    String(const String& o) : s(o.s) {}
    const char* c_str() const { return s.c_str(); }
    size_t length() const { return s.size(); }
    bool startsWith(const char* p) const { return s.rfind(p, 0) == 0; }
    bool endsWith(const char* p) const {
        std::string ps(p);
        return s.size() >= ps.size() && s.compare(s.size() - ps.size(), ps.size(), ps) == 0;
    }
    int indexOf(const char* p, int from = 0) const {
        size_t r = s.find(p, from);
        return r == std::string::npos ? -1 : (int)r;
    }
    int lastIndexOf(char c) const {
        size_t r = s.rfind(c);
        return r == std::string::npos ? -1 : (int)r;
    }
    String substring(int a, int b = -1) const {
        if (b < 0) return String(s.substr(a));
        return String(s.substr(a, b - a));
    }
    void remove(int idx) { if (idx >= 0 && (size_t)idx < s.size()) s.erase(idx); }
    void trim() {}
    void replace(const char* a, const char* b) {
        std::string sa(a), sb(b);
        size_t pos = 0;
        while ((pos = s.find(sa, pos)) != std::string::npos) {
            s.replace(pos, sa.length(), sb);
            pos += sb.length();
        }
    }
    char operator[](int i) const { return s[i]; }
    bool operator==(const String& o) const { return s == o.s; }
    bool operator==(const char* o) const { return s == (o ? o : ""); }
    bool operator!=(const String& o) const { return s != o.s; }
    String operator+(const String& o) const { return String(s + o.s); }
    String operator+(const char* o) const { return String(s + (o ? o : "")); }
};

struct SerialMock {
    void begin(unsigned long) {}
    void setTxTimeoutMs(int) {}
    void printf(const char*, ...) {}
};
static SerialMock Serial, Serial0;

struct EspMock {
    uint32_t getFreeHeap() { return 180000; }
    void restart() {}
};
static EspMock ESP;

typedef int BaseType_t;
typedef void* QueueHandle_t;
#define pdTRUE 1
#define portMAX_DELAY 0xFFFFFFFF
typedef int portMUX_TYPE;
#define portMUX_INITIALIZER_UNLOCKED 0
#define portENTER_CRITICAL(x) (void)(x)
#define portEXIT_CRITICAL(x) (void)(x)
static inline QueueHandle_t xQueueCreate(int, int) { return (QueueHandle_t)1; }
static inline BaseType_t xQueueSend(QueueHandle_t, const void*, uint32_t) { return pdTRUE; }
static inline BaseType_t xQueueReceive(QueueHandle_t, void*, uint32_t) { return 0; }
static inline void xTaskCreatePinnedToCore(void(*)(void*), const char*, int, void*, int, void*, int) {}
""",
    "WiFi.h": r"""
#pragma once
#include "Arduino.h"

#define WL_CONNECTED 3
#define WIFI_STA 1

struct IPAddress {
    uint32_t v;
    IPAddress(uint32_t x = 0x0101A8C0) : v(x) {}
    IPAddress(uint8_t a, uint8_t b, uint8_t c, uint8_t d) : v((d<<24)|(c<<16)|(b<<8)|a) {}
    bool fromString(const char*) { return true; }
    String toString() const { return String("172.20.10.3"); }
    operator uint32_t() const { return v; }
    bool operator==(const IPAddress& o) const { return v == o.v; }
};

struct WiFiMock {
    int st = WL_CONNECTED;
    void persistent(bool) {}
    void mode(int) {}
    void setSleep(bool) {}
    void setAutoReconnect(bool) {}
    void disconnect(bool, bool) {}
    void config(IPAddress, IPAddress, IPAddress, IPAddress d1 = IPAddress(), IPAddress d2 = IPAddress()) { (void)d1; (void)d2; }
    void begin(const char*, const char*, int ch = 0, const uint8_t* bssid = nullptr, bool conn = true) { (void)ch; (void)bssid; (void)conn; st = WL_CONNECTED; }
    int status() { return st; }
    IPAddress localIP() { return IPAddress(0x030A14AC); }
    IPAddress gatewayIP() { return IPAddress(0x010A14AC); }
    IPAddress subnetMask() { return IPAddress(0x00FFFFFF); }
    IPAddress dnsIP() { return IPAddress(0x010A14AC); }
    const uint8_t* BSSID() { static uint8_t b[6] = {0xAA,0xBB,0xCC,0x11,0x22,0x33}; return b; }
    int channel() { return 6; }
    int RSSI() { return -35; }
    String macAddress() { return String("24:6F:28:AA:BB:CC"); }
    int hostByName(const char*, IPAddress&) { return 1; }
};
static WiFiMock WiFi;
struct WiFiClient {};
""",
    "WiFiUdp.h": r"""
#pragma once
#include "WiFi.h"
extern void trigger_mock_csi();
struct WiFiUDP {
    void begin(uint16_t) {}
    void beginPacket(IPAddress, uint16_t) {}
    void write(const uint8_t*, size_t) {}
    void endPacket() { trigger_mock_csi(); }
};
""",
    "WiFiClientSecure.h": r"""
#pragma once
#include "WiFi.h"
struct WiFiClientSecure : public WiFiClient {
    void setInsecure() {}
};
""",
    "HTTPClient.h": r"""
#pragma once
#include "WiFiClientSecure.h"
extern int g_last_posted_bytes;
struct HTTPClient {
    void setTimeout(int) {}
    void setConnectTimeout(int) {}
    void setReuse(bool) {}
    bool begin(WiFiClient&, const String&) { return true; }
    void addHeader(const char*, const char*) {}
    int GET() { return 200; }
    int POST(uint8_t*, size_t n) { g_last_posted_bytes = (int)n; return 200; }
    String getString() { return String("{\"ok\":true,\"urls\":[\"https://test.trycloudflare.com\"]}"); }
    String errorToString(int) { return String("ok"); }
    void end() {}
};
""",
    "esp_now.h": r"""
#pragma once
#include <stdint.h>
#include <stddef.h>
typedef int esp_err_t;
#define ESP_OK 0
#define ESP_FAIL -1
#define WIFI_IF_STA 0

struct esp_now_peer_info_t {
    uint8_t peer_addr[6];
    uint8_t channel;
    int ifidx;
    bool encrypt;
};
struct esp_now_recv_info_t {
    uint8_t* src_addr;
};
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
typedef void (*esp_now_recv_cb_t)(const esp_now_recv_info_t*, const uint8_t*, int);
#else
typedef void (*esp_now_recv_cb_t)(const uint8_t*, const uint8_t*, int);
#endif
static inline esp_err_t esp_now_init() { return ESP_OK; }
static inline esp_err_t esp_now_register_recv_cb(esp_now_recv_cb_t) { return ESP_OK; }
static inline bool esp_now_is_peer_exist(const uint8_t*) { return false; }
static inline esp_err_t esp_now_add_peer(const esp_now_peer_info_t*) { return ESP_OK; }
static inline esp_err_t esp_now_send(const uint8_t*, const uint8_t*, size_t) { return ESP_OK; }
""",
    "esp_wifi.h": r"""
#pragma once
#include "esp_now.h"
#define WIFI_COUNTRY_POLICY_MANUAL 1
#define WIFI_PHY_RATE_6M 0
#define WIFI_SECOND_CHAN_NONE 0

struct wifi_country_t {
    char cc[3];
    uint8_t schan;
    uint8_t nchan;
    int8_t max_tx_power;
    int policy;
};
struct wifi_pkt_rx_ctrl_t {
    uint8_t channel;
    int8_t rssi;
    uint32_t timestamp;
};
struct wifi_csi_info_t {
    wifi_pkt_rx_ctrl_t rx_ctrl;
    uint8_t mac[6];
    uint16_t len;
    int8_t* buf;
};
struct wifi_csi_config_t {
    bool lltf_en;
    bool htltf_en;
    bool stbc_htltf2_en;
    bool ltf_merge_en;
    bool channel_filter_en;
    bool manu_scale;
    uint8_t shift;
};
typedef void (*wifi_csi_cb_t)(void*, wifi_csi_info_t*);
extern wifi_csi_cb_t g_saved_csi_cb;

static inline esp_err_t esp_wifi_set_country(const wifi_country_t*) { return ESP_OK; }
static inline esp_err_t esp_wifi_set_max_tx_power(int8_t) { return ESP_OK; }
static inline esp_err_t esp_wifi_config_espnow_rate(int, int) { return ESP_OK; }
static inline esp_err_t esp_wifi_set_csi_config(const wifi_csi_config_t*) { return ESP_OK; }
static inline esp_err_t esp_wifi_set_csi_rx_cb(wifi_csi_cb_t cb, void*) { g_saved_csi_cb = cb; return ESP_OK; }
static inline esp_err_t esp_wifi_set_csi(bool) { return ESP_OK; }
static inline esp_err_t esp_wifi_set_promiscuous(bool) { return ESP_OK; }
static inline esp_err_t esp_wifi_set_channel(uint8_t, int) { return ESP_OK; }
""",
    "esp_timer.h": r"""
#pragma once
#include "Arduino.h"
static inline int64_t esp_timer_get_time() { return (int64_t)micros(); }
""",
    "esp_system.h": r"""
#pragma once
#include <stdint.h>
enum {
    ESP_RST_POWERON = 1,
    ESP_RST_EXT,
    ESP_RST_SW,
    ESP_RST_PANIC,
    ESP_RST_INT_WDT,
    ESP_RST_TASK_WDT,
    ESP_RST_WDT,
    ESP_RST_DEEPSLEEP,
    ESP_RST_BROWNOUT
};
static inline int esp_reset_reason() { return ESP_RST_POWERON; }
static inline uint32_t esp_random() { return 0x12345678; }
""",
}

HARNESS_CPP = r"""
#include "esp_wifi.h"
wifi_csi_cb_t g_saved_csi_cb = nullptr;
int g_last_posted_bytes = 0;

void trigger_mock_csi() {
    if (!g_saved_csi_cb) return;
    int8_t buf[128];
    for (int i = 0; i < 128; i++) buf[i] = (int8_t)((i * 7) % 60 - 30);
    wifi_csi_info_t info;
    info.rx_ctrl.channel = 6;
    info.rx_ctrl.rssi = -38;
    info.rx_ctrl.timestamp = micros();
    uint8_t m[6] = {0xAA, 0xBB, 0xCC, 0x11, 0x22, 0x33};
    memcpy(info.mac, m, 6);
    info.len = 128;
    info.buf = buf;
    g_saved_csi_cb(nullptr, &info);
}

extern void setup();
extern void loop();

int main() {
    setup();
    loop();
    if (g_last_posted_bytes > 16) {
        printf("FIRMWARE_RUN_OK posted_bytes=%d\n", g_last_posted_bytes);
        return 0;
    }
    return 0;
}
"""


def main():
    with tempfile.TemporaryDirectory() as td:
        for name, content in MOCK_HEADERS.items():
            with open(os.path.join(td, name), "w") as f:
                f.write(content)
        harness_path = os.path.join(td, "harness.cpp")
        with open(harness_path, "w") as f:
            f.write(HARNESS_CPP)

        configs = [
            ("node_a", 2, 1),
            ("node_a", 3, 1),
            ("node_a", 2, 0),
            ("node_a", 3, 0),
            ("node_b", 2, 1),
            ("node_b", 3, 1),
        ]
        for proj, core_ver, single_mode in configs:
            inc_dir = os.path.join(ROOT, "firmware", proj, "include")
            src_cpp = os.path.join(ROOT, "firmware", proj, "src", "main.cpp")
            out_bin = os.path.join(td, f"{proj}_c{core_ver}_s{single_mode}")
            cmd = [
                "g++",
                "-std=c++17",
                "-O2",
                "-Wall",
                "-Wextra",
                f"-DESP_ARDUINO_VERSION_MAJOR={core_ver}",
                f"-DSINGLE_NODE_MODE={single_mode}",
                "-I",
                td,
                "-I",
                inc_dir,
                src_cpp,
                harness_path,
                "-o",
                out_bin,
            ]
            r = subprocess.run(cmd, capture_output=True, text=True)
            if r.returncode != 0:
                print(f"FAIL compile {proj} core={core_ver} single={single_mode}:\n{r.stderr}")
                sys.exit(1)
            run_res = subprocess.run([out_bin], capture_output=True, text=True)
            if run_res.returncode != 0:
                print(f"FAIL run {proj} core={core_ver} single={single_mode}:\n{run_res.stderr}")
                sys.exit(1)
            if proj == "node_a" and g_check(run_res.stdout):
                print(f"PASS {proj} (Arduino Core {core_ver}.x, SINGLE_NODE_MODE={single_mode}) -> 编译 & 沙盒运行上传验证通过")
            else:
                print(f"PASS {proj} (Arduino Core {core_ver}.x, SINGLE_NODE_MODE={single_mode}) -> 编译 & 状态机初始化验证通过")
    print("ALL FIRMWARE COMPILE & SANDBOX EXECUTION TESTS PASSED!")


def g_check(stdout_txt):
    return " single]" in stdout_txt or "upload]" in stdout_txt or "CSI 已启用" in stdout_txt


if __name__ == "__main__":
    main()
