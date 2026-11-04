## 📡 ESP32-S3 双节点 WiFi CSI 全信道拼接雷达（v10）

两块 ESP32-S3（仅 2.4GHz 802.11b/g/n）+ Kaggle（T4×2）主机端 + 浏览器模拟器。**ESP32 不用接电脑**：烧录后只要供电。

```
Node A（网关+指挥）──ESP-NOW 跳频/探测──▶ Node B（射频探头，不联网）   13 信道 × 8 次双向交换，每信道 55ms
   ▲  B 收到探测 → 立刻回复(REPLY) + 把自己测到的 CSI 单播(T_DATA，带 ACK 重传)发回 A
   └─ A 扫完 SWEEPS_PER_UPLOAD 轮 → 回路由器信道 → 分两次 HTTPS POST：node=0(A 的 H_BA) / node=1(B 的 H_AB)
Kaggle：Flask + 内嵌网站 + 多隧道 → 配对 → 相位标定 → 拼接 → IFFT(GPU0)/MUSIC+呼吸扫描(GPU1) → 感知
```

### v10 —— 针对「检测日志」的修复（本次更新）

检测日志显示：Node A / Node B 都在线、上传正常，但 **CSI 记录始终为 0**，并且两块板子反复重启（boot ID 一直在变，互相相隔几秒）。

| 批判性复盘 | v10 做法 |
| --- | --- |
| v9 里 A、B 都要在“回路由器上传”和“ESP-NOW 会合”之间来回切换，两块板的上传耗时不同，会合只能靠时间窗碰运气；B 还要跑 TLS（峰值电流大、栈/堆压力大） | **A=网关+指挥，B=纯射频探头**：B 不连 WiFi、不做 TLS，永远在 ESP-NOW 上待命；B 的 H_AB 用单播(T_DATA，MAC 层 ACK+重传)实时发回 A，由 A 代传。Kaggle 协议、记录格式（144 字节）完全不变 |
| 两块板几乎同时重启，且无从知道原因 | 固件把「上次复位原因（BROWNOUT/PANIC/看门狗…）」「复位前阶段」存进 RTC 内存并随心跳上报，Kaggle 事件里直接提示：欠压→换线/换电源；崩溃→贴串口回溯 |
| 无法判断是哪一层不通 | A 上报 `lnk=` 链路计数（同步窗口、探测、回复、配对 CSI、B 的数据帧、B 状态、发送错误、CSI 回调数）；检测日志新增「ESP-NOW 链路」项，分 4 层给出结论 |
| 发射 19.5dBm 对近距离是浪费，峰值电流大 | `TX_POWER_DBM` 默认 15；可选 `DISABLE_BROWNOUT` |
| loop 任务栈 8KB，TLS 握手偶发溢出 | `SET_LOOP_TASK_STACK_SIZE(16KB)` |
| B 晚上电 / 中途断电 / A 上传很久 | B 状态机 SCAN→FOLLOW→WAIT→SCAN：WAIT 停在 A 的路由器信道，超过 `B_WAIT_MS` 自动重扫 1..13 信道 |

只有 **Node A** 需要 WiFi 与 Kaggle 网址（手机热点请开“最大兼容性”= 2.4GHz）。`config.h`、`radar_common.h` 两个工程内容相同。

### 怎么用（4 步）

1. **Kaggle**：Settings → Accelerator `GPU T4 x2`，Internet `On`；新建 Code Cell，粘贴 `kaggle/csi_radar_kaggle.py` 全部内容，运行，约 1 分钟后输出框出现绿色按钮和网址。
2. **浏览器模拟器 →「📋 进入复制代码界面」→ ③ PlatformIO**：填 WiFi、粘贴 Kaggle 网址，复制 Node A / Node B 各 4 个文件到两个 PlatformIO 工程（Board: ESP32-S3-DevKitC-1，Framework: Arduino）→ Build → Upload。
3. 两块板子供电（用短而粗的 USB 线 + 充电头）。串口（可选）A：`[sync] ✅ Node B 已就绪` → `[sweep] …` → `[upload] node=A … HTTP 200` → `[upload] node=B … HTTP 200`；B：`[stat] state=2 …`。
4. 点 Kaggle 输出框里的按钮看实时 3D。出问题点右上角「🩺 检测日志」复制回来——现在它会指出具体哪一层不通。

### 无硬件自测

