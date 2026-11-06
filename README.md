## 📡 三 ESP32-S3 N16R8 · WiFi CSI 三维感知系统（v8：A 发射 / B、C 接收 · MQTT · 2.5D 概率成像 · Kaggle 稳定方案(v8 无隧道) · GitHub Pages 永久网址）

三块 ESP32-S3 摆成三角形：**A = 发射端 TX**，**B = 接收端 RX1**，**C = 接收端 RX2**。三块板只要供电 + 同一个 2.4GHz WiFi，数据经 MQTT 到浏览器；`dist/index.html` 是**单文件**，双击、任意静态托管、或在 Kaggle 里经隧道都能打开。

```
            A（发射端 TX，100Hz ESP-NOW HT-MCS0 探测帧，带序列号）
           ╱ ╲
          ╱   ╲            固定在路由器当前信道（HT20），不扫频、不拼接
         B ─── C           B/C：CSI 回调只拷贝 → 环形缓冲(PSRAM) → loop 里批量 MQTT 发布
A/B/C ── WiFi ─▶ MQTT 公共服务器(hivemq / emqx / mosquitto) ◀── 浏览器（WSS 同时连 3 个，任一断线不中断）
                           │
                           ▼
 浏览器：B/C 各自独立特征提取(features.ts) → 非相干特征级融合 → 双基地几何粒子滤波(pf.ts) → Three.js 概率点云
 Kaggle：托管同一份网页 + 隧道网址 + MQTT 原始 CSI 落盘 + T4×2 GPU 离线分析（kaggle/kaggle_cell.py）
```

## v9 · 「👁 过路成像」—— 解决「物体经过时只看到一大片蓝色平板/椭圆，看不懂」

**从你的视频逐帧得到的事实**：界面里「三角阵列边长」是 0.40 m，物体经过时旧的 2.5D 曲面变成整块蓝色大平板 + 多圈椭圆，「模型自洽 23% / 模型不收敛」。根因：Imager25D 对「公共增益」做了边缘化 → 距离不可观测；且小基线时 A→B、A→C 两路几乎相同 → 后验被摊平，没有「物体」这个概念。

| 项目 | 说明 |
| --- | --- |
| src/lib/tri/passage.ts | 过路成像引擎：两路链路活动 aB/aC（快攻慢降）→ 总强度 T（远近）+ 侧向指数 L（偏 B / 偏 C）→ 紧凑后验（强度似然 × 侧向似然 × 前方弱先验）→ 估计位置、不确定度、速度、方向（B→C / C→B）、靠近/远离、过路事件记录、静态物体层。确定性，无随机数 |
| src/lib/tri/passageScene.ts | Three.js 渲染：彩色物体峰（高度=强度）· 青色山脊拖尾 · 紫色「可能区域」（诚实显示歧义）· 橙色静止物体层 · A→B/A→C 光束与脉冲（越扰动越粗越红越快）· 圆球+箭头+轨迹 · 底部 12 秒时间轴 HUD。60fps 指数平滑；鼠标左键旋转 / 右键平移 / 滚轮缩放 / 触屏双指 |
| src/components/PassageView.tsx | 状态横幅（等待数据 / 校准 / 环境平稳 / 检测到物体+方向）、「怎么看这张图」说明、最近经过记录；左上角可在「👁 过路成像（推荐）」与「🗺 概率层析（原版，功能不变）」之间切换 |
| src/lib/tri/sim.ts | 新增 SimPass / SimMix：B 侧→C 侧、C 侧→B 侧的清晰过路演示（SIMULATION） |
| tools/tri_passage_test.ts | `npx tsx tools/tri_passage_test.ts 3`：空房 120s 零假目标；B→C / C→B 方向正确；出现延迟 ≤0.6s；宽阵列位置相关 ≥0.6；单链路掉线仍可检出；确定性。全部标注 SIMULATION_ONLY |

**诚实边界（务必阅读）**
* 你的照片里 B/C 相距较远（宽三角形），此时左右方向、位置才可分辨；界面里「三角阵列边长」请填真实天线中心距（建议 ≥1.5 m）。边长 <0.8 m 时 B/C 两路几何重合，只能判断「有无 / 强弱 / 大致远近」，方向在物理上不可分辨（引擎对此如实提示，不瞎猜）。
* 高度 = 概率强度，不是物体高度；前/后存在镜像歧义，已加入「物体在 B/C 前方（远离 A）」的弱先验；静止物体依赖空房基准，不是「看得见一切」。
* 以上测试均为合成数据；真实精度必须在你的硬件上实测。

