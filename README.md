## 📡 ESP32-S3 双节点 WiFi CSI 全信道拼接雷达（v8）

两块 ESP32-S3（N16R8，仅 2.4GHz 802.11b/g/n）+ Kaggle（T4×2）主机端 + 浏览器 3D 模拟器。
**ESP32 不用接电脑**：烧录好后只要供电，数据通过 WiFi（HTTPS）上传到 Kaggle 输出框里打印的网址。

```
Node A (发起端)  ──ESP-NOW 广播 HOP/PROBE──▶  Node B (响应端)
   ▲  H_BA (A 收到 B 的回复)                    │ H_AB (B 收到 A 的探测) + 立即 REPLY
   └──────────────────────────────────────────┘
        每个信道停留 55ms：3 次换台指令 + 8 次双向交换，13 个信道 ≈ 0.7s / 轮
   扫完 SWEEPS_PER_UPLOAD 轮 → 两节点一起回到路由器信道 → 各自 HTTPS POST 二进制 CSI 到 Kaggle
Kaggle(Flask + cloudflared + numpy/PyTorch)：配对 → 相位标定 → 帧对齐 → 重叠子载波拼接 → IFFT(GPU0) / MUSIC(GPU1) → 感知
浏览器模拟器（Next.js + three.js）：轮询 Kaggle 的 /api/state → 距离-时间 3D 地形 + 路径椭圆 + 全能检测日志
```

### 怎么用（4 步）
1. **Kaggle**：Settings → Accelerator `GPU T4 x2`，Internet `On`；新建 Code Cell，粘贴 `kaggle/csi_radar_kaggle.py` 全部内容，运行。约 20 秒后**输出框里的方框里会打印 `https://xxxx.trycloudflare.com`**。
2. **复制代码界面**（浏览器模拟器右上角「📋 复制代码」或「进入复制代码界面」）→ ③ PlatformIO 代码：把 Kaggle 网址、WiFi 名/密码填进顶部输入框，config.h 自动带上；Node A、Node B 各 4 个文件复制进两个 PlatformIO 工程（Board: ESP32-S3-DevKitC-1，Framework: Arduino）→ Build → Upload。
3. 两块板子**只供电**（不用接电脑）。串口监视器（可选）应依次看到：`[wifi] ✅` → `[upload] HTTP 200` → `[sync] ✅ Node B 已就绪` → `[sweep] 3 轮 …`。
4. 浏览器模拟器顶部「Kaggle 网址」粘贴同一个网址 → 连接。出问题点右上角「🩺 检测日志」→ 复制日志（或「复制并去 GitHub 提交」）。

> 没填 Kaggle 网址也行：固件会从 `https://ntfy.sh/<RADAR_TOPIC>` 自动读取 Kaggle 最新网址（Kaggle 脚本每 4 分钟发布一次）。

### 为什么“一直等待 ESP32 数据”（v7 的根因）与 v8 的修法
| 根因 | v8 修法 |
|---|---|
| 网页靠 USB 串口读数据，插错口/被占用/0 字节就永远在等 | **完全去掉 USB 依赖**：ESP32 → WiFi → Kaggle → 浏览器 |
| 等待提示不说明卡在哪一步 | 状态条按 **网址→Kaggle 可达→节点上线→节点同步→首帧** 五个阶段给出具体原因；「检测日志」逐项 ✅/⚠️/❌ |
| 3D 界面依赖数据才“出现” | three.js 打包在本站（无 CDN）；地面、椭圆刻度、节点、地形**无数据时也真实渲染**；WebGL 不可用会明确报错；渲染循环先排下一帧再 try/catch（不会冻结）；帧率低自动降像素比 |
| 节点上线信息只在有 CSI 后才有 | 每次上传（含 0 条记录的心跳）都带固件/IP/RSSI/信道，主机立即显示“Node A/B 在线” |

