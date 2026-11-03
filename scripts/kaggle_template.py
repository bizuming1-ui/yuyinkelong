#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
WiFi 雷达 · Kaggle 单文件服务端（ESP32-S3 -> Kaggle GPU -> 全屏 3D 网站）
=========================================================================
用法（Kaggle Notebook，右侧 Settings 里打开 Internet，Accelerator 选 GPU T4 x2）：
    1) 新建一个 Code Cell，把本文件全部内容粘贴进去，点运行（或保存为 .py 后 %run wifi_radar_kaggle.py）
    2) 等待输出：
         🌐 全屏 3D 网站： https://xxxx.trycloudflare.com
         #define SERVER_URL "https://xxxx.trycloudflare.com"
    3) 把网址填进 PlatformIO 工程的 firmware/include/config.h 的 SERVER_URL（或串口输入 url https://xxxx...），
       烧录后按 ESP32 的 RESET 键，网站里就会出现你周围的 WiFi 世界。
    Cell 必须一直保持运行；停止 Cell = 关闭网站。

它做了什么：
    - Flask 提供 /（全屏 three.js 3D 页面）、/api/ingest（ESP32 上传）、/api/frames（网页轮询）、/api/geo（真实街区）
    - cloudflared 免费隧道把 Kaggle 内部 8000 端口发布成公网 https 网址
    - 当 >=2 个 ESP32 节点同时看到同一个 AP 时，用 PyTorch(GPU) 并行多起点优化做三边定位
    - /api/geo：用 beaconDB 做 WiFi 定位，再从 OpenStreetMap(Overpass) 取真实建筑和道路，显示成 3D 街区