## v8 · Kaggle「Oops something went wrong / Draft Session Fatal / status code 44」——换思路，删掉根因

| 项目 | 说明 |
| --- | --- |
| kaggle/kaggle_cell.py | **粘贴进 Kaggle 第一个单元的唯一文件（v8.0）**。纯 Python 标准库，几秒完成并自己结束：检测永久网址 → 打印网址 → 保存单文件模拟器到 `/kaggle/working/simulator.html` → 检测 GitHub 最新提交 / 你粘贴的单元是否最新。**没有隧道、没有守护进程、没有后台线程、没有 while 循环** |
| .github/workflows/pages.yml | 推送到 main 自动构建并发布到 GitHub Pages：https://bizuming1-ui.github.io/yuyinkelong/ 。一次性设置：Settings → Pages → Source 选 **GitHub Actions** |
| tools/gen_manifest.mjs | `npm run dev/build` 之前自动运行，把仓库真实文件原文收集进「复制代码界面」（`src/lib/manifest.generated.json`，已 gitignore） |
| 已删除 | `kaggle/bzm_daemon.py`、`tools/make_kaggle_cell.py`、`src/lib/manifest-data.ts`（复制代码界面的「🗑 GitHub 上多余的旧文件」标签会提醒你在 GitHub 删除它们） |

**根因（第一性原理，不是猜测）**：v5/v6/v7 的共同点不是“输出方式”，而是它们都在 Kaggle 里**拉起公网隧道（cloudflared / localhost.run）并长时间运行**。你的 v7 截图里，网址 `https://xxx.trycloudflare.com` 已经打印出来（= 隧道已建立）之后才弹出 Oops；而 v7 已经把输出改成纯文本，所以“富输出崩溃”的旧结论被证伪。社区公开反馈：Kaggle 会封禁/终止除 ngrok 以外的隧道（cloudflared、localtunnel、SSH 隧道），症状就是会话突然 Fatal 且没有有用报错。v8 因此直接删除 Kaggle 里的隧道 / 守护进程 / GPU 初始化 / MQTT 长连接：

1. 网站托管在 **GitHub Pages**（永久网址，不依赖 Kaggle，也不依赖你的电脑）。
2. ESP32 → MQTT → 浏览器 的数据链路本来就不经过 Kaggle，所以即使 Kaggle 掉线，实时检测也不会中断。
3. GitHub Pages 还没开通时（目前就是 404），Kaggle 单元会自动从 GitHub 源码在本机构建同一个单文件网页（构建结束进程全部退出），保存到 `simulator.html`，从右侧 Output 面板下载后双击即可用。
4. 可选：`ENABLE_NGROK = True` + Kaggle Secrets 里的 `NGROK_AUTHTOKEN` → 单元内启动 stdlib HTTP 服务 + ngrok（社区验证过可用的唯一隧道；默认关闭）。

沙盒实测（Linux）：`python kaggle/kaggle_cell.py` 约 35 秒（含 npm 构建）完成，退出码 0，运行结束后没有残留进程；输出约 20 行纯文本。**诚实边界**：我无法登录你的 Kaggle 账号实机运行；若 v8 仍弹窗，请把弹窗前最后一次输出发给我——此时嫌疑只剩 Kaggle 平台本身（例如账号未验证手机号、Internet 开关、会话被网页闲置超时）。

## v5 · 2.5D 概率成像（Imager25D）+ Kaggle 稳定性修复

