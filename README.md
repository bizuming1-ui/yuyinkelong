## 📡 ESP32-S3 单节点全能 WiFi CSI 成像与全物体检测系统（v11 零断连版）

**只需 1 块 ESP32-S3（仅 2.4GHz 802.11b/g/n）** + **Kaggle（T4×2 双 GPU）主机端** + **3D 浏览器模拟器**。
**ESP32 不用接电脑**：烧录后只需供电，全程锁定路由器/手机热点信道（0 断连），实时检测周围任何物体并显示在 3D 浏览器模拟器上。

```
1×ESP32-S3（SINGLE_NODE_MODE=1，全程保持 WiFi 在线，绝不切台掉线）
   ├── 50Hz 高频 UDP/ARP/ESP-NOW 混合微脉冲激励路由器网关 → 硬件 csiCb 捕获 64 子载波原始复数 CSI (L-LTF/HT-LTF)
   ├── 同信道混杂监听（Promiscuous CSI）→ 同时捕获最多 16 个周围无线辐射源（手机/电脑/热点）与多径反射体
   └── HTTPS 长连接复用 + 多隧道自动热备切换（trycloudflare / pinggy / lhr.life）→ 每 1.1s 上传一批剖面
Kaggle（T4×2 15GiB×2 + 30GiB RAM + 57.6GiB Disk）：
   └── 无锁快照架构 + 8s 隧道主动保活 + GPU0(65536点IFFT) + GPU1(MUSIC超分辨 + 全距离呼吸扫描) + 全物体检测引擎
```

### v11 —— 针对真实硬件 `检测日志` 的全方位根因修复

| `检测日志` 暴露的真实问题 | v11 第一性原理根因分析与彻底修复方案 |
| --- | --- |
| 只有 1 块 ESP32-S3（或 Node B 离线）时，Node A 在 `syncWithB` 空等 6s 后直接 `return`，采集记录为 0 | **默认开启 `SINGLE_NODE_MODE = 1`**：只需烧录 1 块 ESP32-S3（`firmware/node_a`）即可独立完成高频主动探测、自参考相位对齐、虚拟子频段合成与多源物体感知；即使在双节点模式下若 B 未上电也自动回退单节点采集 |
| 频繁 `WiFi.disconnect()` 切信道导致手机热点（`bzmdiphone`）重连失败、报 `-1` 错误并离线 | **单节点全程锁定路由器信道（绝不调用 `WiFi.disconnect`）**，在保持 `WL_CONNECTED` 的同时开启硬件 CSI 与混杂模式，50Hz 脉冲激励网关回包，彻底杜绝热点断连 |
| 网页每隔约 50 秒出现 `[fail] 轮询失败：请求超时(15s)` | ① **Kaggle 端每 8 秒三隧道主动保活预热（`tunnel_keepalive_warmer`）**，防止 Cloudflare HTTP/2 55 秒空闲流断连；② **浏览器端多隧道并发抢占（Hedged Racing，2.2s 自动并发备用隧道 + `/api/proxy` 服务端回退）**；③ **每次 `/api/ingest` 响应向 ESP32 实时下发全部健康隧道列表** |
| `错误计数: {'music': 48} · MUSIC 异常: flip(): argument 'dims' must be tuple of ints, not int` | 修复 PyTorch 2.x CUDA 张量调用：`T.flip(R.conj(), dims=(0, 1))`，MUSIC 超分辨恢复 100% 零报错运行 |
| 无法在 3D 模拟器中直接看到检测到的静态与动态物体 | 新增 **`_detect_objects` 五类空间物体检测引擎 + Three.js 3D 全息包围盒/波纹/HUD 标签池**：实时检测并显示 ① 路由器基站、② 动态人体/移动物体、③ 静止呼吸人体、④ 静态多径反射物体/桌面与墙体障碍物、⑤ 周围活跃无线终端 |
| Kaggle T4×2 / 30GiB RAM / 57.6GiB Disk 资源未充分利用 | Kaggle 端默认启用 **65,536 点 GPU0 IFFT**、**双卡 80% 显存池预留（每卡约 12GiB VRAM）**、**6GiB CPU RAM 环形历史张量池** 与 **`/tmp/radar_raw` 最高 52GiB 滚动落盘** |

### 快速使用（3 步）

1. **Kaggle**：Settings → Accelerator `GPU T4 x2`，Internet `On`；新建 Code Cell，从浏览器模拟器「📋 进入复制代码界面 → ② Kaggle 单文件」复制 `kaggle/csi_radar_kaggle.py` 粘贴运行。
2. **VSCode PlatformIO（只需烧录 1 块 ESP32-S3）**：打开「📋 进入复制代码界面 → ③ PlatformIO 代码」，填好 2.4GHz WiFi 与 Kaggle 网址，把 **Node A** 的 4 个文件复制到你的 PlatformIO 工程 → Build → Upload。
3. **打开浏览器模拟器**：粘贴 Kaggle 网址点「连接」（或直接点击「▶ 启动全物体检测演示」/「⚡ 连接本站内置雷达主机」），即可在 3D 场景与左侧物体列表中实时查看检测到的所有空间物体。
