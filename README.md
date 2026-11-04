## 📡 ESP32-S3 双节点 WiFi CSI 全信道拼接雷达（v9）

两块 ESP32-S3（仅 2.4GHz 802.11b/g/n）+ Kaggle（T4×2）主机端 + 浏览器模拟器。**ESP32 不用接电脑**：烧录后只要供电，数据通过 WiFi（HTTPS）上传到 Kaggle。

```
Node A ──ESP-NOW 跳频/探测──▶ Node B     （13 信道 × 8 次双向交换，每信道 55ms）
   └── 扫完 SWEEPS_PER_UPLOAD 轮 → 一起回路由器信道 → 各自 HTTPS POST 二进制 CSI
Kaggle：Flask + 内嵌网站 + 多隧道(cloudflared/pinggy/localhost.run) → 配对 → 相位标定 → 拼接 → IFFT(GPU0)/MUSIC+呼吸扫描(GPU1) → 感知
输出框：绿色按钮「🚀 打开 WiFi 成像系统」→ 整个 3D 网站（同源，自动连接，无需粘贴网址）
```

### v9.1 —— 修复 VSCode / PlatformIO 编译失败（本次更新）

| 问题（根因） | 修复 |
| --- | --- |
| **根因（沙盒复现）**：新版 PlatformIO / pioarduino 使用 Arduino-ESP32 **core 3.x（ESP-IDF 5）**，`esp_now_register_recv_cb` 的回调签名变成 `(const esp_now_recv_info_t*, data, len)`，旧写法报 `invalid conversion from 'void (*)(const uint8_t*, ...)' to 'esp_now_recv_cb_t'`，编译失败 | `radar_common.h` 加入 core 2.x / 3.x 兼容层（`RADAR_CORE3` + 回调适配器）；LED 在 core 3 用 `rgbLedWrite`；去掉 `volatile++`、`esp_wifi_config_espnow_rate` 弃用警告 |
| 仓库 `firmware/` 根目录还留着旧的单节点工程（platformio.ini + src + include），VSCode 打开 firmware 时会编译到旧工程 | 删除旧工程；复制代码界面里提供“在 GitHub 删除”旧文件按钮 |
| platformio.ini 含中文注释，个别 Windows 环境读取异常 | 两个 platformio.ini 改为纯 ASCII；新增 `esp32s3_core3` 环境（pioarduino），VSCode 底部切换即可 |
| 板子只供电、不接电脑时偶发卡死 | 无人值守看门狗：连续上传失败 40 次或堆内存 <16KB 自动重启 |
| 附近有多套雷达互相干扰 | `config.h` 新增 `PAIR_MAGIC`（配对编号），A/B 必须相同 |

沙盒实测：Node A / Node B × `esp32s3`、`esp32s3_core3`、`esp32s3_uart`、`esp32s3_n16r8` 共 8 个环境，连续 3 轮全部 SUCCESS（RAM 15% / Flash 26~30%）。协议、Kaggle 主机端与 `web/` 未改动，`tools/test_host.py` 3 个随机种子全 PASS。

### v9 相对 v8 的改动（以及为什么）