| 项目 | 说明 |
| --- | --- |
| `src/lib/tri/imager25d.ts` | 网格后验成像器：64×64 精确贝叶斯网格滤波（预测=可分离高斯运动先验，更新=双基地幅度似然 + 公共增益边缘化，与 pf.ts 同模型）。确定性、无随机数。输出 grid / MAP / 均值 / 协方差 / 熵 / spread / fit / conf25d / 50%·90% 可信区域 / 降级原因 |
| `src/lib/tri/scene.ts` | 2.5D 曲面：DataTexture + 顶点着色器位移（高度 = 概率强度），热力色、光照浮雕、50%/90% 等高线、MAP 标记；渲染端每帧指数平滑 → 60fps 丝滑；无数据/无运动自动淡出 |
| `src/components/TriApp.tsx` | 「🗺️ 2.5D 概率成像」面板：conf25d、熵、spread、MAP/均值、降级原因、图层开关、俯视热力图；右上角「🔌 连接 ESP32 / 🩺 检测日志 / 📋 复制代码」保持不变 |
| `tools/tri_imager_test.ts` | `npx tsx tools/tri_imager_test.ts 3`：同模型/失配/空房/单路退化/重复观测不重复计权/完整流水线/确定性，**全部标注 SIMULATION_ONLY**，失败 exit(1) |
| `kaggle/kaggle_cell.py` | 修复 Kaggle 弹窗 *Oops something went wrong / Draft Session Fatal*：构建与 node_modules 放 `/tmp/bzm`（不在 `/kaggle/working`）；CSI 原始数据落 `/kaggle/temp`（上限 500MB）；输出框用 `clear_output` 恒定大小；torch/CUDA 放独立子进程；MQTT client_id 随机；cloudflared 强制 http2；新增 `/api/health` |

**诚实边界**：2.5D 的「高度」=后验概率强度，不是人体/物体高度；只有运动目标可见（静止物体与空房不可区分）；两路接收只有 2 个标量约束，MAP 峰值会出现弧形歧义，所以界面同时给出均值、不确定度和可信区域；conf25d 是启发式分数，未经独立实测校准。三块普通 ESP32-S3 不能做照片级点云。Kaggle GPU 只做离线特征分析：没有带真值标签的实测数据前，不把未训练模型放进检测路径（提示词 6.9）。


## 本版做了什么（对照仓库「提示词」文件）

| 提示词要求 | v4 做法 |
| --- | --- |
| A 发射，B/C 接收，路由器不是探测源 | 固件 `firmware/esp32-a|b|c`：A 只发 ESP-NOW 探测帧；B/C 只处理来自 A 的 MAC 的 CSI；**移除了 v3 的路由器 ping 链路** |
| 不做 13 信道轮询/跨信道拼接 | **移除扫频**：三块板固定在 AP 当前信道；固件每 2s 核验信道，变化会记录 `chChg` 并在串口/状态里报告 |
| CSI 回调内只做最少操作 | `csiCb`：读元数据 + `memcpy(128B)` + 入环形缓冲 + 计数，立即返回；JSON/MQTT 全在 `loop()` |
| 序列号配对，量化配对率 | A 帧带 `seq`；B/C 用 FIFO + 8ms 时间窗把 CSI 与 ESP-NOW 回调配对，记录里带 `paired` 标志；状态里有 `paired / unpaired` 计数，界面显示配对率 |
| 有界队列、丢弃并计数、boot_id | 1024 条 PSRAM 环形缓冲；满则丢新数据 `drop++`；每批头带 `boot_id`、累计 drop；记录带 `rxCnt` 可检测缺失 |
| 原始 I/Q 不做不可逆归一化 | 原样上传 int8（虚部,实部）×64 子载波；协议 v3 见 `src/lib/tri/protocol.ts` 注释 |
| 状态机与可查询状态 | `WIFI_CONNECT → MQTT_CONNECT → RUNNING / NO_PROBE`；`<root>/n1|n2|n3/status`（retained + 遗嘱）+ 串口 `key=value` 日志 |
| 不用 B/C 相干相加；先独立分析再特征融合 | `features.ts`：只用幅度类特征（子载波湍流 / 偏离背景 / 功率），B、C 各自自适应噪声底，再融合 |
| 双基地路径模型 + 最小二乘/概率 | `pf.ts`：`L_i(p)=‖p−t‖+‖p−r_i‖`，双基地雷达方程 `w_i ∝ 1/(‖p−t‖‖p−r_i‖)`，对数域似然 + 公共增益解析边缘化，粒子滤波输出**概率云 + 不确定度** |
| 不伪造、不静默降级 | 无数据时不播放任何动画，显示「等待数据 / 校准中」；演示模式整屏 **SIMULATION** 横幅；位置标注「估计，不是测量」，高度标注「先验，不可观测」 |
| Kaggle 不是永久服务器 | `kaggle/kaggle_cell.py`：只做网页托管 + 隧道 + 采集落盘 + GPU 离线分析；设备→浏览器链路不依赖 Kaggle |

## 目录

