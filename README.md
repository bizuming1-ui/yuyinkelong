## 📡 双 ESP32-S3 N16R8 · WiFi CSI 3D 感知系统（v3：高灵敏人体检测 + 路由器链路 + 人体线框 3D 成像）

两块 ESP32-S3 只要供电 + 同一个 2.4GHz WiFi，数据经 MQTT 到浏览器；`dist/index.html` 是**单文件**，双击或任意静态托管即可打开。

```
ESP32-1 ◀══ ESP-NOW(HT MCS0, 50Hz) ══▶ ESP32-2        每块板还以 30Hz ping 路由器 → 路由器回包 CSI
   │  13 信道扫频（每 2.5s 一轮，约 0.4s） │
   └──── WiFi ──▶ MQTT 公共服务器(hivemq / emqx / mosquitto) ◀──── WiFi ──┘
                         │ MQTT over WSS（浏览器同时连 3 个，任一断线不中断）
                         ▼
 浏览器：4 链路自适应运动检测(src/lib/detector.ts) + 多信道拼接/CLEAN 剖面(dsp.ts) → 3D 人体线框 + 椭圆 + 地形
```

## v3 修复了什么（"人在面前走来走去却没反应"）

| 旧版问题 | v3 做法 |
| --- | --- |
| 每包按 RMS 归一化，抹掉了人体造成的功率变化 | 同时用 子载波湍流 / 总功率(dB) / 形状漂移 / 形状偏差 四个特征 |
| 只在启动 6 秒校准一次，校准时有人走动就永远"静止" | 噪声底 = 过去 90 秒的 10 分位数，全自适应，无需手动校准 |
| 阈值 z>1.5 起、z>10.5 满格，且 sigma 有 8% 下限 | 每个特征按自己的安静波动归一，取最强两项均值；灵敏度滑块 0.5~4 |
| 丢弃路由器(AP)链路 | 固件每秒 ping 网关 30 次，路由器回包产生 CSI；浏览器 4 条链路并行（路径穿过整个房间） |
| 单一节点距离 0.3m，直达波压制一切 | 界面与说明提示：两板隔开 2~4 米 |

验证（无硬件）：`npx tsx tools/motion_sim.ts 3`——空房 120s 误报 0%、走动检出 ≥87%（微弱目标）/100%、首次检出 <0.5s、启动时人在走动不死锁、强 AGC 抖动不误报；连续 3 轮通过。固件已用 PlatformIO（espressif32@6.9.0，n16r8）真实编译通过，0 警告。

## 目录

| 路径 | 说明 |
| --- | --- |
| firmware/esp32-1/、firmware/esp32-2/ | PlatformIO 工程，各 4 个文件（只有 config.h 的 NODE_ID 不同） |
| src/App.tsx、src/components/RadarApp.tsx | 主界面：右上角「🔌 连接 ESP32」「🩺 检测日志」「📋 复制代码」 |
| src/components/Scene3D.tsx、src/lib/avatar.ts | Three.js：人体线框成像、椭圆、地形；左键旋转 / 右键平移 / 滚轮缩放 |
| src/lib/detector.ts | 新：高灵敏运动/有人检测 |
| src/lib/dsp.ts | 相位去偏、信道链式对齐、IDFT 剖面、CLEAN、呼吸检测 |
| src/lib/mqtt-hub.ts | 浏览器 MQTT：同时连多个服务器 + 看门狗 |
| src/components/CodeBrowser.tsx、src/lib/manifest.ts | 复制代码界面：逐文件「在 GitHub 编辑 / 复制此文件」，实时检测与 GitHub 是否一致，可下载 ZIP |
| tools/ | motion_sim.ts（检测验证）、e2e_check.ts、sim_esp32.ts |

## 使用

1. 打开模拟器 → 「📋 复制代码」或「进入复制代码界面」。
2. 「PlatformIO · ESP32-1」：填 WiFi → 4 个文件复制覆盖（或下载工程 ZIP）→ 环境 `n16r8` → Upload。ESP32-2 同理。串口出现 `[PING] 开始 ping 网关` 即为 v3 固件。
3. 两块板子供电后点「🔌 连接 ESP32」（页面打开时自动连接）。
4. 想先看效果：左侧「▶ 启动演示数据」。

开发：`npm install && npm run dev`；`npm run build` 生成单文件 `dist/index.html`。

## 诚实的能力边界

2 个 ESP32-S3 + 20MHz×13 信道拼接（≈76MHz，分辨率≈3.9m）：能可靠检测"有没有人/有没有在动"、呼吸（安静环境）、路径长度 L（椭圆）。**不能**像摄像头那样还原身体轮廓；3D 人体线框是"检测到人"的可视化，位置为椭圆上的近似估计。真正的轮廓需要多天线阵列/毫米波/UWB 等硬件。