| 问题（批判性复盘） | v9 做法 |
| --- | --- |
| 网页报“请求超时(6s)”：原因可能是 ①Cell 停了/网址旧 ②cloudflared 默认 QUIC(UDP) 在 Kaggle 里不稳 ③**国内网络访问不了 trycloudflare.com**；v8 无法区分 | cloudflared 改 `--protocol http2 --edge-ip-version 4`；同时开 **pinggy + localhost.run** 备用隧道；Kaggle 内部每 15s 自检公网网址，连续失败自动重启并重新发布；网页超时 15s，并精确区分 **网络层不通 / 隧道已失效(530/1033) / 不是雷达主机**，每种给对应建议；网址框可一次粘贴多个网址，自动选通的 |
| Kaggle 输出框只有文字网址，没有网站 | 网站内嵌进 Kaggle 单文件（gzip+base64，约 260KB），Flask 的 `/` 直接提供；输出框用 IPython.display 显示按钮 + 全部网址 + 内嵌小窗；从 Kaggle 页打开时同源自动连接 |
| GPU 没用到 | 排查：Kaggle 没选 T4×2 时 torch 无 CUDA（网页和日志会明确提示）。v9：GPU0 做 16384 点 IFFT，GPU1 做 MUSIC + **全距离呼吸扫描**（256 个距离点一次矩阵乘），预留显存池，nvidia-smi 利用率/显存实时显示在网页。**诚实说明**：数据量约 40KB/s，GPU 不可能跑满，脚本不空转烧 GPU |
| 通道相位自动聚焦（autofocus）试验 | 做了 GPU 版并用回归测试 A/B：**会损伤两目标分辨 → 默认关闭**（`RADAR_AF=1` 可开）。逐通道锁定参考 `RADAR_CHLOCK=1` 中性，默认关 |
| ESP32 上传失败时不知道原因 | 固件失败时串口输出 DNS 体检与错误码含义，并把 `lerr`/当前网址随下一次上传带给 Kaggle（日志里直接看到）；DNS 备用 223.5.5.5；`KAGGLE_URL2/3` 备用网址失败自动轮换；ntfy 发现支持多网址 |
| 板子只供电时看不出状态 | 板载 RGB 灯：蓝=连路由器 黄=上传 绿=成功 红=失败 紫=等对端 青=扫描 |
| 磁盘 | 原始 CSI 落盘 `/tmp/radar_raw`（Kaggle `/tmp` 约 57GB），默认上限 min(40GB, 剩余−8GB)，滚动删除 |

### 怎么用（4 步）

1. **Kaggle**：Settings → Accelerator `GPU T4 x2`，Internet `On`；新建 Code Cell，粘贴 `kaggle/csi_radar_kaggle.py` 全部内容，运行。约 1 分钟后输出框出现绿色按钮和网址。
2. **浏览器模拟器 →「📋 复制代码」→ ③ PlatformIO**：填 WiFi、粘贴 Kaggle 网址（可多个），复制 Node A / Node B 各 4 个文件到两个 PlatformIO 工程（Board: ESP32-S3-DevKitC-1，Framework: Arduino）→ Build → Upload。
3. 两块板子只供电。串口（可选）：`[wifi] ✅` → `[upload] HTTP 200` → `[sync] ✅ Node B 已就绪` → `[sweep] …`。
4. 点 Kaggle 输出框里的按钮（或把网址粘到模拟器顶部）→ 看实时 3D。出问题点右上角「🩺 检测日志」复制。

### 构建网页（Vite）

```
cd web && npm install
node scripts/build-kaggle.mjs   # 先生成内嵌版网站并写入 generated/csi_radar_kaggle.py（= kaggle/csi_radar_kaggle.py）
npm run build
```

### 无硬件自测

```
python3 tools/test_host.py --seed 1      # 空场/走动/呼吸/两目标/稀疏/单向/401/400
RADAR_NO_TUNNEL=1 python3 kaggle/csi_radar_kaggle.py &
python3 tools/sim_esp32_csi.py --url http://127.0.0.1:8000 --scenario two --check
```

### 验证记录（沙盒实测）

* PlatformIO 真实编译（espressif32@6.9.0 / Arduino 2.0.17）：Node A、Node B 的 `esp32s3` / `esp32s3_uart` / `esp32s3_n16r8` 均 SUCCESS（RAM 15% / Flash 26%）。
* 主机回归 `test_host.py` 多轮不同随机种子全 PASS；cloudflared(http2) 与 localhost.run 在沙盒里真实建隧道并自检通过。
* 无头 Chromium：Kaggle 主机直接提供网站 → 同源自动连接 → 3D 出图无脚本错误；坏网址给出“网络层不通”提示；多网址自动选通的；复制代码界面每个文件都有「在 GitHub 编辑」「复制此文件」。
* ⚠ 沙盒没有两块真实 ESP32 与 GPU：ESP-NOW 同步率、真实相位残差、T4×2 实际占用只能在你的硬件上验证，请把「检测日志」贴回来。
* 物理边界不变：2 节点 = 1 条双基地链路，只有路径长度剖面（椭圆），不能成像/测角度；合成带宽约 76.6MHz，路径长度分辨率约 3.9m。