| 路径 | 说明 |
| --- | --- |
| `firmware/esp32-a|b|c/` | PlatformIO 工程（各 4 个文件，唯一区别是 `config.h` 的 `NODE_ROLE`）。**已用 PlatformIO（espressif32@6.9.0，n16r8）真实编译通过，0 警告** |
| `firmware/esp32-1|2/` | v3 双节点旧固件（原样保留） |
| `src/components/TriApp.tsx` | 主界面：右上角「🔌 连接 ESP32」「🩺 检测日志」「📋 复制代码」；左侧设备/检测/位置/设置/网址 |
| `src/lib/tri/` | `protocol`（v3 帧）`features`（CSI→运动特征）`pf`（粒子滤波）`geometry` `hub`（MQTT 多服务器）`scene`（Three.js 点云）`sim`（SIMULATION/测试用合成数据） |
| `src/components/CodeBrowser.tsx` + `src/lib/manifest*.ts` | 复制代码界面：每个文件「✏️ 在 GitHub 编辑 / 📋 复制此文件 / ⚡ 复制并去 GitHub」，**实时检测每个文件是否已和 GitHub 一致**（Git blob SHA 比对，每 60 秒 + 每次切回页面），可下载 ZIP；清单由 Vite 在构建时自动收集真实文件，永远不会漏文件 |
| `src/components/RadarApp.tsx` 等 | 旧版双节点模拟器，地址 `#/legacy`，功能不变 |
| `kaggle/kaggle_cell.py` | 粘贴进 Kaggle 第一个单元即可运行 |
| `tools/tri_sim_test.ts` `tools/tri_e2e.ts` | 无硬件验证：协议往返 / CSI 特征流水线 / 粒子滤波；经真实公共 MQTT 的端到端联调 |

## 使用

1. 浏览器打开网站 →「📋 复制代码」→ 把需要的文件逐个「复制并去 GitHub」提交（页面顶部会列出还没同步的文件）。
2. 「PlatformIO · ESP32-A / B / C」三个标签：填 WiFi → 4 个文件覆盖进各自的 PlatformIO 工程（或下载工程 ZIP）→ 环境 `n16r8` → Upload。串口出现 `[BOOT] ESP32-S3 CSI v4.0` 与 `[状态] role=…` 即成功。三块板 WiFi 必须一致。
3. 三块板上电后，网页自动连接（也可点「🔌 连接 ESP32」）。把「阵列边长」改成实际天线中心距。
4. 想看效果但没硬件：左侧「▶ 启动 SIMULATION 演示」。
5. Kaggle：Internet On（CPU 即可）→ 复制 `kaggle/kaggle_cell.py` 到第一个单元 → Run → 输出框里出现永久网址 `https://bizuming1-ui.github.io/yuyinkelong/`（并保存 `simulator.html`）。

开发：`npm install && npm run dev`；`npm run build` 生成单文件 `dist/index.html`；`npx tsx tools/tri_sim_test.ts 3` 连续 3 轮验证。

## 诚实的能力边界（请务必阅读）

* **本系统不能像摄像头/激光雷达那样还原沙发、书架的「照片级」点云。** 那类图片是视觉效果；三块普通 ESP32-S3 不是相干 MIMO 阵列（三块板的本振/相位互不相干），20MHz 带宽的时延分辨率约 15m 量级，且只有 2 路接收 → 只有 **2 个标量约束**。
* 能做到并已实现：**有无运动、运动强弱、每条链路（A→B、A→C）的扰动、粗略方位/距离的概率云（含不确定度）、轨迹趋势**。静止的人不会产生运动特征，因此「空房」与「有人静坐」暂不能区分。
* 阵列越小越没有位置信息：边长 0.3m 时只能判断「有无/强弱/大致方向」；想得到更像样的位置云，请把 A/B/C 拉开 ≥ 2m 并在界面里如实填写。
* 合成数据验证（`tools/tri_sim_test.ts`，连续 3 轮）：空房 120s 误报 0%；运动检出 ≥97%；首次检出 0.4s；2m 阵列定位 RMSE≈1.4m（猜中心基线 1.8m），0.3m 阵列≈基线——这是**合成数据**上的结果，不是硬件实测。真实精度、配对率、连续运行时间必须在你的硬件上按提示词 Stage 1–3 实测后才能声明。
* 公共 MQTT 服务器仅用于连通与演示；长期/隐私数据请改用自己的 Broker（界面「追加」自定义 WSS，固件改 `MQTT_BROKERS`）。
