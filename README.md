## 📡 ESP32-S3 WiFi 雷达 · 3D 真实世界（v4）

## v4 修复了什么 —— “卡在等待 ESP32 上传数据”的真正根因

经过沙盒实测（真实 cloudflared 隧道 + 无头 Chromium + PlatformIO 编译）确认：**服务器收到数据后，3D 页面是正常出图的**；卡住的原因全部在“数据到不了服务器”这一段：

1. **网址每次都变（最主要）**：Kaggle 每次运行 `trycloudflare` 网址都不同，而 ESP32 固件里写死的 `SERVER_URL` 一过期就永远上传失败（`HTTP -1`）。
   **v4：自动发现网址**——Kaggle 把最新网址发布到公共汇合点 `https://ntfy.sh/<RADAR_TOPIC>`（每 4 分钟重发），ESP32 联网后自动读取最新网址再上传。之后只要 `config.h` 填好 WiFi，**Kaggle 重开多少次都不用重新烧录**。`RADAR_TOPIC`（暗号）在固件和 Kaggle 脚本里默认已一致。
2. **固件 bug：嗅探后永远不重连**：嗅探轮次会断开 WiFi，而重连被“30 秒重试节流”挡住，导致联网上传大部分时间被跳过。已修复（嗅探结束立刻重连）。
3. **3D 世界不再被“等待”遮住**：等待提示缩小到顶部；页面启动就自动加载真实街区（浏览器定位 → IP 粗略定位 → OpenStreetMap 建筑/道路），ESP32 数据到达后再用周围 WiFi（beaconDB）校准位置。
4. **隧道更稳**：cloudflared 70 秒没出网址时自动改用 localhost.run 备用隧道。
5. **检测日志新增两项**：「自动发现汇合点」「ESP32 WiFi 直传」，直接告诉你卡在 `[wifi] → [topic] → [upload]` 哪一步。
6. 修复检测日志反复创建 WebGL 上下文（浏览器报 “Too many active WebGL contexts”）。

### 沙盒验证记录
- PlatformIO 真实编译固件（esp32s3 环境）通过。
- 真实 cloudflared 隧道：服务端发布网址 → 按固件同样的解析规则从 ntfy.sh 读回 → 用 TLS1.2 POST `/api/ingest` 返回 200，服务端识别为 “ESP32 WiFi直传”。
- 无头 Chromium：3D 页面从“等待”到收到数据后出图，检测面板各项正确。

用一块 ESP32-S3 扫描周围 WiFi，把真实环境实时变成可用鼠标旋转 / 缩放 / 平移的**全屏 3D 世界**。

```
ESP32-S3 ──扫描 AP + 嗅探设备──┬─ USB 串口(RADARHELLO/RADARHB/RADARJSON) → 浏览器 Web Serial ─┐
 (按 RESET 即运行)            └─ WiFi HTTPS（可选）──────────────────────────────────────────┤
                                                                                              ▼
                               Kaggle (Flask + PyTorch 多GPU + cloudflared)：/ 全屏3D网站 · /api/ingest · /api/diag · /api/geo
```

## v3 修复了什么

1. **插哪个 USB 口都能出数据**：`Serial` 到底走 UART 口还是原生 USB 口取决于 `ARDUINO_USB_CDC_ON_BOOT`，旧固件只输出到其中一个，插错口网页就永远 0 字节。现在固件**同时输出到两个口**（默认环境 `esp32s3`）。
2. **首帧更快**：第一轮不做嗅探，约 2 秒内出第一帧；WiFi 连不上不再每轮阻塞 10 秒（30 秒重试一次，期间串口照常输出）。
3. **固件心跳** `RADARHB`（独立任务，每秒）+ 设备信息 `RADARHELLO`：网页能区分“固件死了 / 在扫描 / 在连 WiFi”。
4. **网页串口重写**：连接后用 RTS 脉冲复位 ESP32（DTR 保持低，不会进下载模式）、发送 `hello`、3.5 秒/8 秒/11 秒看门狗（再复位、兼容 DTR 模式、给出结论）、热拔插自动重连、已授权串口自动连接。
5. **渲染循环不再冻结**：旧版 `frame()` 里任何绘制异常都会让 `requestAnimationFrame` 不再被调用，画面永久卡死；现在先排下一帧再 try/catch。
6. **同源转发免 API_KEY**：网页把 USB 数据转发给服务器不再因 401 静默失败。服务器缓存的旧帧（>20 秒）不再被当成实时数据。
7. **全能检测系统**：浏览器模拟器右上角「🩺 检测日志」+ 3D 页面「🩺 检测日志」+ 服务器 `/api/diag.txt`；一键复制/下载，可直接贴到 GitHub 的 `检测日志` 文件。

