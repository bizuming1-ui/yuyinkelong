#!/usr/bin/env python3
"""验证 Next.js 内置服务端（/api/ingest /api/csi /api/frames /api/sense /api/diag）。
用法：python3 tools/test_next_server.py [http://127.0.0.1:3000]
合成信号：前 34 秒静止（呼吸 16.2 次/分），随后 12 秒走动（湍流升高）。"""
import json, math, random, sys, time, urllib.request, urllib.error

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3000").rstrip("/")
ok_all = True


def call(path, data=None, key="radar-key", raw=None):
    body = raw if raw is not None else (json.dumps(data).encode() if data is not None else None)
    req = urllib.request.Request(BASE + path, data=body, method="POST" if body is not None else "GET")
    if body is not None:
        req.add_header("Content-Type", "application/json")
    if key:
        req.add_header("X-Key", key)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read().decode() or "null") if "json" in r.headers.get("content-type", "") else r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, None


def check(name, cond, extra=""):
    global ok_all
    ok_all &= bool(cond)
    print(("PASS " if cond else "FAIL ") + name, extra)


frame = {"node": "S3-TEST01", "seq": 1, "fw": "5.0.0", "x": 0, "y": 0, "aps": [{"b": "AA:BB:CC:00:00:01", "s": "TestAP", "r": -55, "c": 6, "e": 3}], "st": []}
s, j = call("/api/reset", {})
check("reset", s == 200)
s, j = call("/api/ingest", frame, key="wrong")
check("坏密钥 → 401", s == 401, s)
s, j = call("/api/ingest", None, raw=b"{not json")
check("坏 JSON → 400/401", s in (400, 401), s)
s, j = call("/api/ingest", {"node": "x"})
check("缺 aps → 400", s == 400, s)
s, j = call("/api/ingest", frame)
check("好帧 → 200", s == 200 and j and j.get("ok"), j)
s, j = call("/api/frames?since=0")
check("frames 读到帧", s == 200 and j["frames"] and j["frames"][0]["node"] == "S3-TEST01", (j or {}).get("seq"))
s, j = call("/api/csi", {"node": "S3-TEST01", "v": [[1, -50, 30, 0.01]]})
check("csi 接口", s == 200 and j["n"] == 1, j)
call("/api/reset", {})

t0 = time.time()
fw0 = 100000
sent = 0
res_still = None
res_walk = None
print("流式注入合成 CSI（约 48 秒）…")
while time.time() - t0 < 48:
    el = time.time() - t0
    vs = []
    for _ in range(20):
        t = time.time() - t0
        walking = t > 34
        d = (0.012 + random.random() * 0.004) if not walking else (0.12 + random.random() * 0.08)
        m = 30 + 1.5 * math.sin(2 * math.pi * 0.27 * t) + random.gauss(0, 0.15 if not walking else 1.5)
        vs.append([fw0 + int(t * 1000), -50, round(m * 10), round(d * 1000)])
        time.sleep(0.05)
    f = dict(frame, seq=sent + 2, cs={"now": fw0 + int((time.time() - t0) * 1000), "v": vs})
    s, j = call("/api/ingest", f)
    sent += 1
    s2, sj = call("/api/sense")
    sense = sj["sense"] if sj else None
    if sense and 31 < el < 34:
        res_still = sense
    if sense and el > 44:
        res_walk = sense
print("静止段:", res_still)
print("走动段:", res_walk)
check("静止段 检出呼吸≈16 次/分", res_still and 14 <= res_still["breath"] <= 18.5, res_still and res_still["breath"])
check("静止段 无人走动", res_still and res_still["act"] in ("still", "empty"), res_still and res_still["act"])
check("走动段 present", res_walk and res_walk["present"], res_walk and res_walk["act"])
check("走动段 activity moving/walking", res_walk and res_walk["act"] in ("moving", "walking"), res_walk and res_walk["act"])
s, d = call("/api/diag")
check("diag 含 csi 样本", s == 200 and d["csi"]["samples"] > 500, d and d["csi"]["samples"])
s, t = call("/api/diag.txt")
check("diag.txt 文本", s == 200 and "检测日志" in t)
s, l = call("/api/llm", {"report": "ESP32 HTTP 401 API_KEY 不一致"})
check("llm 规则诊断", s == 200 and "API_KEY" in l["text"], l and l["engine"])
print("ALL PASS" if ok_all else "SOME FAIL")
sys.exit(0 if ok_all else 1)
