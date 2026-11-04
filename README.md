# 📡 双 ESP32-S3 N16R8 · WiFi CSI 3D 感知系统（v2：MQTT 无线 + 13 信道拼接 + 浏览器 3D 模拟器）

**不再使用 Kaggle，也不再需要 USB 连电脑。** 两块 ESP32-S3 只要供电 + 同一个 2.4GHz WiFi，数据经 MQTT 到浏览器；浏览器打开网址即可实时看 3D 画面。

```
ESP32-1 ◀══ ESP-NOW(HT MCS0 帧，每帧产生硬件 CSI) ══▶ ESP32-2
   │  13 信道扫频（每 2.5s，一轮约 0.4s，扫完立刻回路由器信道）  │
   └──── WiFi ──▶ MQTT 公共服务器（emqx / hivemq / mosquitto 自动轮换）◀──── WiFi ──┘
                                │ MQTT over WSS（浏览器同时连 3 个服务器，任一断线不中断）
                                ▼
           浏览器：多信道相位对齐拼接(245 频点≈76MHz) → 路径长度剖面 → CLEAN 反卷积 → 3D 地形 + 椭圆
```

## 目录

| 路径 | 说明 |
| --- | --- |
| `firmware/esp32-1/`、`firmware/esp32-2/` | 两块板子的 PlatformIO 工程，各 4 个文件：`platformio.ini`、`upload_retry.py`（烧录防掉线）、`include/config.h`、`src/main.cpp`（只有 `NODE_ID` 不同） |
| `src/app/page.tsx`、`src/components/RadarApp.tsx` | 3D 模拟器主界面（右上角「🔌 连接 ESP32」「🩺 检测日志」「📋 复制代码」） |
| `src/components/Scene3D.tsx` | Three.js 场景：左键旋转 / 右键平移 / 滚轮缩放 |
| `src/lib/dsp.ts` | 信号处理：相位去偏、信道链式对齐、IDFT 剖面、CLEAN、运动/呼吸检测 |
| `src/lib/mqtt-hub.ts` | 浏览器 MQTT：同时连多个服务器 + 看门狗 |
| `src/app/code/`、`src/components/CodeBrowser.tsx` | 「进入复制代码界面」：每个文件都有「在 GitHub 编辑」「复制此文件」，并实时检测 GitHub 是否已更新 |
| `tools/sim_esp32.ts`、`tools/e2e_check.ts` | 无硬件仿真器 / 端到端自检（含 3 轮拼接测试） |

## 使用（4 步）

1. **打开模拟器**网址（浏览器直接打开，无需安装）。右上角「📋 复制代码」或第二行「进入复制代码界面」。
2. **烧录 ESP32-1**：复制界面 → 「PlatformIO · ESP32-1」→ 4 个文件逐个复制覆盖到 PlatformIO 工程 → 填 WiFi（页面里填，自动写进复制出来的 config.h）→ 环境 `n16r8` → Upload。
3. **烧录 ESP32-2**：同上，用「PlatformIO · ESP32-2」。
4. 两块板子供电后，回到模拟器点「🔌 连接 ESP32」（页面打开时会自动连接）。看到 ESP32-1/2 变绿即可。

> 想先看效果：左侧「▶ 启动演示数据」。命令行仿真：`npx tsx tools/sim_esp32.ts`。

## 你遇到的上传错误：`Cannot configure port … OSError(22, '指定不存在的设备')`

含义：烧录写到 50% 时，Windows 上这个 COM 口**突然消失**（USB 设备掉线 / 重新枚举），esptool 再去配置串口就失败。这不是代码错误。本版本做了这些处理：

