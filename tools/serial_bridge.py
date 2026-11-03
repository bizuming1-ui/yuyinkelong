#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
串口桥（可选）：ESP32 不连 WiFi，只用 USB 线接电脑，由电脑把扫描结果转发到 Kaggle。
网页里的「USB 连接 ESP32」已经能做同样的事；本脚本用于浏览器没有 Web Serial（Firefox/Safari）或想后台常驻时。

用法：
    pip install pyserial requests
    python tools/serial_bridge.py --port COM5 --url https://xxxx.trycloudflare.com --key radar-key
    (Linux/macOS 的端口形如 /dev/ttyACM0、/dev/cu.usbmodem*)
    不带 --port 会列出所有串口。加 --reset 会用 RTS 脉冲复位 ESP32（DTR 保持低 = 正常启动，不进下载模式）。
固件 config.h 保持 WIFI_SSID 为占位符(YOUR_WIFI_SSID)即可：固件只做扫描并从串口输出 RADARHELLO / RADARHB / RADARJSON 行。
"""
import argparse
import json
import sys
import time

try:
    import requests
    import serial
    from serial.tools import list_ports
except ImportError:
    sys.exit("请先运行: pip install pyserial requests")

ap = argparse.ArgumentParser()
ap.add_argument("--port")
ap.add_argument("--url", help="Kaggle 打印出的 https://xxxx.trycloudflare.com")
ap.add_argument("--key", default="radar-key")
ap.add_argument("--baud", type=int, default=115200)
ap.add_argument("--reset", action="store_true", help="连接后复位 ESP32")
args = ap.parse_args()

if not args.port or not args.url:
    print("可用串口：")
    for p in list_ports.comports():
        print("  %-12s %s (VID:PID=%04X:%04X)" % (p.device, p.description, p.vid or 0, p.pid or 0))
    sys.exit("请用 --port 和 --url 指定端口与网址")

url = args.url.rstrip("/") + "/api/ingest"
ser = serial.Serial()
ser.port, ser.baudrate, ser.timeout = args.port, args.baud, 1
ser.dtr = False   # 必须在 open 之前设置，避免打开串口时把 ESP32 拉进下载模式
ser.rts = False
ser.open()
print("已连接 %s，转发到 %s" % (args.port, url))
if args.reset:
    ser.rts = True
    time.sleep(0.16)
    ser.rts = False
    print("[bridge] 已复位 ESP32")
ser.write(b"hello\n")
ok = fail = frames = bytes_seen = 0
t0 = last = time.time()
while True:
    try:
        raw = ser.readline().decode("utf-8", "ignore").strip()
    except serial.SerialException as e:
        print("串口断开:", e)
        time.sleep(2)
        continue
    now = time.time()
    if not raw:
        if now - last > 6:
            print("[bridge] ⚠ %d 秒没有收到任何串口数据：换板子另一个 USB 口 / 关闭串口监视器 / 重新烧录新版固件" % (now - t0))
            last = now
        continue
    last = now
    bytes_seen += len(raw)
    if raw.startswith("RADARHB:"):
        continue
    if raw.startswith("RADARHELLO:"):
        try:
            h = json.loads(raw[11:])
            print("[bridge] 固件 v%s %s 复位原因=%s" % (h.get("fw"), h.get("node"), h.get("rst")))
        except ValueError:
            pass
        continue
    if not raw.startswith("RADARJSON:"):
        print(raw)
        continue
    frames += 1
    try:
        r = requests.post(url, data=raw[len("RADARJSON:"):].encode("utf-8"),
                          headers={"Content-Type": "application/json", "X-Key": args.key}, timeout=10)
        ok += r.status_code == 200
        fail += r.status_code != 200
        print("[bridge] 帧 %d -> HTTP %d  ok=%d fail=%d%s" % (frames, r.status_code, ok, fail, "  (API_KEY 不一致)" if r.status_code == 401 else ""))
    except Exception as e:
        fail += 1
        print("[bridge] 上传失败:", e)
