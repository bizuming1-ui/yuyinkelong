#pragma once
// ============================================================================
//  三 ESP32-S3 WiFi CSI 感知系统 v4 · 配置文件
//  A / B / C 三块板使用同一份 main.cpp，唯一区别就是下面的 NODE_ROLE：
//     ESP32-A（发射端 TX）  → NODE_ROLE ROLE_A
//     ESP32-B（接收端 RX1） → NODE_ROLE ROLE_B
//     ESP32-C（接收端 RX2） → NODE_ROLE ROLE_C
//  三块板必须连同一个 2.4GHz 路由器/热点（同一信道），摆成三角形（见模拟器左侧「设置」里的阵列边长）。
// ============================================================================
#define ROLE_A 1
#define ROLE_B 2
#define ROLE_C 3

#define NODE_ROLE ROLE_A                 // ← A 板写 ROLE_A；B 板写 ROLE_B；C 板写 ROLE_C

// ---------------- WiFi（三块板必须一致；2.4GHz；不要用 5GHz / 双频合一的同名 SSID 自动切换） ----------------
#define WIFI_SSID  "YOUR_WIFI_NAME"      // ← 改成你的 2.4GHz WiFi 名称
#define WIFI_PASS  "YOUR_WIFI_PASSWORD"  // ← 改成密码
#define WIFI2_SSID ""                    // 备用 WiFi（可留空）
#define WIFI2_PASS ""

// ---------------- MQTT ----------------
// 主题根必须和浏览器模拟器「🔌 连接 ESP32」窗口里显示的一致（默认值已一致）。
// 主题：<root>/n<1|2|3>/status（A/B/C 状态，retained + 遗嘱）、<root>/n2|n3/csi（B/C 的 CSI 批包）、<root>/cmd（控制）
#define MQTT_ROOT "bzm-csi/tri-5d2e8a1c"
// 公共服务器仅用于连通/演示（提示词 4.1：不要用匿名公共 Broker 传输敏感或长期项目数据；可改成自己的 Mosquitto/EMQX）。
// 第一个连不上自动换下一个；浏览器同时连接这三个，所以无论 ESP32 走哪个都能收到。
#define MQTT_BROKER_COUNT 3
#define MQTT_BROKERS { {"broker.hivemq.com", 1883}, {"broker.emqx.io", 1883}, {"test.mosquitto.org", 1883} }
#define MQTT_KEEPALIVE_S 15

// ---------------- 探测与 CSI ----------------
#define PROBE_HZ           100           // A 每秒发射的探测帧数（B/C 各自得到 ≤100 条 CSI/秒）
#define PAIR_WINDOW_US    8000           // CSI 与 A 序列号配对的时间窗（须 < 探测周期 10ms）
#define HOLD_US          12000           // 未配对的 CSI 最多等待多久再发布（给 ESP-NOW 回调留时间）
#define BATCH_MAX          14            // 每个 MQTT 包最多合并几条 CSI（14 条 ≈ 2KB）
#define BATCH_MAX_AGE_MS  100            // 最长等待多久必须发出
#define PUBLISH_MIN_MS    105            // 两次发布的最小间隔（≈9.5 条/秒，低于公共服务器限流；14 条/包 ⇒ ≈133 条/秒 ≥ 100）

// ---------------- 稳定性 ----------------
#define TX_POWER_QDBM      60            // 15dBm = 60（单位 0.25dBm），兼顾信噪比与 USB 供电不欠压
#define WDT_TIMEOUT_S      30            // 看门狗：主循环卡死超过 30 秒自动重启
#define WIFI_RETRY_MS    8000            // 连不上 WiFi 多久后重试/切换备用 WiFi
#define WIFI_REBOOT_S     180            // WiFi 连续断开超过这么久：重启（最后手段）
#define STATUS_EVERY_MS  3000            // 状态心跳（浏览器据此显示在线、RSSI、内存）
#define LED_BRIGHTNESS     12            // 板载 RGB 灯亮度 0~255（0 关闭）：蓝=连WiFi 黄=连MQTT 绿=正常 青=等待A 红=异常