1. 日志里板型是 `ESP32-S3-DevKitC-1-N8 (8MB QD, No PSRAM)`，说明 PSRAM 与 16MB Flash 没按 N16R8 配置。`platformio.ini` 已改为 `qio_opi` + `default_16MB.csv` + `board_upload.flash_size = 16MB`。
2. 固件 `ARDUINO_USB_CDC_ON_BOOT=0`：应用程序不再接管原生 USB，减少 USB 重新枚举。
3. **新增 `upload_retry.py`（`extra_scripts = post:upload_retry.py`）**：烧录失败后自动等待 COM 口重新出现（最长 30 秒），依次用 配置速度 → 115200 → ROM 直写(`--no-stub`) 重试，最多 4 次，无需再手动点 Upload，也不会再出现 “Please specify upload_port”。已用真实 PlatformIO + 假 esptool 验证重试流程。仍失败选 `n16r8_slow`（115200）。
4. 硬件侧（最关键）：用标 **UART/COM** 的口；换短的**数据线**（很多线只能充电或接触差）；直插主板 USB，不要 HUB；关闭串口监视器/串口助手；不行就**按住 BOOT → 点 RST → 松开 BOOT**，再点 Upload。
5. Windows 设备管理器 → 该 USB 设备属性 → 电源管理，取消「允许计算机关闭此设备以节约电源」。

## MQTT

- 主题根默认 `bzm-csi/s3r-7f3a9c2e`（`config.h` 的 `MQTT_ROOT` 与浏览器「连接 ESP32」窗口里的主题根必须一致；想私密一点就两边同时改成随机字符串）。
- `…/n1/csi`、`…/n2/csi`：二进制批包（每包最多 6 条 CSI，138 字节/条）；`…/nX/status`：JSON 心跳（retained + 遗嘱）；`…/cmd`：浏览器下发 `sweep` / `ping` / `reboot`。
- 公共服务器列表：emqx、hivemq、mosquitto。ESP32 逐个尝试，连不上自动换下一个；浏览器同时连接这三个，所以无论 ESP32 落在哪个都能收到。公共服务器没有 SLA；需要更稳时可自建 Mosquitto，改 `config.h` 的 `MQTT_BROKERS` 与 `src/lib/config.ts` 的 `BROKERS`。

## 断连防护（固件 + 浏览器）

任务看门狗 30s；WiFi 掉线自动重连/切备用 WiFi；MQTT 指数退避并轮换服务器；PSRAM 环形缓冲（1024 条）+ 批量低延迟发布；MQTT 遗嘱；扫频期间暂停发布，扫完立刻补发；浏览器多服务器并连 + 20s 无数据强制重连 + 页面日志。

## 诚实的能力边界（物理限制，不是代码能突破的）

- 2 个 ESP32-S3 只有 2.4GHz、20MHz 带宽。13 信道拼接后合成带宽约 76MHz，**路径长度分辨率约 3.9 m**。
- 系统给出的是「路径长度(L)-时间」剖面：目标在以两块板子为焦点、路径长度为 L 的**椭圆**上。2 个节点**无法确定方位角**，也不能像摄像头那样还原物体轮廓。
- 能检测：运动、静止人体呼吸（需较安静环境）、静态反射体（墙/金属）的路径长度、两块板子之间链路是否被遮挡。
- 想要真正的 3D 轮廓/厘米级：需要 ≥3 个相位相干节点或毫米波/UWB 雷达硬件。
- 多信道扫频是「连着 WiFi 临时跳频 0.4 秒」；若你的路由器/热点对此敏感导致 MQTT 抖动，把 `config.h` 里 `SWEEP_ENABLE` 设 0，系统仍能做运动/呼吸检测，只是没有拼接剖面。

## 开发

```bash
npm install
npm run dev                    # 开发
npm run build && npm start     # 生产
npx tsx tools/e2e_check.ts     # 端到端自检（协议 / 拼接 / 运动 / MQTT 往返）
npx tsx tools/sim_esp32.ts     # 无硬件仿真两块 ESP32
```

部署到 Vercel：直接导入本仓库即可（Next.js 零配置）；页面里的 MQTT 走浏览器 WSS，不需要服务器常驻。

## 安全提示

旧仓库的 `config.h` 里曾提交过真实 WiFi 密码（公开仓库）。**请立刻修改该 WiFi 密码**。新版本 GitHub 上的 `config.h` 只放占位符，真正的 WiFi 在复制代码界面填写，只保存在你自己的浏览器里。
