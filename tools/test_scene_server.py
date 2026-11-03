#!/usr/bin/env python3
# v7 回归测试：「无人 → 不能判有人」+「有人走动 → 判有人」+ /api/scene 解说 + status.ai 字段
# 用法：服务端已启动（Kaggle 版 RADAR_NO_TUNNEL=1 RADAR_LLM=off，或 Next.js 站点）后：python tools/test_scene_server.py 8011
import sys, time, math, random, json, urllib.request
port = sys.argv[1] if len(sys.argv) > 1 else "8000"
BASE = "http://127.0.0.1:" + port
def post(path, obj):
    req = urllib.request.Request(BASE + path, data=json.dumps(obj).encode(), headers={"Content-Type": "application/json", "X-Key": "radar-key"})
    return json.loads(urllib.request.urlopen(req, timeout=5).read())
def get(path):
    return json.loads(urllib.request.urlopen(BASE + path, timeout=5).read())
random.seed(7)
EMPTY_S, WALK_S = 30, 16          # 空场 30 秒建立基线，然后走动 16 秒
t0 = time.time(); batch = []; last = 0; empty_s = []; walk_s = []; scenes = []
while True:
    ts = time.time() - t0
    if ts > EMPTY_S + WALK_S: break
    now_ms = time.time() * 1000
    if ts < EMPTY_S:
        d = 0.010 + random.random() * 0.002; m = 50 + (random.random() - .5) * 0.15
        if random.random() < 0.01: d += 0.2          # 孤立尖峰：Hampel 必须滤掉，不能误判有人
    else:
        d = 0.05 + 0.14 * abs(math.sin(2 * math.pi * 1.25 * ts)) + random.random() * 0.03; m = 50 + 3 * math.sin(2 * math.pi * 1.25 * ts)
    batch.append([round(now_ms), -48, round(m, 1), round(d, 4)])
    if ts - last >= 1.0:
        last = ts
        post("/api/csi", {"node": "S3-TEST", "v": batch}); batch = []
        s = get("/api/sense")["sense"]
        if s: (empty_s if ts < EMPTY_S else walk_s).append((ts, s))
        if int(ts) % 8 == 0: print("t=%2ds %s" % (ts, ("EMPTY" if ts < EMPTY_S else "WALK "), ), (s or {}).get("act"), "present=", (s or {}).get("present"), "level=", (s or {}).get("level"), flush=True)
    time.sleep(0.05)
time.sleep(3)
tail_empty = [s for ts, s in empty_s if ts > 14]                  # 基线建立后的空场
false_pos = [s for s in tail_empty if s["present"]]
ok_empty = len(tail_empty) > 5 and not false_pos
ok_walk = bool(walk_s) and any(s["present"] and s["act"] in ("walking", "moving") for ts, s in walk_s)
sc = get("/api/scene")
fr = get("/api/frames?since=0")["status"]
ok_scene = sc.get("ok") is True and isinstance(sc.get("scene"), str) and len(sc["scene"]) > 0
ok_ai = isinstance(fr.get("ai"), dict) and "state" in fr["ai"]
print("空场不误报(误报 %d/%d):" % (len(false_pos), len(tail_empty)), "PASS" if ok_empty else "FAIL")
print("走动检出:", "PASS" if ok_walk else "FAIL")
print("场景解说 /api/scene -> %r [%s]:" % (sc.get("scene"), sc.get("engine")), "PASS" if ok_scene else "FAIL")
print("status.ai 字段:", "PASS" if ok_ai else "FAIL", fr.get("ai"))
sys.exit(0 if (ok_empty and ok_walk and ok_scene and ok_ai) else 1)
