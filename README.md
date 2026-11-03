## 📡 ESP32-S3 WiFi 雷达 · 3D 真实世界

用一块 ESP32-S3 扫描周围的 WiFi，把真实环境实时变成一个**可以用鼠标旋转 / 缩放 / 平移的全屏 3D 世界**。

```
ESP32-S3 ──扫描 AP + 嗅探设备──┬─ WiFi HTTPS ─────────────► Kaggle (Flask + PyTorch 多GPU + cloudflared)
 (按 RESET 即运行)            └─ USB 串口 → 浏览器 Web Serial ─►   ├─ /            全屏 3D 网站（零依赖自研 3D 引擎）
                                                                 ├─ /api/ingest  接收
                                                                 ├─ GPU          三边定位 + 运动检测
                                                                 └─ /api/geo     beaconDB + OpenStreetMap 真实街区
```

## v2 修复了什么

* 旧版 3D 依赖 `three.js + importmap + cdn.jsdelivr.net + WebGL`：CDN 被墙/慢、WebGL 不可用时整页空白；且没有数据时场景是空的、相机比例错误（扫描扇面巨大、标签错位）。
  现在改为**自研 Canvas 3D 引擎，零依赖、不联网也能渲染**，默认视角与比例已修正。
* 旧版数据只能走「ESP32 → WiFi → 公网隧道」，任何一环失败都看不到数据。现在新增 **USB 直连**：网页里点「🔌 USB 连接 ESP32」，用浏览器 Web Serial 读串口转发，ESP32 无需联网。
* 等待界面带**逐项自检**（网页 / 后端 / 帧数 / 串口）。Kaggle 启动后自动**公网自检**，cloudflared 自动重试。
* Kaggle 端：所有 GPU 分片三边定位、GPU 运动检测、显存/内存/磁盘预算与历史记录。

## 快速开始（3 步）

1. **Kaggle**：Settings → Accelerator `GPU T4 x2`，Internet `On`。新建 Code Cell，粘贴 `kaggle/wifi_radar_kaggle.py` 全部内容并运行，得到 `https://xxxx.trycloudflare.com`。
2. **PlatformIO**：VSCode 打开 `firmware/`，（可选）编辑 `include/config.h`，Build → Upload。
3. **按一下 ESP32 的 RESET 键**。电脑 Chrome/Edge 打开 Kaggle 网址，点「🔌 USB 连接 ESP32」即可看到 3D 世界（也可以用 config.h 里的 WiFi 上传）。

## 浏览器模拟器 + 复制代码页

* `/` 浏览器模拟器：虚拟 ESP32-S3（RESET 键 + 串口监视器）+ 3D 世界；有网址栏、右上角「📋 复制代码」、「进入复制代码界面」。
* `/radar.html?demo=1` 直接打开 3D 世界（演示数据）。
* `/code` 复制代码界面：① GitHub 代码（逐文件对比仓库，「在 GitHub 编辑」「复制此文件」）② Kaggle 单文件 ③ PlatformIO 代码。

## 诚实的边界

| 内容 | 真实程度 |
| --- | --- |
| AP 的 SSID/BSSID/信道/加密/RSSI | ✅ 真实测量 |
| 与 AP 的距离 | ⚠ RSSI 经路径损耗模型估算，误差 ±30~50%，可用滑块校准 |
| AP 方向 | ❌ 单天线测不出方向：单节点为估计值（可 Shift+拖动校准）；≥2 个 ESP32 节点由 GPU 三边定位 |
| 周围设备 | ✅ 混杂模式抓到的发送方 MAC 与信号（手机多为随机 MAC） |
| 环境扰动 | ✅ 真实但粗略（RSSI 波动） |
| 真实街区 | ✅ beaconDB 定位 + OpenStreetMap 建筑/道路（需该地区有收录，可手动输入经纬度） |
| 墙体/室内结构 | ❌ 仅靠 RSSI 无法还原 |

## 目录

| 路径 | 作用 |
| --- | --- |
| `firmware/` | PlatformIO 工程 |
| `public/radar.html` | 3D 网站本体 |
| `scripts/kaggle_template.py` + `scripts/build-kaggle.mjs` | 生成 `kaggle/wifi_radar_kaggle.py`（`node scripts/build-kaggle.mjs`） |
| `tools/serial_bridge.py` | 可选：命令行串口桥 |
| `src/app` | 浏览器模拟器与复制代码页（Next.js） |

## 串口命令（115200）

`show` · `ssid <名称>` · `pass <密码>` · `url <网址>` · `key <密钥>` · `clear` · `reboot`

## 故障排查

* 烧录失败：按住 BOOT，按一下 RESET，松开 BOOT 再 Upload；接 USB 原生口的板子用环境 `esp32s3_usbcdc`。
* 「USB 连接」打不开串口：关闭 PlatformIO 串口监视器；必须是电脑版 Chrome/Edge，且网址是 https。
* 串口 `[wifi] connect timeout`：SSID/密码错或是 5GHz。`[upload] HTTP -1`：网址错/Kaggle Cell 已停；`HTTP 401`：API_KEY 不一致。
