## 📡 ESP32‑S3 N16R8 单节点 WiFi CSI 雷达（v13：看门狗 + USB 桥接 + 零断连主机 + 浏览器模拟器）

**只要 1 块 ESP32‑S3 N16R8（2.4GHz）** + **Kaggle（T4×2）** + **浏览器模拟器**。已删除双 ESP32 方案和旧 Next.js 前端。

```
ESP32‑S3 ──ping 网关 40Hz──▶ 路由器/热点回包 ──▶ 硬件 CSI(L‑LTF 64子载波)
   │ ① USB 桥接（推荐）：串口 "@C,…" 行 ─▶ 浏览器(Web Serial，Worker 心跳) ─▶ POST /api/ingest ─▶ Kaggle
   │ ② WiFi 直传：没有浏览器时，ESP32 自己 HTTP(S) POST ─▶ Kaggle
   └ 5 层看门狗：TWDT / WiFi / CSI / 上传 / 堆内存，任何卡死都会自愈；2048 条 PSRAM 环形缓冲
Kaggle：GPU0 65536 点 IFFT · GPU1 MUSIC · 运动/呼吸/反射体/无线设备检测 · 三条隧道守护 + 8s 保活 + 自动重启 + 本机看门狗 · 内嵌 3D 模拟器
```

### 目录
| 路径 | 说明 |
|---|---|
| `firmware/esp32s3/` | PlatformIO 工程（N16R8：16MB Flash + 8MB OPI PSRAM），3 个文件 |
| `kaggle/csi_radar_kaggle.py` | Kaggle 完整单文件（内嵌模拟器网页）。`*.template.py` 是未嵌入网页的源模板 |
| `src/`、`index.html`、`package.json`… | 浏览器模拟器（Vite + React + Tailwind），顶部有「连接 ESP32」「复制代码」 |
| `scripts/build-kaggle.mjs` | 把模拟器网页嵌入 Kaggle 单文件 |
| `tools/sim_esp32.py` | 无硬件仿真器，验证 Kaggle 主机整条链路 |

### 使用（3 步）
1. **Kaggle**：GPU T4×2 + Internet On → 新建 Code Cell → 粘贴 `kaggle/csi_radar_kaggle.py` → Run，打印出网址。
2. **PlatformIO**：新建 ESP32‑S3‑DevKitC‑1 / Arduino 工程，覆盖 `firmware/esp32s3/` 下 3 个文件 → 环境选 `n16r8` → Build → Upload；上传前关掉串口监视器。
3. **浏览器**：打开 Kaggle 网址 → 右上角「🔌 连接 ESP32」选串口 → 填 WiFi（存进 ESP32）。「📋 复制代码」里有全部文件。

### 上传失败 `PermissionError(13, '设备不识别此命令')`
Windows 串口在烧录中途掉线（USB 重新枚举/供电/速度）。默认已降到 460800；仍失败：用板子「UART」口、直插主板 USB、换短线、环境改 `n16r8_slow`(115200)、关闭所有占用串口的程序。详见 `platformio.ini` 注释。

### 重新构建（开发者）
```
npm install
node scripts/build-kaggle.mjs   # 生成 kaggle/csi_radar_kaggle.py
npm run build                   # 生成 dist/index.html
```

### 诚实的能力边界
单链路 20MHz：路径分辨率≈15m，无角度信息。能可靠检测：运动、静止人体呼吸、周围无线设备、路由器、静态多径反射体。不能：摄像头式成像、厘米级定位、任意物体的精确识别。