### 物理与算法（第一性原理）
* **信道栅格**：ESP32 CSI 子载波间隔 312.5kHz，信道间隔 5MHz = **16 个子载波**，所以 13 个信道落在同一频率栅格上，相邻信道重叠 36 个子载波 → 可以用重叠区**估计并消除**信道间的相位/斜率偏差（比纯“幅度拼接”更强）。全部 13 信道 ≈ 245 个频点 ≈ **76.6MHz**（理论上限 ≈ 80MHz）。
* **双向相位标定**：A→B 与 B→A 的本振/采样偏移互为相反数：`H_AB = h·e^{+jθ}`、`H_BA = h·e^{-jθ}`。`Z = H_AB·conj(H_BA) = |h|²e^{j2θ}` 拟合出 θ(k)（常数 + 斜率），两个方向各自校正后平均。**不直接用乘积 h²**，因为 h² 会产生 τi+τj 的交叉项鬼影（沙盒仿真里实测会把 8m 的目标淹没）。
* **帧间对齐** → **信道间重叠拼接**（相位增量估计，无需解卷绕）→ **锚定**（最强径放在两节点间距）→ **IFFT**（Kaiser 窗，8192 点零填充）→ **MUSIC**（前后向平滑，GPU1）。
* **分辨率（诚实）**：路径长度分辨率 `c/B ≈ 3.9m`（等效单站距离 `R=L/2` 时 ≈ 2m）；MUSIC 在仿真里能分开 3m/8m/14m 路径。**2 个节点 = 1 条双基地链路**：得到的是“路径长度椭圆”（以 A、B 为焦点），**不能成像、不能测角度、不能定位到点**；要定位需要 ≥3 节点。
* **感知**：存在/运动（相对基线的幅度谱变化，MAD 阈值）、呼吸（Lomb–Scargle，支持上传间隙造成的不等间隔采样，0.1–0.5Hz）。**呼吸需要平均采样率 ≳ 0.4 轮/秒**；每次上传窗口会打断采样，见 `SWEEPS_PER_UPLOAD`。
* **WiFi 上传 vs 跳频的矛盾**：已连路由器的 STA 不能跳信道，所以每个周期“扫描 → 一起回家信道 → 上传 → 在家信道 SYNC/ACK 会合 → 再扫描”。`SWEEPS_PER_UPLOAD` 越大越连续但延迟越高（默认 3 轮：约 2.2s 扫描 + 1.5~2.5s 上传）。上传时复用 BSSID/信道/静态 IP，重连约 0.3~0.6s。

### 固件要点（firmware/node_a、node_b）
* ESP-NOW 广播换台：A 发 3 次 HOP（间隔 2ms）后自己换台，B 在专用高优先级任务里 `esp_wifi_set_channel`；B 400ms 没听到 A 即回家信道，READY 超过 4 秒会在 1..13 信道轮询监听 A 的 SYNC（会合机制）。
* CSI 只取 L-LTF（6Mbps OFDM，`esp_wifi_config_espnow_rate(WIFI_PHY_RATE_6M)`），每条记录 144 字节：方向/信道/序号/RSSI/轮号/**硬件接收时间戳**/往返时间。CSI 与 ESP-NOW 帧用“回调时间最接近”配对（±1.5ms，帧间隔 5ms）。
* 每个信道停留 55ms（≥50ms）；同时输出日志到 USB 口和 UART 口。
* `CHANNEL_PLAN 0` 先跑 `[1,6,11]`，验证后改 `1` 用全信道；`ENABLE_UPLOAD 0` 可不联网只看同步统计。

### 沙盒验证记录（均为实测）
* **PlatformIO 真实编译**（espressif32@6.9.0 / Arduino 2.0.17）：Node A、Node B 的 `esp32s3` 环境均 SUCCESS（RAM 15%，Flash 26%）。
* **主机端回归**：`python3 tools/test_host.py --seed N`（空场不误报 / 走动检出 / 呼吸 15BPM→15.0 / 两目标 8m·14m 分辨 / [1,6,11] 稀疏流程 / 单向退化 / 错误密钥 401 / 坏数据 400），共跑 3 轮不同随机种子。仿真包含：每信道随机 PLL 相位、每帧随机采样偏移(±30ns)/常数相位/增益、5% 丢包、28dB 信噪比、int8 量化；数据字节与固件结构体逐字节一致。
* **浏览器**：无头 Chromium（SwiftShader WebGL）加载 3D 页面，无脚本错误；连上本地主机后出图；`/code` 三个标签页、每个文件都有「在 GitHub 编辑」「复制此文件」。
* ⚠ **沙盒没有两块真实 ESP32 与 GPU**：ESP-NOW 同步成功率、真实环境下的相位残差、T4×2 实际占用只能在你的硬件上验证——请把「检测日志」贴回来，我据此继续调（重点看 `[sync]` 丢失率、拼接相干度、配对数）。

### 无硬件自测
```bash
RADAR_NO_TUNNEL=1 python3 kaggle/csi_radar_kaggle.py &           # 本地主机端
python3 tools/sim_esp32_csi.py --scenario two --check            # 模拟两块 ESP32 上传
python3 tools/test_host.py --seed 1                              # 全套回归
```