```
python3 tools/sim_protocol.py --legacy   # 协议状态机仿真（v10 与 v9 对比；丢包/上传耗时/B 晚上电/B 断电）
python3 tools/test_host.py --seed 1       # 主机端回归：空场/走动/呼吸/两目标/稀疏/单向/401/400
python3 tools/test_link_diag.py           # v10 链路分层诊断 + 复位原因事件
RADAR_NO_TUNNEL=1 python3 kaggle/csi_radar_kaggle.py &
python3 tools/sim_esp32_csi.py --url http://127.0.0.1:8000 --scenario two --check
```

### 验证记录（沙盒实测，每项 3 次）

* PlatformIO 真实编译（espressif32@6.9.0 / Arduino 2.0.17）：Node A、Node B × `esp32s3` / `esp32s3_uart` / `esp32s3_n16r8`，连续 3 轮全部 SUCCESS（RAM ≈15% / Flash ≈21~26%）。
* `esp32s3_core3`（pioarduino）：代码只使用 core2/core3 共有 API，保留 v9.1 的兼容层；但沙盒的 Python 环境无法安装 pioarduino 的 penv，**这个环境本次没能重新编译**，请用默认 `esp32s3` 环境。
* 协议仿真 `sim_protocol.py`：4 个场景 × 3 个随机种子全部达标（v10 同样条件下比 v9 多约 10~20% 扫描轮数）。**诚实结论**：仿真里 v9 的会合逻辑本身也能工作，所以“0 条记录”的真实根因更可能在射频层/供电（欠压重启）而不是时间窗；v10 把这些层全部做成可观测。
* 主机回归 `test_host.py` 3 个种子全 PASS；`test_link_diag.py` 3 轮全 PASS。
* ⚠ 沙盒没有两块真实 ESP32 与 GPU：ESP-NOW 实际同步率、CSI 回调是否触发、T4×2 占用只能在你的硬件上验证。GPU 利用率 0% 是因为目前没有任何 CSI 数据进来；链路通了之后 GPU 才会有负载（数据量约 40KB/s，不会跑满）。
* 物理边界不变：2 节点 = 1 条双基地链路，只有路径长度剖面，不能成像/测角度；合成带宽约 76.6MHz，路径长度分辨率约 3.9m。

---

## 以下为 v9 及更早的说明（保留）

### v9.1.1 —— 修复「编译报错路径在 .platformio\packages\framework-arduinoespressif32 里」（本次更新）

| 问题（根因，沙盒已复现） | 修复 |
| --- | --- |
| 报错文件是 `...\.platformio\packages\framework-arduinoespressif32\libraries\WiFiClientSecure\src\WiFiClientSecure.h:303`，几百行 `'WiFiClientSecure' was not declared`，`HTTPClient.cpp`、`WiFiClientSecure.cpp` 连带失败。**这不是固件语法错误**：框架里的 `WiFiClientSecure.h` 被覆盖成了 `radar_common.h` 的内容（`postRecs` / `KAGGLE_URL` / `RADAR_TOPIC` 都是我们的代码）。常见原因：Ctrl+点击 `#include <WiFiClientSecure.h>` 跳进框架头文件后把代码粘贴进去了 | 新增 `firmware/tools/fix_platformio.ps1` + `fix_platformio.bat`：扫描框架里含本项目代码的文件，删除被污染的框架缓存，下次 Build 自动重新下载干净版本。也可手动：关闭 VSCode → 删除 `%USERPROFILE%\.platformio\packages\framework-arduinoespressif32` → 重新 Build |
| 以后再被污染时看不出原因 | `radar_common.h` 增加自检：被二次加载时第一条编译错误就是中文 `#error` 提示（含修复方法）；`platformio.ini` 顶部增加排查第 0 条；复制代码界面 ③ 最上方新增红色修复卡片（命令一键复制） |
| 预防 | VSCode 设置 `files.readonlyInclude` 添加 `**/.platformio/packages/**`，框架文件变只读 |

沙盒实测（PlatformIO 6.2 + espressif32@6.9.0 / Arduino 2.0.17）：把 `radar_common.h` 覆盖进 `WiFiClientSecure.h` 后得到与你日志一致的报错 → 运行修复脚本（识别出被污染文件并删除框架）→ 重新 Build 成功（RAM 15.2% / Flash 26.2%）；连续 3 轮（含 HTTPClient.h 被污染、`esp32s3_core3`、`esp32s3_uart`、`esp32s3_n16r8`）全部通过。协议、Kaggle 主机端、`web/` 均未改动。

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
