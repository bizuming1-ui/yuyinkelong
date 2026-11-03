#pragma once
// ============================================================================
//  ESP32-S3 双节点 WiFi CSI 全信道拼接雷达 —— 配置文件 (Node A 与 Node B 必须完全相同)
//
//  只需要改下面 3 处（也可以在网页「复制代码界面」顶部的输入框里填好，复制出来的 config.h 会自动带上）：
//    1) WIFI_SSID / WIFI_PASS   2.4GHz WiFi（路由器或手机热点）。ESP32 靠它把 CSI 数据传给 Kaggle，完全不需要接电脑 USB。
//    2) KAGGLE_URL              Kaggle 运行后【输出框里打印的网址】，形如 https://xxxx.trycloudflare.com ，末尾不要加 /
//    3) API_KEY                 必须和 Kaggle 脚本里的 API_KEY 一致（默认都是 radar-key）
// ============================================================================

#define WIFI_SSID  "YOUR_WIFI_SSID"
#define WIFI_PASS  "YOUR_WIFI_PASSWORD"
#define KAGGLE_URL "https://YOUR-TUNNEL.trycloudflare.com"
#define API_KEY    "radar-key"

// 可选：自动发现网址。Kaggle 会把最新网址发布到 https://ntfy.sh/<RADAR_TOPIC>，
// 当 KAGGLE_URL 没填（或连续上传失败）时，ESP32 自动读取最新网址。设为 "" 关闭。
#define RADAR_TOPIC "wradar-bzm-5f2k9q7d"

// ---------------- 信道计划 ----------------
// 1 = 全信道 1..13（80MHz 合成带宽，信道间隔 5MHz = 16 个子载波，相邻信道重叠 → 可做重叠相位拼接）
// 0 = 先用 [1,6,11] 三个非重叠信道把流程跑通（验证用）
#define CHANNEL_PLAN 1

#define DWELL_MS            55   // 每信道停留（≥50ms）：含 3 次换台指令 + 稳定时间 + 多次双向交换
#define EXCHANGES_PER_CH     8   // 每信道双向交换次数（每次 = A→B 探测 + B→A 回复，各得到一份 CSI）
#define EXCH_GAP_MS          5   // 两次交换的间隔（必须 ≥4，CSI 与帧的配对靠时间窗 ±1.5ms）
#define SWEEPS_PER_UPLOAD    3   // 连续扫几轮后回到路由器信道上传一次（越大越连续，但延迟越高）

#define COUNTRY_CODE "CN"        // 中国 1~13 信道；美国请改 "US"，并把 CHANNEL_PLAN 的 13 改 11
#define HOME_CHANNEL         1   // 没连上路由器时双方会合的信道
#define WIFI_TIMEOUT_MS   9000   // 每次连路由器最多等多久
#define HTTP_TIMEOUT_MS   9000
#define HELLO_EVERY_MS   30000   // 没有数据时多久向 Kaggle 报一次“我在线”
#define ENABLE_UPLOAD        1   // 0 = 不联网，只做扫描并在串口打印统计（调试同步用）
#define SERIAL_BAUD     115200
