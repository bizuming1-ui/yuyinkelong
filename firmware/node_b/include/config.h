#pragma once
// ============================================================================
//  ESP32-S3 单节点/双节点自适应 WiFi CSI 成像与全物体检测雷达 v11 —— 配置文件
//
//  ★ v11 核心升级（1 块 ESP32-S3 即可完整实现整个 WiFi 成像与物体检测系统，0 断连）：
//    · SINGLE_NODE_MODE = 1（默认开启）：只需烧录 1 块 ESP32-S3（直接用 Node A 工程即可）！
//      板子全程保持连接路由器/手机热点（绝不主动断开 WiFi 切台），同时启动：
//        ① 对路由器网关高频 ICMP Ping + UDP 探测脉冲（50Hz），每个回包触发硬件 64 子载波复数 CSI；
//        ② 同信道混杂监听（Promiscuous CSI + 周围无线设备/反射体多源感知）；
//        ③ TLS 长连接复用 + 多隧道自动轮换（trycloudflare / pinggy / lhr.life）+ ntfy 自动发现，彻底杜绝断连。
//    · 如果后续给第 2 块板子（Node B）上电，系统也能无缝收到 B 的 ESP-NOW 帧并自动融合双节点数据。
// ============================================================================

#define WIFI_SSID  "bzmdiphone"
#define WIFI_PASS  "a12332100"
#define KAGGLE_URL "https://YOUR-TUNNEL.trycloudflare.com"
// 备用网址（可选，留空 "" 即可）：Kaggle 每次上传响应也会自动下发全部健康隧道网址给 ESP32 实时备份
#define KAGGLE_URL2 ""
#define KAGGLE_URL3 ""
#define API_KEY    "radar-key"
#define PAIR_MAGIC 0xC5

// 自动发现网址：Kaggle 会把最新网址发布到 https://ntfy.sh/<RADAR_TOPIC>（支持 HTTP 与 HTTPS 双回退）
#define RADAR_TOPIC "wradar-bzm-5f2k9q7d"

// ---------------- v11 单节点零断连全能模式 ----------------
// 1 = 单节点零断连模式（默认推荐：只需 1 块 ESP32-S3，全程锁定路由器信道不断线，持续采集高频 CSI 并检测任何物体）
// 0 = 传统双节点 13 信道跳频模式（需要 Node A + Node B 两块板子同时在线）
#define SINGLE_NODE_MODE    1

#define ACTIVE_PROBE_HZ    50    // 单节点模式下对路由器网关主动发探测包的频率（Hz，推荐 40~80）
#define SINGLE_BATCH_MS  1100    // 单节点模式下每批采集多久上传一次（毫秒，1.1 秒一批 = 丝滑实时且不断连）
#define SINGLE_TARGET_RECS 65    // 单节点每批目标采集 CSI 条数（达到条数或到时间即立刻上传）

// ---------------- 信道计划（双节点跳频或合成网格使用） ----------------
#define CHANNEL_PLAN        1    // 1 = 1..13 全信道网格；0 = [1,6,11]
#define DWELL_MS           55
#define EXCHANGES_PER_CH    8
#define EXCH_GAP_MS         5
#define SWEEPS_PER_UPLOAD   3

// ---------------- 供电与稳定性保护 ----------------
#define TX_POWER_DBM       15    // 15dBm 兼顾信号质量与低供电峰值，彻底防止 USB 欠压重启
#define DISABLE_BROWNOUT    0    // 1 = 关闭欠压复位（仅在供电线极差时开启）
#define SYNC_WAIT_MS     1800    // 双节点握手等待时间（v11 缩短为 1.8s，超时立即退化为单节点采集，绝不空等！）
#define B_WAIT_MS       25000
#define B_SCAN_DWELL_MS   120

// DNS 备用（阿里 DNS + 腾讯 DNS，解决手机热点/国内路由器解析隧道域名偶发失败）
#define DNS_FALLBACK  "223.5.5.5"
#define DNS_FALLBACK2 "119.29.29.29"
#define ENABLE_LED          1    // 板载 RGB 灯：蓝=连WiFi 青=采集中 黄=上传中 绿=上传成功 红=重试中

#define COUNTRY_CODE     "CN"
#define HOME_CHANNEL        1
#define WIFI_TIMEOUT_MS  9000
#define HTTP_TIMEOUT_MS  8000
#define HELLO_EVERY_MS  15000
#define ENABLE_UPLOAD       1
#define SERIAL_BAUD    115200