"""
import os, sys, re, json, math, time, threading, subprocess, shutil, urllib.request, collections

API_KEY = "radar-key"          # 必须与 ESP32 config.h 里的 API_KEY 一致
PORT = int(os.environ.get("RADAR_PORT", "8000"))
API_KEY = os.environ.get("RADAR_KEY", API_KEY)
USE_TUNNEL = os.environ.get("RADAR_NO_TUNNEL", "") != "1"
NGROK_TOKEN = os.environ.get("NGROK_TOKEN", "")   # 可选：填了就用 ngrok 代替 cloudflared
UA = {"User-Agent": "wifi-radar-esp32s3/1.0 (personal project)"}
PATH_N, PATH_TX = 2.8, -40.0   # 服务端三边定位使用的路径损耗模型


def _ensure(mod, pip=None):
    try:
        __import__(mod)
    except ImportError:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "-q", pip or mod])


_ensure("flask")
_ensure("requests")
import requests
from flask import Flask, request, jsonify, Response

HTML = r'''__RADAR_HTML__'''

app = Flask(__name__)
LOCK = threading.Lock()
FRAMES = collections.deque(maxlen=400)
SEQ = 0
NODES = {}
SOLVED = {}
T0 = time.time()
PUBLIC_URL = ""
GPU_NAMES = []
_last_solve = 0.0

try:
    import torch
    GPU_NAMES = [torch.cuda.get_device_name(i) for i in range(torch.cuda.device_count())]
except Exception:
    torch = None


@app.after_request
def _cors(r):
    r.headers["Access-Control-Allow-Origin"] = "*"
    r.headers["Access-Control-Allow-Headers"] = "*"
    r.headers["Cache-Control"] = "no-store"
    return r


@app.get("/")
def index():
    return Response(HTML, mimetype="text/html")


@app.get("/api/health")
def health():
    return jsonify(ok=True, frames=SEQ, uptime=int(time.time() - T0), gpu=GPU_NAMES)


@app.post("/api/ingest")
def ingest():
    global SEQ
    key = request.headers.get("X-Key") or request.args.get("key")
    if key != API_KEY:
        return jsonify(ok=False, error="bad key"), 401
    f = request.get_json(force=True, silent=True)
    if not isinstance(f, dict) or not isinstance(f.get("aps"), list):
        return jsonify(ok=False, error="bad frame"), 400
    t = time.time()
    with LOCK:
        SEQ += 1
        f["_seq"] = SEQ
        FRAMES.append(f)
        nid = str(f.get("node", "node"))
        n = NODES.setdefault(nid, {"frames": 0, "obs": {}})
        n["x"] = float(f.get("x") or 0)
        n["y"] = float(f.get("y") or 0)
        n["last"] = t
        n["frames"] += 1
        n["aps"] = len(f["aps"])
        n["ip"] = request.headers.get("CF-Connecting-IP") or request.remote_addr
        for a in f["aps"]:
            try:
                b = str(a["b"]).upper()
                r = float(a["r"])
                old = n["obs"].get(b)
                n["obs"][b] = {"r": r if old is None else old["r"] * 0.7 + r * 0.3, "c": int(a.get("c", 6)), "t": t}
            except Exception:
                continue
        seq = SEQ
    threading.Thread(target=solve_positions, daemon=True).start()
    return jsonify(ok=True, seq=seq)


@app.get("/api/frames")
def frames():
    try:
        since = int(request.args.get("since", "0"))
    except ValueError:
        since = 0
    with LOCK:
        if since <= 0 or since > SEQ:
            last = {}
            for f in FRAMES:
                last[f.get("node")] = f
            out = list(last.values())
        else:
            out = [f for f in FRAMES if f["_seq"] > since][-60:]
        status = {
            "gpu": GPU_NAMES, "frames": SEQ, "uptime": int(time.time() - T0), "public": PUBLIC_URL,
            "nodes": {k: {"frames": v["frames"], "aps": v.get("aps", 0), "ip": v.get("ip"), "age": round(time.time() - v.get("last", 0), 1)} for k, v in NODES.items()},
        }
        return jsonify(seq=SEQ, frames=out, solved=SOLVED, status=status)


# ---------------------------------------------------------------- GPU 多节点三边定位
def _dist(rssi, ch):
    return min(150.0, max(0.5, 10 ** (((PATH_TX - (7 if ch > 14 else 0)) - rssi) / (10 * PATH_N))))


def multilaterate(items):
    """items: [(bssid, [(x, y, d, w), ...])] -> {bssid: {x, y, n, res}}；torch 可用时在 GPU 上批量求解。"""
    out = {}
    if torch is None:
        for b, v in items:
            ws = sum(w for _, _, _, w in v)
            out[b] = {"x": sum(x * w for x, _, _, w in v) / ws, "y": sum(y * w for _, y, _, w in v) / ws, "n": len(v), "res": -1}
        return out
    dev = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    N, K, R = len(items), max(len(v) for _, v in items), 256
    P = torch.zeros(N, K, 2)
    D = torch.zeros(N, K)
    W = torch.zeros(N, K)
    for i, (_, v) in enumerate(items):
        for j, (x, y, d, w) in enumerate(v):
            P[i, j, 0], P[i, j, 1], D[i, j], W[i, j] = x, y, d, w
    P, D, W = P.to(dev), D.to(dev), W.to(dev)
    cen = (P * W[..., None]).sum(1) / W.sum(1, keepdim=True).clamp(min=1e-6)
    scale = D.max(1).values.clamp(min=2.0)
    X = (cen[:, None, :] + torch.randn(N, R, 2, device=dev) * scale[:, None, None]).requires_grad_(True)
    opt = torch.optim.Adam([X], lr=0.6)

    def loss_fn():
        dist = torch.sqrt(((X[:, :, None, :] - P[:, None, :, :]) ** 2).sum(-1) + 1e-6)
        return (W[:, None, :] * (dist - D[:, None, :]) ** 2).sum(-1)

    for _ in range(120):
        opt.zero_grad()
        loss_fn().sum().backward()
        opt.step()
    with torch.no_grad():
        L = loss_fn()
        best = L.argmin(1)
        idx = torch.arange(N, device=dev)
        pos = X[idx, best].cpu().tolist()
        res = (L[idx, best] / W.sum(1).clamp(min=1e-6)).sqrt().cpu().tolist()
    for (b, v), p, r in zip(items, pos, res):
        px, py = p
        uniq = {(round(x, 3), round(y, 3)) for x, y, _, _ in v}
        if len(uniq) == 2:   # 两个节点存在镜像歧义：固定解在 A->B 连线左侧，避免来回跳动
            (ax, ay), (bx, by) = sorted(uniq)
            dx, dy = bx - ax, by - ay
            if dx * (py - ay) - dy * (px - ax) < 0:
                ln = math.hypot(dx, dy) or 1.0
                ux, uy = dx / ln, dy / ln
                t = (px - ax) * ux + (py - ay) * uy
                px, py = 2 * (ax + ux * t) - px, 2 * (ay + uy * t) - py
        out[b] = {"x": round(px, 2), "y": round(py, 2), "n": len(v), "res": round(r, 2)}
    return out


def solve_positions():
    global SOLVED, _last_solve
    t = time.time()
    if t - _last_solve < 1.0:
        return
    with LOCK:
        fresh = {k: v for k, v in NODES.items() if t - v.get("last", 0) < 20}
        if len(fresh) < 2:
            SOLVED = {}
            return
        _last_solve = t
        per = {}
        for nid, n in fresh.items():
            for b, o in n["obs"].items():
                if t - o["t"] < 20:
                    d = _dist(o["r"], o["c"])
                    per.setdefault(b, []).append((n["x"], n["y"], d, 1.0 / (1.0 + d / 5.0)))
    items = [(b, v) for b, v in per.items() if len(v) >= 2]
    if not items:
        return
    try:
        res = multilaterate(items)
        with LOCK:
            SOLVED = res
    except Exception as e:
        print("[solve] error:", e)


# ---------------------------------------------------------------- 真实世界：beaconDB 定位 + OSM 建筑
GEO_CACHE = {}
OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]


def wifi_geolocate():
    with LOCK:
        best = {}
        for n in NODES.values():
            for b, o in n["obs"].items():
                if int(b[:2], 16) & 2:        # 本地管理(随机化)MAC 不在数据库里
                    continue
                if b not in best or o["r"] > best[b]["r"]:
                    best[b] = o
    aps = sorted(best.items(), key=lambda kv: -kv[1]["r"])[:20]
    if len(aps) < 2:
        raise RuntimeError("可用于定位的 AP 少于 2 个，请等 ESP32 上传数据后再试")
    body = {"considerIp": False, "fallbacks": {"lacf": False, "ipf": False},
            "wifiAccessPoints": [{"macAddress": b, "signalStrength": int(o["r"]), "channel": o["c"]} for b, o in aps]}
    r = requests.post("https://api.beacondb.net/v1/geolocate", json=body, headers=UA, timeout=15)
    if r.status_code != 200:
        raise RuntimeError("beaconDB 没有这些热点的位置记录(HTTP %d)，请手动输入经纬度" % r.status_code)
    j = r.json()
    return float(j["location"]["lat"]), float(j["location"]["lng"]), float(j.get("accuracy") or 100)


def osm_scene(lat, lon, radius=260):
    q = '[out:json][timeout:25];(way["building"](around:%d,%f,%f);way["highway"](around:%d,%f,%f););out geom 3000;' % (radius, lat, lon, radius, lat, lon)
    last = None
    for url in OVERPASS:
        try:
            r = requests.post(url, data={"data": q}, headers=UA, timeout=45)
            if r.status_code == 200:
                els = r.json().get("elements", [])
                break
            last = "HTTP %d" % r.status_code
        except Exception as e:
            last = str(e)
    else:
        raise RuntimeError("Overpass 不可用: %s" % last)
    kx, ky = 111320.0 * math.cos(math.radians(lat)), 110540.0
    buildings, roads = [], []
    for e in els:
        g = e.get("geometry")
        if not g or len(g) < 2:
            continue
        pts = [[round((p["lon"] - lon) * kx, 1), round((p["lat"] - lat) * ky, 1)] for p in g]
        tags = e.get("tags", {})
        if "building" in tags:
            h = None
            try:
                h = float(str(tags.get("height", "")).split()[0])
            except Exception:
                try:
                    h = float(tags.get("building:levels")) * 3.2
                except Exception:
                    h = 6 + (e.get("id", 0) % 9) * 1.5
            buildings.append({"h": round(h, 1), "pts": pts})
        elif tags.get("highway") not in ("steps", "footway", "path", "corridor"):
            roads.append(pts)
    return buildings[:1800], roads[:1500]


@app.get("/api/geo")
def geo():
    try:
        if request.args.get("lat") and request.args.get("lon"):
            lat, lon, acc, how = float(request.args["lat"]), float(request.args["lon"]), 0, "手动坐标"
        else:
            lat, lon, acc = wifi_geolocate()
            how = "WiFi 定位(beaconDB)"
        key = (round(lat, 3), round(lon, 3))
        if key not in GEO_CACHE:
            GEO_CACHE[key] = osm_scene(lat, lon)
        b, r = GEO_CACHE[key]
        return jsonify(ok=True, lat=lat, lon=lon, accuracy=acc, buildings=b, roads=r, label="OpenStreetMap 真实街区 · " + how)
    except Exception as e:
        return jsonify(ok=False, error=str(e))


# ---------------------------------------------------------------- 隧道
def _banner(url):
    global PUBLIC_URL
    PUBLIC_URL = url
    line = "=" * 64
    print("\n" + line)
    print("🌐 全屏 3D 网站： " + url)
    print('📟 ESP32 config.h： #define SERVER_URL "%s"' % url)
    print("   或串口输入：     url %s" % url)
    print("🔑 API_KEY：       %s" % API_KEY)
    print(line + "\n", flush=True)
    try:
        from IPython.display import display, HTML as _H
        display(_H('<a href="%s" target="_blank" style="font-size:18px">▶ 点此打开全屏 3D 世界</a>' % url))
    except Exception:
        pass


def start_cloudflared():
    exe = shutil.which("cloudflared") or "/tmp/cloudflared"
    if not os.path.exists(exe):
        print("[tunnel] 下载 cloudflared …")
        urllib.request.urlretrieve("https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64", exe)
        os.chmod(exe, 0o755)
    p = subprocess.Popen([exe, "tunnel", "--url", "http://127.0.0.1:%d" % PORT, "--no-autoupdate"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)

    def reader():
        shown = False
        for line in p.stdout:
            m = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", line)
            if m and not shown:
                shown = True
                _banner(m.group(0))
    threading.Thread(target=reader, daemon=True).start()
    return p


def start_ngrok():
    _ensure("pyngrok")
    from pyngrok import ngrok
    ngrok.set_auth_token(NGROK_TOKEN)
    _banner(ngrok.connect(PORT, "http").public_url.replace("http://", "https://"))


def main():
    from werkzeug.serving import make_server
    srv = make_server("0.0.0.0", PORT, app, threaded=True)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print("[server] 监听 0.0.0.0:%d  GPU: %s" % (PORT, ", ".join(GPU_NAMES) or "无(CPU)"))
    if USE_TUNNEL:
        if NGROK_TOKEN:
            start_ngrok()
        else:
            start_cloudflared()
    else:
        print("[server] 本地模式: http://127.0.0.1:%d" % PORT)
    try:
        while True:
            time.sleep(30)
            print("[status] frames=%d nodes=%s uptime=%ds" % (SEQ, list(NODES.keys()), time.time() - T0), flush=True)
    except KeyboardInterrupt:
        print("stopped")


if __name__ == "__main__" or "ipykernel" in sys.modules:
    main()
