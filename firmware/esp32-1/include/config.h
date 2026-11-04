#pragma once
// ============================================================================
//  ESP32-S3 双节点 WiFi CSI 雷达 · 配置文件（ESP32-1 与 ESP32-2 的唯一区别就是 NODE_ID）
//  ★ ESP32-1：NODE_ID 1（主节点，负责发起 13 信道扫频）
//  ★ ESP32-2：NODE_ID 2（从节点，跟随主节点跳频）
// ============================================================================

#define NODE_ID 1                       // ← 烧 ESP32-1 写 1；烧 ESP32-2 写 2

// ---------------- WiFi（两个节点必须连同一个 2.4GHz 路由器/手机热点） ----------------
#define WIFI_SSID  "YOUR_WIFI_NAME"      // ← 改成你的 2.4GHz WiFi 名称
#define WIFI_PASS  "YOUR_WIFI_PASSWORD"  // ← 改成密码
#define WIFI2_SSID ""                    // 备用 WiFi（可留空）
#define WIFI2_PASS ""

// ---------------- MQTT（浏览器模拟器和两块 ESP32 用同一个主题根，不用 USB 也能互通） ----------------
// 主题根必须和浏览器模拟器「连接 ESP32」窗口里显示的一致（默认值已一致）。
#define MQTT_ROOT "bzm-csi/s3r-7f3a9c2e"
// 公共 MQTT 服务器列表：第一个连不上自动换下一个；浏览器同时连接这三个，所以无论 ESP32 走哪个都能收到。
// 实测：EMQX 公共服务器对单个连接限流约 10 条消息/秒，HiveMQ 可到 40+ 条/秒，所以 HiveMQ 放第一；
// 同时固件把发布频率限制在 ≤7.7 条/秒、每条合并多帧 CSI，任何服务器都不会因限流丢数据。
#define MQTT_BROKER_COUNT 3
#define MQTT_BROKERS { {"broker.hivemq.com", 1883}, {"broker.emqx.io", 1883}, {"test.mosquitto.org", 1883} }
#define MQTT_KEEPALIVE_S 20

// ---------------- CSI 采集 ----------------
#define PROBE_HZ           50            // 两节点之间互发 ESP-NOW 探测帧频率（每个节点每秒发多少帧）
#define AP_CSI_MAX_HZ       5            // 路由器信标 CSI 的最大上报频率
#define BATCH_MAX          14            // 每个 MQTT 包最多合并几条 CSI（14 条 ≈ 1.9KB）
#define BATCH_MAX_AGE_MS  100            // 最长等待多久必须发出
#define PUBLISH_MIN_MS    130            // 两次发布的最小间隔（≈7.7 条/秒，低于公共服务器限流）

// ---------------- 多信道拼接（扫频）：1..13 信道，拼出约 76MHz 合成带宽 ----------------
#define SWEEP_ENABLE        1            // 1 = 开启；0 = 只在路由器信道工作（最稳，但只有 20MHz 带宽）
#define SWEEP_PERIOD_MS  2500            // 每隔多久扫一轮（只有 ESP32-1 发起）
#define SWEEP_DWELL_MS     30            // 每个信道停留毫秒数（13 信道 ≈ 0.4 秒）
#define SWEEP_CH_FIRST      1
#define SWEEP_CH_COUNT     13
#define SWEEP_LEAD_MS      30            // 主节点发出扫频命令到真正开始的提前量

// ---------------- 稳定性 ----------------
#define TX_POWER_QDBM      60            // 15dBm = 60（单位 0.25dBm），兼顾信噪比与 USB 供电不欠压
#define WDT_TIMEOUT_S      30            // 看门狗：主循环卡死超过 30 秒自动重启
#define WIFI_RETRY_MS    8000            // 连不上 WiFi 多久后重试/切换备用 WiFi
#define STATUS_EVERY_MS  4000            // 状态心跳（浏览器据此显示在线、RSSI、内存）
#define LED_BRIGHTNESS     12            // 板载 RGB 灯亮度 0~255（0 关闭）：蓝=连WiFi 黄=连MQTT 绿=正常 红=异常
