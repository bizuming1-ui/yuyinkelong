#pragma once
// ============================================================================
//  三 ESP32-S3 N16R8 · 三角阵列 WiFi CSI 2.5D 感知系统 v4.5 · 配置文件
//  当前板卡标注：ESP32-1 (ESP32-A · 发射端 TX)
//  三块板（ESP32-1/A、ESP32-B、ESP32-C）使用同一份 main.cpp，唯一区别就是下面的 NODE_ROLE：
//     ESP32-1 / ESP32-A（发射端 TX）  → NODE_ROLE ROLE_A (或 ROLE_1)
//     ESP32-B          （接收端 RX1） → NODE_ROLE ROLE_B
//     ESP32-C          （接收端 RX2） → NODE_ROLE ROLE_C
//  三块板必须连同一个 2.4GHz 路由器/热点（同一信道），挨在一起摆成三角形或展开摆成三角形。
// ============================================================================
#define ROLE_A 1
#define ROLE_1 1
#define ROLE_B 2
#define ROLE_C 3

#define NODE_ROLE ROLE_A            // ← ESP32-1(A) 写 ROLE_A；ESP32-B 写 ROLE_B；ESP32-C 写 ROLE_C

// ---------------- WiFi（三块板必须一致；2.4GHz；不要用 5GHz / 双频合一的同名 SSID 自动切换） ----------------
#define WIFI_SSID  "YOUR_WIFI_NAME"      // ← 改成你的 2.4GHz WiFi 名称
#define WIFI_PASS  "YOUR_WIFI_PASSWORD"  // ← 改成密码
#define WIFI2_SSID ""                    // 备用 WiFi（可留空）
#define WIFI2_PASS ""

// ---------------- MQTT ----------------
// 主题根必须和浏览器模拟器「🔌 连接 ESP32」窗口里显示的一致（默认值已一致）。
// 主题：<root>/n<1|2|3>/status（A/B/C 状态，retained + 遗嘱）、<root>/n2|n3/csi（B/C 的 CSI 批包）、<root>/cmd（控制）
#define MQTT_ROOT "bzm-csi/tri-5d2e8a1c"
// 三个公共服务器自动容灾切换；浏览器同时并联连接这三个服务器 + 支持 WebSerial USB 串口直连，彻底杜绝断连。
#define MQTT_BROKER_COUNT 3
#define MQTT_BROKERS { {"broker.hivemq.com", 1883}, {"broker.emqx.io", 1883}, {"test.mosquitto.org", 1883} }
#define MQTT_KEEPALIVE_S 15

// ---------------- 探测与 CSI（高速低延迟优化） ----------------
#define PROBE_HZ           100           // ESP32-1(A) 每秒发射的探测帧数（B/C 各自得到 ≤100 条 CSI/秒）
#define PAIR_WINDOW_US    8000           // CSI 与 A 序列号配对的时间窗（须 < 探测周期 10ms）
#define HOLD_US          10000           // 未配对的 CSI 最多等待多久再发布（给 ESP-NOW 回调留时间）
#define BATCH_MAX          12            // 每个 MQTT 包最多合并几条 CSI（12 条 ≈ 1.7KB）
#define BATCH_MAX_AGE_MS   65            // 最长等待 65ms 立即发出，实现更高实时更新速率
#define PUBLISH_MIN_MS     75            // 两次发布的最小间隔（≈13.3 批/秒，兼具极低延迟与公共 Broker 零限流）
#define SERIAL_CSI_BRIDGE   1            // 1=同时通过 USB 串口输出 @CSI/@STAT 帧（支持浏览器 WebSerial 零断连直连）

// ---------------- 稳定性 ----------------
#define TX_POWER_QDBM      60            // 15dBm = 60（单位 0.25dBm），兼顾信噪比与 USB 供电不欠压
#define WDT_TIMEOUT_S      30            // 看门狗：主循环卡死超过 30 秒自动重启
#define WIFI_RETRY_MS    6000            // 连不上 WiFi 多久后快速重连/切换备用 WiFi
#define WIFI_REBOOT_S     180            // WiFi 连续断开超过这么久：重启（最后手段）
#define STATUS_EVERY_MS  2500            // 状态心跳（浏览器据此显示在线、RSSI、内存）
#define LED_BRIGHTNESS     12            // 板载 RGB 灯亮度 0~255（0 关闭）：蓝=连WiFi 黄=连MQTT 绿=正常 青=等待A 红=异常
