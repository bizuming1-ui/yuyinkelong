
# 📡 ESP32-S3 WiFi 雷达 · 3D 真实世界

用一块 ESP32-S3 扫描周围的 WiFi，把扫描到的真实环境实时变成一个**可以用鼠标旋转/缩放/平移的全屏 3D 世界**。
整套系统：`ESP32-S3 固件 (PlatformIO)` → `HTTPS` → `Kaggle T4x2 (Flask + PyTorch GPU + cloudflared 隧道)` → `全屏 three.js 网站`。

```
ESP32-S3 ──扫描 AP + 嗅探设备──► WiFi ──HTTPS POST──► Kaggle Notebook
 (按 RESET 即运行)                                    ├─ /            全屏 3D 网站
                                                      ├─ /api/ingest  接收 ESP32
                                                      ├─ GPU          多节点三边定位 (PyTorch)
                                                      └─ /api/geo     beaconDB 定位 + OpenStreetMap 真实街区
```

## 快速开始（3 步）

1. **Kaggle**：Notebook → Settings → Accelerator 选 `GPU T4 x2`，Internet 选 `On`。新建 Code Cell，粘贴 `kaggle/wifi_radar_kaggle.py` 的**全部内容**并运行。输出里会出现 `https://xxxx.trycloudflare.com`（Cell 要保持运行）。
2. **PlatformIO**：VSCode 打开本仓库的 `firmware/` 文件夹，编辑 `include/config.h`，填 `WIFI_SSID / WIFI_PASS`（2.4GHz）和上一步的 `SERVER_URL`，点 ✔ Build → → Upload。
3. **按一下 ESP32 的 RESET 键**，ESP32 开始扫描并上传；打开 Kaggle 输出的网址，就能看到 3D 世界。

> Kaggle 网址每次重新运行都会变。不想重新烧录：串口监视器里输入 `url https://新网址` 即可（会保存到 NVS）。

## 浏览器模拟器 + 复制代码页

这个仓库同时是一个 Next.js 应用：

- `/` 浏览器模拟器：虚拟 ESP32-S3 开发板（带 RESET 键与串口监视器）+ 右侧 3D 世界。按 RESET 就会"启动固件"并持续送入模拟数据。右上角有「📋 复制代码」按钮，也有复制代码页的网址和「进入复制代码界面」按钮。
- `/code` 复制代码界面：① GitHub 代码（逐文件对比你的仓库，一键「在 GitHub 编辑」「复制此文件」）② Kaggle 单文件 ③ PlatformIO 代码（可填入 WiFi/网址自动写入 config.h）。

## 目录

| 路径 | 作用 |
| --- | --- |
| `firmware/` | PlatformIO 工程（`platformio.ini`、`src/main.cpp`、`include/config.h`） |
| `public/radar.html` | 3D 网站本体（单文件 three.js，Kaggle 与模拟器共用） |
| `kaggle/wifi_radar_kaggle.py` | **Kaggle 单文件**（由 `scripts/kaggle_template.py` + `public/radar.html` 生成） |
| `scripts/build-kaggle.mjs` | 重新生成 Kaggle 单文件：`node scripts/build-kaggle.mjs` |
| `tools/serial_bridge.py` | 可选：用 USB 串口把数据转发到 Kaggle（ESP32 无需联网） |
| `src/app` | 浏览器模拟器与复制代码页（Next.js） |

## 能做什么 / 不能做什么（务必了解）

WiFi 扫描**不是**真正的雷达，诚实的边界如下：

| 内容 | 真实程度 |
| --- | --- |
| 周围有哪些 AP：SSID、BSSID、信道、加密、信号强度 | ✅ 真实测量 |
| 与每个 AP 的距离 | ⚠ 由 RSSI 经路径损耗模型估算，室内误差通常 ±30~50%，可用页面滑块校准 n 与 1 米参考功率 |
| AP 所在方向 | ❌ 单个 ESP32 只有一根天线，**测不出方向**。单节点时方向是"估计位置"（同一设备的多个 SSID 会放在同一方向）；可 Shift+拖动 AP 手动校准；**≥2 个 ESP32 节点**（`config.h` 填 `NODE_X/NODE_Y`）会由 Kaggle GPU 做三边定位 |
| 周围手机/电脑（嗅探） | ✅ 真实：混杂模式抓到的发送方 MAC 与信号强度（手机多为随机化 MAC，只能看到"有设备"） |
| 环境扰动（有人走动） | ✅ 真实但粗略：所有 AP 的 RSSI 波动相对基线的增量 |
| 真实街区底图 | ✅ 真实：用 beaconDB 的 WiFi 定位（精度几十~几百米，且需要该地区已有收录）+ OpenStreetMap 建筑/道路。定位不到时可手动输入经纬度，并可用 ◀▶▲▼ 微调对齐 |
| 墙体/室内结构 | ❌ 无法仅靠 RSSI 还原 |

## 串口命令（115200）

`show` · `ssid <名称>` · `pass <密码>` · `url <网址>` · `key <密钥>` · `clear`（清除保存的配置并重启）· `reboot`

## 3D 操作

左键旋转 · 右键平移 · 滚轮缩放 · 点击 AP 查看详情 · `Shift`+拖动 AP 校准方位 · `R` 复位视角 · `F` 全屏 · `L` 标签开关。

## 故障排查

- 上传失败：按住 BOOT，按一下 RESET，松开 BOOT 再 Upload；接 USB 原生口的板子用环境 `esp32s3_usbcdc`。
- 串口 `[wifi] connect timeout`：SSID/密码错误，或是 5GHz（ESP32-S3 只支持 2.4GHz）。
- 串口 `[upload] HTTP -1`：网址写错/Kaggle Cell 已停止；`HTTP 401`：API_KEY 不一致。
- 页面一直"等待 ESP32"：看串口是否出现 `[upload] HTTP 200`；刚启动的隧道网址偶尔需要十几秒才生效。
- 页面报"3D 引擎加载失败"：浏览器需支持 WebGL 并能访问 `cdn.jsdelivr.net`。
