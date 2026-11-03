#!/usr/bin/env python3
# 沙盒/本机验证：向本地 Kaggle 服务端注入「合成 CSI」，检查 /api/sense 能否判断 无人→呼吸→走动
# 用法：先 RADAR_NO_TUNNEL=1 RADAR_PORT=8011 python kaggle/wifi_radar_kaggle.py &   再 python tools/test_csi_server.py 8011
import sys, time, math, random, json, urllib.request
port = sys.argv[1] if len(sys.argv) > 1 else "8000"
BASE = "http://127.0.0.1:" + port
def post(path, obj):
    req = urllib.request.Request(BASE + path, data=json.dumps(obj).encode(), headers={"Content-Type": "application/json", "X-Key": "radar-key"})
    return json.loads(urllib.request.urlopen(req, timeout=5).read())
def get(path):
    return json.loads(urllib.request.urlopen(BASE + path, timeout=5).read())
random.seed(1)
t0 = time.time(); fw0 = 100000; res = []
def phase(ts):  # 0-34 s 呼吸(静止) 34-48 s 走动
    return "still" if ts < 34 else "walk"
last_report = 0; batch = []
while True:
    ts = time.time() - t0
    if ts > 50: break
    now_ms = time.time() * 1000
    br = math.sin(2 * math.pi * 0.27 * ts)
    if phase(ts) == "still":
        d = 0.010 + random.random() * 0.004; m = 50 + 0.8 * br + (random.random() - .5) * 0.2
    else:
        d = 0.05 + 0.14 * abs(math.sin(2 * math.pi * 1.25 * ts)) + random.random() * 0.03; m = 50 + 3 * math.sin(2 * math.pi * 1.25 * ts)
    batch.append([round(now_ms), -48, round(m, 1), round(d, 4)])
    if ts - last_report >= 1.0:
        last_report = ts
        post("/api/csi", {"node": "S3-TEST", "v": batch}); batch = []
        s = get("/api/sense")["sense"]
        if int(ts) % 6 == 0 and s: print("t=%2ds %s -> act=%s level=%s breath=%s snr=%s present=%s gpu=%s" % (ts, phase(ts), s["act"], s["level"], s["breath"], s["snr"], s["present"], s["gpu"]), flush=True)
        res.append((ts, s))
    time.sleep(0.05)
still = [s for ts, s in res if 30 < ts < 34 and s]
walk = [s for ts, s in res if 44 < ts < 50 and s]
ok1 = any(abs(s["breath"] - 16.2) < 2.0 for s in still)
ok2 = bool(walk) and walk[-1]["present"] and walk[-1]["act"] in ("walking", "moving")
print("呼吸检测(期望≈16.2 BPM):", "PASS" if ok1 else "FAIL", "| 走动检测:", "PASS" if ok2 else "FAIL")
sys.exit(0 if (ok1 and ok2) else 1)
