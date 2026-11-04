## 📡 ESP32‑S3 单节点 WiFi CSI 雷达（v12：看门狗 + USB 桥接 + 零断连主机）

**只要 1 块 ESP32‑S3（2.4GHz）** + **Kaggle（T4×2）** + **浏览器模拟器**。已删除双 ESP32 方案。

```
ESP32‑S3 ──ping 网关 40Hz──▶ 路由器/热点回包 ──▶ 硬件 CSI(L‑LTF 64子载波)
   │ ① USB 桥接（推荐）：串口 "@C,…" 行 ─▶ 浏览器(Web Serial) ─▶ POST /api/ingest ─▶ Kaggle
   │ ② WiFi 直传：没有浏览器时，ESP32 自己 HTTP(S) POST ─▶ Kaggle
   └ 5 层看门狗：TWDT / WiFi / CSI / 上传 / 堆内存，任何卡死都会自愈
Kaggle：GPU0 65536 点 IFFT · GPU1 MUSIC · 运动/呼吸/无线设备检测 · 三条隧道守护+8s 保活+自动重启 · 内嵌 3D 模拟器
```

### 为什么之前 ESP32 连不上（根因）
1. ESP32 只有 2.4GHz；iPhone 热点默认 5GHz 不可见，必须开「最大兼容性」。v12 开机先扫描并用中文报出附近热点与失败原因码。
2. ESP32 自己做 TLS 访问 trycloudflare：堆内存/握手/DNS 任何一环失败就“从未收到上传”。v12 默认由浏览器经 USB 转发，ESP32 不再需要外网。
3. 旧版把同一信道数据伪造成 13 信道「拼接」，物理上不成立；v12 删除了这种伪造。

### 使用（3 步）
1. **Kaggle**：GPU T4×2 + Internet On → 新建 Code Cell → 粘贴 `kaggle/csi_radar_kaggle.py` → Run，打印出网址。
2. **PlatformIO**：新建 ESP32‑S3‑DevKitC‑1/Arduino 工程，覆盖 `firmware/esp32s3/` 下 3 个文件 → Build → Upload；关掉串口监视器。
3. **浏览器**：打开 Kaggle 网址 → 右上角「🔌 连接 ESP32」选串口 → 填 WiFi（存进 ESP32）。「📋 复制代码」里有全部文件。

### 诚实的能力边界
单链路 20MHz：路径分辨率≈15m，无角度信息。能可靠检测：运动、静止人体呼吸、周围无线设备、路由器。不能：摄像头式成像、厘米级定位。
