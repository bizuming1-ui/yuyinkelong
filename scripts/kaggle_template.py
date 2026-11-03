#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
WiFi 雷达 · Kaggle 单文件服务端 v2（ESP32-S3 -> Kaggle T4x2 GPU -> 全屏 3D 网站）
=============================================================================
用法（Kaggle Notebook：右侧 Settings -> Accelerator 选 GPU T4 x2，Internet 选 On）：
    1) 新建 Code Cell，把本文件【全部内容】粘贴进去，运行。
    2) 等待输出：
         🌐 全屏 3D 网站： https://xxxx.trycloudflare.com
         #define SERVER_URL "https://xxxx.trycloudflare.com"
    3) 用电脑 Chrome/Edge 打开该网址 -> 页面里点【🔌 USB 连接 ESP32】(最稳，ESP32 不需要联网)，
       或者把网址填进 PlatformIO 的 firmware/include/config.h 的 SERVER_URL，烧录后按 RESET。
    Cell 必须保持运行；停止 Cell = 关闭网站。

内置功能：
    - 3D 网站零依赖（自带 Canvas 3D 引擎，不再依赖任何 CDN / WebGL）。
    - /api/ingest 接收 ESP32 (WiFi 直传 或 网页 USB 转发)，/api/frames 网页轮询。
    - 多 GPU：>=2 个 ESP32 节点同时看到同一个 AP 时，用 PyTorch 在 *所有* GPU 上分片并行做三边定位（2048 起点并行优化）。
    - GPU 运动检测：把所有 AP 的 RSSI 时间序列堆成矩阵，在 GPU 上计算环境扰动指数。
    - 资源预算：显存（每卡 <=RADAR_VRAM_GB，默认 12GiB 内按需）、内存（RSSI 历史 <=RADAR_RAM_GB，默认 20GiB 上限）、
      磁盘（历史记录 JSONL 写到 /kaggle/temp，<=RADAR_DISK_GB，默认 45GiB，自动滚动删除最旧文件）。
    - 隧道：cloudflared 自动重试 + 公网自检；可选 ngrok（环境变量 NGROK_TOKEN）。
    - /api/geo：beaconDB WiFi 定位 + OpenStreetMap 真实街区（建筑/道路）。
