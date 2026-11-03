#pragma once
// ============================================================
//  ESP32-S3 WiFi Radar 配置文件
//  只用「USB 直连」模式（推荐）时：什么都不用改，直接烧录即可。
//  想让 ESP32 自己联网上传到 Kaggle 时，才需要改下面 4 行。
// ============================================================

// 1) 你家/手机热点的 WiFi（ESP32 用它联网，把扫描结果上传到 Kaggle）。仅支持 2.4GHz。
#define WIFI_SSID "YOUR_WIFI_SSID"
#define WIFI_PASS "YOUR_WIFI_PASSWORD"

// 2) Kaggle 运行后打印出来的网址（https://xxxx.trycloudflare.com），末尾不要加 /
#define SERVER_URL "https://YOUR-TUNNEL.trycloudflare.com"

// 3) 上传密钥，必须和 Kaggle 脚本里的 API_KEY 一致
#define API_KEY "radar-key"

// ------------------ 以下一般不用改 ------------------
// 本节点在世界坐标中的位置(米)。单节点保持 0,0；多个 ESP32 做三边定位时分别填写，+Y 方向视为正北。
#define NODE_X 0.0f
#define NODE_Y 0.0f

#define SERIAL_BAUD 115200    // UART 口波特率（原生 USB 口不受影响）
#define MIRROR_UART_PORT 1    // 1=同时往 UART0(CH340/CP2102 口)也输出；只用原生 USB 口且想更快时可设 0
#define HEARTBEAT_MS 1000     // 心跳行 RADARHB 的间隔：网页靠它判断“固件活着/在干什么”
#define HELLO_EVERY_MS 10000  // 重复发送 RADARHELLO（设备信息）的间隔

#define SCAN_PERIOD_MS 1500   // 两轮扫描之间的间隔
#define SCAN_MS_PER_CH 120    // 每个信道主动扫描停留时间(毫秒)
#define MAX_APS 60            // 每帧最多上传多少个 AP
#define WIFI_CONNECT_MS 8000  // 每次连接 WiFi 最多等待多久
#define WIFI_RETRY_MS 30000   // 连不上时，隔多久再重试（期间不阻塞扫描与串口输出）

// 周围设备(手机/电脑等)嗅探：需要暂时断开 WiFi，在 1~13 信道轮流监听
#define ENABLE_SNIFF 1        // 1=开启, 0=关闭
#define SNIFF_EVERY 4         // 每 N 轮扫描做一次嗅探（第 1 轮不嗅探，保证最快出第一帧）
#define SNIFF_DWELL_MS 160    // 每个信道监听时间(毫秒)
#define SNIFF_MAX_CH 13       // 国内 13，美国 11
#define MAX_STATIONS 64

// 1：每次重新烧录，以本文件的 WIFI/URL/KEY 为准(覆盖之前用串口命令保存的值)
#define CONFIG_FROM_HEADER 1