## 快速开始

1. **Kaggle**：Settings → Accelerator `GPU T4 x2`，Internet `On`。新建 Code Cell，粘贴 `kaggle/wifi_radar_kaggle.py` 全部内容并运行，得到 `https://xxxx.trycloudflare.com`。
2. **PlatformIO**：VSCode 打开 `firmware/`，Build → Upload（失败时按住 BOOT 再按 RESET）。不用改 config.h 也能用 USB 直连。
3. （ESP32 直连 Kaggle 的方式）在 `firmware/include/config.h` 填 `WIFI_SSID` / `WIFI_PASS`（2.4GHz），Upload 一次即可；不填则只能用 USB 直连。按一下 ESP32 的 **RESET**。串口监视器应依次看到 `[wifi] connected` → `[topic] ✅ 发现 Kaggle 最新网址` → `[upload] HTTP 200 ✅`。
4. 电脑 Chrome/Edge 打开 Kaggle 网址，点「🔌 USB 连接 ESP32」，选择串口 → 3D 世界出现。
5. 出问题：点网页右上角「🩺 检测日志」→「复制日志」，发给我 / 贴到 GitHub。

## 浏览器模拟器 + 复制代码页

* `/` 浏览器模拟器：虚拟 ESP32-S3（RESET 键 + 串口监视器，输出格式与真实固件完全一致，走同一套解析代码）；网址栏可打开 Kaggle 网址（iframe 已授权 `serial`）；右上角「🩺 检测日志」「📋 复制代码」。
* `/radar.html?demo=1` 直接打开 3D 世界（演示数据）。
* `/code` 复制代码界面：① GitHub 代码（逐文件对比仓库，「在 GitHub 编辑」「复制此文件」）② Kaggle 单文件 ③ PlatformIO 代码。

## 诚实的边界

| 内容 | 真实程度 |
| --- | --- |
| AP 的 SSID/BSSID/信道/加密/RSSI | ✅ 真实测量 |
| 与 AP 的距离 | ⚠ RSSI 经路径损耗模型估算，误差 ±30~50%，可用滑块校准 |
| AP 方向 | ❌ 单天线测不出方向：单节点为估计值（可 Shift+拖动校准）；≥2 个 ESP32 节点由 GPU 三边定位 |
| 周围设备 | ✅ 混杂模式抓到的发送方 MAC 与信号（手机多为随机 MAC） |
| 真实街区 | ✅ beaconDB 定位 + OpenStreetMap 建筑/道路（需该地区有收录，可手动输入经纬度） |
| 墙体/室内结构 | ❌ 仅靠 RSSI 无法还原 |
| T4×2 GPU | 单节点数据量极小，GPU 并不是瓶颈；≥2 个节点时才用于三边定位/运动检测 |

## 串口协议（115200，每行一条）

`RADARHELLO:{…}` 设备信息 · `RADARHB:{…}` 心跳 · `RADARJSON:{…}` 一帧扫描 · 其它为人类可读日志。
命令：`hello` · `show` · `ssid <名称>` · `pass <密码>` · `url <网址>` · `key <密钥>` · `clear` · `reboot`

## 故障排查

* 烧录失败：按住 BOOT，按一下 RESET，松开 BOOT 再 Upload。
* 「USB 连接」打不开串口：关闭 PlatformIO 串口监视器；必须是电脑版 Chrome/Edge，且网址是 https。
* 检测日志提示「0 字节」：换板子另一个 USB 口再连一次；重新 Upload 新版固件；换数据线。
* 提示「下载模式」：松开 BOOT，按 RESET（或点「🔁 复位 ESP32」）。
* 串口 `[wifi] connect timeout`：SSID/密码错或是 5GHz。`[upload] HTTP -1`：网址错/Kaggle Cell 已停；`HTTP 401`：API_KEY 不一致。