"""
import os, sys, re, json, math, time, threading, subprocess, shutil, urllib.request, collections, random, glob

API_KEY = os.environ.get("RADAR_KEY", "radar-key")        # 必须与 ESP32 config.h 里的 API_KEY 一致
PORT = int(os.environ.get("RADAR_PORT", "8000"))
USE_TUNNEL = os.environ.get("RADAR_NO_TUNNEL", "") != "1"
NGROK_TOKEN = os.environ.get("NGROK_TOKEN", "")
VRAM_GB = float(os.environ.get("RADAR_VRAM_GB", "12"))     # 每张 GPU 允许求解器使用的显存上限（T4 共 15GiB）
RAM_GB = float(os.environ.get("RADAR_RAM_GB", "20"))       # 历史时间序列允许占用的内存上限（Kaggle 共 30GiB）
DISK_GB = float(os.environ.get("RADAR_DISK_GB", "45"))     # 历史记录磁盘上限（Kaggle 共 57.6GiB）
RESTARTS = int(os.environ.get("RADAR_RESTARTS", "2048"))   # 每个 AP 的并行起点数
UA = {"User-Agent": "wifi-radar-esp32s3/2.0 (personal project)"}
PATH_N, PATH_TX = 2.8, -40.0
HIST_DIR = "/kaggle/temp/wifi_radar_history" if os.path.isdir("/kaggle/temp") else "/tmp/wifi_radar_history"


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
SERIES = {}            # bssid -> deque[(t, rssi)]
MOTION = {"v": 0.0, "base": None}
T0 = time.time()
PUBLIC_URL = ""
GPU_NAMES = []
RES_TEXT = ""
_last_solve = 0.0
HIST_Q = collections.deque(maxlen=20000)

try:
    import torch
    GPU_NAMES = [torch.cuda.get_device_name(i) for i in range(torch.cuda.device_count())]
except Exception:
    torch = None
NGPU = len(GPU_NAMES)
SERIES_MAXLEN = max(256, int(RAM_GB * 1024 ** 3 / 400 / 2000))   # 单 AP 历史点数上限（按 RAM 预算折算，最多 ~26000）
SERIES_MAXLEN = min(SERIES_MAXLEN, 26000)


@app.after_request
def _cors(r):
    r.headers["Access-Control-Allow-Origin"] = "*"
    r.headers["Access-Control-Allow-Headers"] = "*"
    r.headers["Cache-Control"] = "no-store"
    return r


@app.get("/")
@app.get("/radar.html")
def index():
    return Response(HTML, mimetype="text/html")


@app.get("/api/health")
def health():
    return jsonify(ok=True, frames=SEQ, uptime=int(time.time() - T0), gpu=GPU_NAMES, res=RES_TEXT)


@app.route("/api/ingest", methods=["POST", "OPTIONS"])
def ingest():
    global SEQ
    if request.method == "OPTIONS":
        return ("", 204)
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
                dq = SERIES.get(b)
                if dq is None:
                    dq = SERIES[b] = collections.deque(maxlen=SERIES_MAXLEN)
                dq.append((t, r))
            except Exception:
                continue
        seq = SEQ
    HIST_Q.append(json.dumps({"t": round(t, 2), "f": f}, ensure_ascii=False, separators=(",", ":")))
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
            "motion": round(MOTION["v"], 3), "res": RES_TEXT,
            "nodes": {k: {"frames": v["frames"], "aps": v.get("aps", 0), "ip": v.get("ip"), "age": round(time.time() - v.get("last", 0), 1)} for k, v in NODES.items()},
        }
        return jsonify(seq=SEQ, frames=out, solved=SOLVED, status=status)


@app.get("/api/stats")
def stats():
    return jsonify(res=RES_TEXT, gpu=GPU_NAMES, series=len(SERIES), series_maxlen=SERIES_MAXLEN, hist_dir=HIST_DIR,
                   budgets={"vram_gb": VRAM_GB, "ram_gb": RAM_GB, "disk_gb": DISK_GB, "restarts": RESTARTS}, motion=MOTION["v"])


# ---------------------------------------------------------------- 多 GPU 三边定位
def _dist(rssi, ch):
    return min(150.0, max(0.5, 10 ** (((PATH_TX - (7 if ch > 14 else 0)) - rssi) / (10 * PATH_N))))


def _solve_chunk(items, dev, R):
    """在单个设备上批量求解一组 AP 的位置。items: [(bssid, [(x, y, d, w), ...])]"""
    N, K = len(items), max(len(v) for _, v in items)
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

    for _ in range(150):
        opt.zero_grad()
        loss_fn().sum().backward()
        opt.step()
    with torch.no_grad():
        L = loss_fn()
        best = L.argmin(1)
        idx = torch.arange(N, device=dev)
        pos = X[idx, best].cpu().tolist()
        res = (L[idx, best] / W.sum(1).clamp(min=1e-6)).sqrt().cpu().tolist()
    return pos, res


def multilaterate(items):
    out = {}
    if torch is None:
        for b, v in items:
            ws = sum(w for _, _, _, w in v)
            out[b] = {"x": sum(x * w for x, _, _, w in v) / ws, "y": sum(y * w for _, y, _, w in v) / ws, "n": len(v), "res": -1}
        return out
    devs = [torch.device("cuda:%d" % i) for i in range(NGPU)] or [torch.device("cpu")]
    K = max(len(v) for _, v in items)
    # 每个起点约占 (K*2 + 2) 个 float，Adam+autograd 约 x8；按显存预算决定一批最多处理多少个 AP
    per_ap = RESTARTS * (K * 4 + 8) * 4 * 8
    chunk = max(1, int(VRAM_GB * 1024 ** 3 / per_ap))
    shards = [items[i::len(devs)] for i in range(len(devs))]
    results = [None] * len(devs)

    def work(i):
        its = shards[i]
        pos, res = [], []
        for s in range(0, len(its), chunk):
            p, r = _solve_chunk(its[s:s + chunk], devs[i], RESTARTS)
            pos += p
            res += r
        results[i] = (its, pos, res)

    th = [threading.Thread(target=work, args=(i,)) for i in range(len(devs)) if shards[i]]
    for t in th:
        t.start()
    for t in th:
        t.join()
    for r in results:
        if not r:
            continue
        its, pos, res = r
        for (b, v), p, rr in zip(its, pos, res):
            px, py = p
            uniq = {(round(x, 3), round(y, 3)) for x, y, _, _ in v}
            if len(uniq) == 2:   # 两个节点存在镜像歧义：固定解在 A->B 连线左侧，避免来回跳动
                (ax, ay), (bx, by) = sorted(uniq)
                dx, dy = bx - ax, by - ay
                if dx * (py - ay) - dy * (px - ax) < 0:
                    ln = math.hypot(dx, dy) or 1.0
                    ux, uy = dx / ln, dy / ln
                    tt = (px - ax) * ux + (py - ay) * uy
                    px, py = 2 * (ax + ux * tt) - px, 2 * (ay + uy * tt) - py
            out[b] = {"x": round(px, 2), "y": round(py, 2), "n": len(v), "res": round(rr, 2)}
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


def selftest():
    """启动自检：随机 3 个节点 + 40 个 AP，在所有 GPU 上求解，打印中位数误差。"""
    try:
        rnd = random.Random(1)
        nodes = [(0, 0), (30, 0), (0, 30)]
        items, truth = [], {}
        for i in range(40):
            tx, ty = rnd.uniform(-40, 60), rnd.uniform(-40, 60)
            truth["AP%d" % i] = (tx, ty)
            items.append(("AP%d" % i, [(nx, ny, math.hypot(tx - nx, ty - ny) * rnd.uniform(0.95, 1.05), 1.0) for nx, ny in nodes]))
        t = time.time()
        res = multilaterate(items)
        errs = sorted(math.hypot(res[b]["x"] - truth[b][0], res[b]["y"] - truth[b][1]) for b in truth)
        print("[selftest] 三边定位 %d 个 AP, 设备=%s, 用时 %.2fs, 中位误差 %.2f m" % (len(items), (GPU_NAMES or ["CPU"]), time.time() - t, errs[len(errs) // 2]), flush=True)
    except Exception as e:
        print("[selftest] 失败:", e, flush=True)


# ---------------------------------------------------------------- GPU 运动检测 + 资源监控 + 磁盘历史
def motion_loop():
    T = 24
    while True:
        time.sleep(1.0)
        try:
            now = time.time()
            with LOCK:
                rows = [[r for (t, r) in list(dq)[-T:]] for dq in SERIES.values() if len(dq) >= T and now - dq[-1][0] < 15 and dq[-1][1] > -85]
            if len(rows) < 2:
                MOTION["v"] *= 0.9
                continue
            if torch is not None:
                dev = torch.device("cuda:0" if NGPU else "cpu")
                M = torch.tensor(rows, dtype=torch.float32, device=dev)
                short = M.std(dim=1).mean().item()
                diff = M.diff(dim=1).abs().mean().item()
                cur = 0.6 * short + 0.4 * diff
            else:
                import statistics
                cur = sum(statistics.pstdev(r) for r in rows) / len(rows)
            b = MOTION["base"]
            MOTION["base"] = cur if b is None else b + (0.004 if cur > b else 0.06) * (cur - b)
            MOTION["v"] = max(0.0, min(1.0, (cur - MOTION["base"]) / 1.6))
        except Exception:
            pass


def _meminfo():
    d = {}
    try:
        for l in open("/proc/meminfo"):
            k, v = l.split(":")
            d[k] = int(v.split()[0]) * 1024
    except Exception:
        pass
    return d


def res_loop():
    global RES_TEXT
    while True:
        try:
            parts = []
            if torch is not None and NGPU:
                v = []
                for i in range(NGPU):
                    free, total = torch.cuda.mem_get_info(i)
                    v.append("%.1f/%.0fG" % ((total - free) / 1024 ** 3, total / 1024 ** 3))
                parts.append("显存 " + " | ".join(v))
            m = _meminfo()
            if m:
                parts.append("内存 %.1f/%.0fG" % ((m["MemTotal"] - m.get("MemAvailable", 0)) / 1024 ** 3, m["MemTotal"] / 1024 ** 3))
            du = shutil.disk_usage(os.path.dirname(HIST_DIR))
            used = sum(os.path.getsize(f) for f in glob.glob(HIST_DIR + "/*.jsonl")) if os.path.isdir(HIST_DIR) else 0
            parts.append("磁盘 历史 %.2fG (余 %.0fG)" % (used / 1024 ** 3, du.free / 1024 ** 3))
            RES_TEXT = " · ".join(parts)
        except Exception:
            pass
        time.sleep(5)


def hist_writer():
    os.makedirs(HIST_DIR, exist_ok=True)
    cur, cur_size = None, 0
    while True:
        if not HIST_Q:
            time.sleep(0.5)
            continue
        try:
            if cur is None or cur_size > 256 * 1024 ** 2:
                if cur:
                    cur.close()
                cur = open(os.path.join(HIST_DIR, "frames_%d.jsonl" % int(time.time())), "a", encoding="utf8")
                cur_size = 0
                files = sorted(glob.glob(HIST_DIR + "/*.jsonl"))
                total = sum(os.path.getsize(f) for f in files)
                while total > DISK_GB * 1024 ** 3 and len(files) > 1:   # 超过磁盘预算：删除最旧的
                    total -= os.path.getsize(files[0])
                    os.remove(files.pop(0))
            n = 0
            while HIST_Q and n < 500:
                line = HIST_Q.popleft() + "\n"
                cur.write(line)
                cur_size += len(line)
                n += 1
            cur.flush()
        except Exception as e:
            print("[hist] error:", e)
            time.sleep(2)


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
    line = "=" * 66
    print("\n" + line)
    print("🌐 全屏 3D 网站： " + url)
    print('📟 ESP32 config.h： #define SERVER_URL "%s"' % url)
    print("   或串口输入：     url %s" % url)
    print("🔌 最稳方案：     用电脑 Chrome/Edge 打开上面网址 -> 点【USB 连接 ESP32】")
    print("🔑 API_KEY：       %s" % API_KEY)
    print(line + "\n", flush=True)
    try:
        from IPython.display import display, HTML as _H
        display(_H('<a href="%s" target="_blank" style="font-size:18px">▶ 点此打开全屏 3D 世界</a>' % url))
    except Exception:
        pass
    threading.Thread(target=_probe, args=(url,), daemon=True).start()


def _probe(url):
    for i in range(15):
        try:
            r = requests.get(url + "/api/health", timeout=8, headers=UA)
            if r.status_code == 200:
                print("[tunnel] ✅ 公网自检通过：%s/api/health" % url, flush=True)
                return
        except Exception:
            pass
        time.sleep(4)
    print("[tunnel] ⚠ 公网自检未通过（隧道可能还在生效，或被网络拦截）。可稍后刷新，或设置 NGROK_TOKEN 改用 ngrok。", flush=True)


def start_cloudflared():
    exe = shutil.which("cloudflared") or "/tmp/cloudflared"
    if not os.path.exists(exe):
        print("[tunnel] 下载 cloudflared …")
        urllib.request.urlretrieve("https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64", exe)
        os.chmod(exe, 0o755)

    def runner():
        for attempt in range(1, 6):
            p = subprocess.Popen([exe, "tunnel", "--url", "http://127.0.0.1:%d" % PORT, "--no-autoupdate", "--protocol", "http2"],
                                 stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            shown = False
            for line in p.stdout:
                m = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", line)
                if m and not shown:
                    shown = True
                    _banner(m.group(0))
            print("[tunnel] cloudflared 退出，第 %d 次重试…" % attempt, flush=True)
            time.sleep(3)

    threading.Thread(target=runner, daemon=True).start()


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
    print("[budget] 显存<=%.0fG/卡  内存<=%.0fG  磁盘<=%.0fG(%s)  起点数=%d" % (VRAM_GB, RAM_GB, DISK_GB, HIST_DIR, RESTARTS), flush=True)
    for fn in (motion_loop, res_loop, hist_writer):
        threading.Thread(target=fn, daemon=True).start()
    threading.Thread(target=selftest, daemon=True).start()
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
            print("[status] frames=%d nodes=%s uptime=%ds | %s" % (SEQ, list(NODES.keys()), time.time() - T0, RES_TEXT), flush=True)
    except KeyboardInterrupt:
        print("stopped")


if __name__ == "__main__" or "ipykernel" in sys.modules:
    main()
