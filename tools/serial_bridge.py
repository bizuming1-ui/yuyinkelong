#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
串口桥（可选）：ESP32 不连 WiFi，只用 USB 线接电脑，由电脑把扫描结果转发到 Kaggle。
适合：ESP32 无法联网 / 嗅探时不想断开 WiFi / 手机热点不稳定。

用法：
    pip install pyserial requests
    python tools/serial_bridge.py --port COM5 --url https://xxxx.trycloudflare.com --key radar-key
    (Linux/macOS 的端口形如 /dev/ttyACM0、/dev/cu.usbmodem*)
固件 config.h 保持 WIFI_SSID 为占位符(YOUR_WIFI_SSID)即可：固件会只做扫描并从串口输出 RADARJSON 行。
"""
import argparse
import sys
import time

try:
    import requests
    import serial
except ImportError:
    sys.exit("请先运行: pip install pyserial requests")

ap = argparse.ArgumentParser()
ap.add_argument("--port", required=True)
ap.add_argument("--url", required=True, help="Kaggle 打印出的 https://xxxx.trycloudflare.com")
ap.add_argument("--key", default="radar-key")
ap.add_argument("--baud", type=int, default=115200)
args = ap.parse_args()

url = args.url.rstrip("/") + "/api/ingest"
ser = serial.Serial(args.port, args.baud, timeout=1)
print("已连接 %s，转发到 %s" % (args.port, url))
ok = fail = 0
while True:
    try:
        raw = ser.readline().decode("utf-8", "ignore").strip()
    except serial.SerialException as e:
        print("串口断开:", e)
        time.sleep(2)
        continue
    if not raw:
        continue
    if not raw.startswith("RADARJSON:"):
        print(raw)
        continue
    try:
        r = requests.post(url, data=raw[len("RADARJSON:"):].encode("utf-8"),
                          headers={"Content-Type": "application/json", "X-Key": args.key}, timeout=10)
        ok += r.status_code == 200
        fail += r.status_code != 200
        print("[bridge] HTTP %d  ok=%d fail=%d" % (r.status_code, ok, fail))
    except Exception as e:
        fail += 1
        print("[bridge] 上传失败:", e)
