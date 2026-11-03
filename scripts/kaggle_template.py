#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
WiFi 雷达 · Kaggle 单文件服务端 v6（ESP32-S3 -> Kaggle T4x2 GPU -> 全屏 3D 网站）
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
    - v5 CSI 感知：接收 ESP32 的 CSI（RADARCSI / 上传帧 cs / api/csi），在 GPU 上做 FFT：存在/运动指数/呼吸/活动类型（/api/sense）。
    - GPU 运动检测：把所有 AP 的 RSSI 时间序列堆成矩阵，在 GPU 上计算环境扰动指数。
    - 资源预算：显存（每卡 <=RADAR_VRAM_GB，默认 12GiB 内按需）、内存（RSSI 历史 <=RADAR_RAM_GB，默认 20GiB 上限）、
      磁盘（历史记录 JSONL 写到 /kaggle/temp，<=RADAR_DISK_GB，默认 45GiB，自动滚动删除最旧文件）。
    - 隧道：cloudflared 自动重试 + 公网自检；可选 ngrok（环境变量 NGROK_TOKEN）。
    - /api/geo：beaconDB WiFi 定位 + OpenStreetMap 真实街区（建筑/道路）。
    - v6 GPU 大模型诊断助手：Qwen2.5（双卡 7B / 单卡 3B）读取检测日志，网页「检测日志 → 🤖 AI 分析」（/api/llm，后台加载，失败自动退回规则诊断）。
    - 全能检测：/api/diag(JSON) 与 /api/diag.txt(纯文本，可直接复制到 GitHub “检测日志”)；
      网页端日志经 /api/clientlog 汇总到这里，同时写入 /kaggle/working/radar_diag.log（可在 Kaggle Output 下载）。
"""
import os, sys, re, json, math, time, threading, subprocess, shutil, urllib.request, collections, random, glob
from urllib.parse import urlparse

TOPIC = os.environ.get("RADAR_TOPIC", "wradar-bzm-5f2k9q7d")   # 汇合点暗号：必须与固件 config.h 的 RADAR_TOPIC 一致（默认已一致）
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


VERSION = "6.0"
EVENTS = collections.deque(maxlen=4000)
EVT_FILE = "/kaggle/working/radar_diag.log" if os.path.isdir("/kaggle/working") else "/tmp/radar_diag.log"
_ECHO = {}
_EVT_N = [0]
TUNNEL = {"state": "未启动", "url": "", "attempts": 0, "probe": "", "topic": TOPIC, "published": 0, "publish_err": "", "provider": ""}


def evt(level, cat, msg, echo=False, t=None):
    """记录一条检测事件：内存环形缓冲 + 磁盘日志文件；echo=True 时同时打印到 Notebook 输出。"""
    e = {"t": round(t or time.time(), 3), "lv": level, "c": cat, "m": str(msg)[:700]}
    EVENTS.append(e)
    line = "%s %s [%s] %s" % (time.strftime("%H:%M:%S", time.localtime(e["t"])), level, cat, e["m"])
    try:
        _EVT_N[0] += 1
        if _EVT_N[0] % 500 == 0 and os.path.exists(EVT_FILE) and os.path.getsize(EVT_FILE) > 64 * 1024 ** 2:
            open(EVT_FILE, "w").close()
        with open(EVT_FILE, "a", encoding="utf8") as fh:
            fh.write(line + "\n")
    except Exception:
        pass
    if echo:
        print(line, flush=True)


def evt_rate(key, secs, level, cat, msg, echo=True):
    now = time.time()
    if now - _ECHO.get(key, 0) < secs:
        return
    _ECHO[key] = now
    evt(level, cat, msg, echo=echo)


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
    return jsonify(ok=True, version=VERSION, frames=SEQ, uptime=int(time.time() - T0), gpu=GPU_NAMES, res=RES_TEXT, topic=TOPIC, published=TUNNEL.get("published", 0))


@app.route("/api/ingest", methods=["POST", "OPTIONS"])
def ingest():
    global SEQ
    if request.method == "OPTIONS":
        return ("", 204)
    key = request.headers.get("X-Key") or request.args.get("key")
    origin_host = urlparse(request.headers.get("Origin", "") or "").netloc
    same = request.headers.get("Sec-Fetch-Site") == "same-origin" or (origin_host != "" and origin_host == request.host)
    src = "网页USB转发" if same else "ESP32 WiFi直传"
    if key != API_KEY and not same:
        evt_rate("badkey", 5, "ERR", "ingest", "拒绝 %s 的上传：API_KEY 不一致（收到 %r，期望 %r）。请把 config.h 的 API_KEY 改成与本脚本一致" % (request.headers.get("CF-Connecting-IP") or request.remote_addr, key, API_KEY))
        return jsonify(ok=False, error="bad key"), 401
    f = request.get_json(force=True, silent=True)
    if not isinstance(f, dict) or not isinstance(f.get("aps"), list):
        evt_rate("badframe", 5, "ERR", "ingest", "收到格式错误的数据（%s，%d 字节）：缺少 aps 数组" % (src, len(request.get_data() or b"")))
        return jsonify(ok=False, error="bad frame"), 400
    t = time.time()
    with LOCK:
        SEQ += 1
        f["_seq"] = SEQ
        f["_t"] = t
        FRAMES.append(f)
        nid = str(f.get("node", "node"))
        n = NODES.setdefault(nid, {"frames": 0, "obs": {}})
        n["x"] = float(f.get("x") or 0)
        n["y"] = float(f.get("y") or 0)
        n["last"] = t
        n["frames"] += 1
        n["aps"] = len(f["aps"])
        n["ip"] = request.headers.get("CF-Connecting-IP") or request.remote_addr
        n["src"] = src
        n["fw"] = str(f.get("fw", ""))
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
        nframes = n["frames"]
        ncsi = csi_from_frame(f, t, nid)
    if nframes == 1 or nframes % 20 == 0:
        evt("OK", "ingest", "收到 %s 帧 #%d：node=%s 来自 %s · AP=%d · 设备=%d · 累计 %d 帧" % (src, seq, nid, n.get("ip"), len(f["aps"]), len(f.get("st") or []), nframes), echo=(nframes == 1 or nframes % 60 == 0))
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
        now_ = time.time()
        out = [dict(x, age=round(now_ - x.get("_t", now_), 1)) for x in out]
        status = {
            "gpu": GPU_NAMES, "frames": SEQ, "uptime": int(time.time() - T0), "public": PUBLIC_URL,
            "motion": round(MOTION["v"], 3), "res": RES_TEXT, "sense": SENSE["v"],
            "nodes": {k: {"frames": v["frames"], "aps": v.get("aps", 0), "ip": v.get("ip"), "age": round(time.time() - v.get("last", 0), 1)} for k, v in NODES.items()},
        }
        return jsonify(seq=SEQ, frames=out, solved=SOLVED, status=status)


def server_diag(n_events=80):
    now = time.time()
    d = {
        "version": VERSION, "time": time.strftime("%Y-%m-%d %H:%M:%S"), "python": sys.version.split()[0], "uptime": int(now - T0),
        "public_url": PUBLIC_URL, "tunnel": TUNNEL, "frames": SEQ, "gpu": GPU_NAMES, "res": RES_TEXT,
        "torch": getattr(torch, "__version__", None) if torch is not None else None,
        "cuda": bool(torch is not None and torch.cuda.is_available()),
        "budgets": {"vram_gb": VRAM_GB, "ram_gb": RAM_GB, "disk_gb": DISK_GB, "restarts": RESTARTS},
        "series": len(SERIES), "series_maxlen": SERIES_MAXLEN, "events_file": EVT_FILE, "hist_dir": HIST_DIR,
        "nodes": {k: {"frames": v["frames"], "aps": v.get("aps", 0), "ip": v.get("ip"), "src": v.get("src"), "fw": v.get("fw"), "age": round(now - v.get("last", 0), 1)} for k, v in list(NODES.items())},
        "solved": len(SOLVED), "motion": round(MOTION["v"], 3),
        "csi": dict(CSI_STAT, nodes={k: len(v) for k, v in CSI.items()}, sense=SENSE["v"]),
        "llm": LLM,
    }
    try:
        if torch is not None and NGPU:
            d["gpu_mem"] = []
            for i in range(NGPU):
                free, total = torch.cuda.mem_get_info(i)
                d["gpu_mem"].append({"gpu": i, "name": GPU_NAMES[i], "used_gb": round((total - free) / 1024 ** 3, 2), "total_gb": round(total / 1024 ** 3, 2)})
    except Exception as e:
        d["gpu_mem_err"] = str(e)
    d["recent"] = list(EVENTS)[-n_events:]
    return d


@app.get("/api/diag")
def diag():
    return jsonify(server_diag())


@app.get("/api/diag.txt")
def diag_txt():
    d = server_diag(400)
    L = ["===== WiFi RADAR 服务端检测日志 v%s =====" % d["version"], "时间: %s  运行 %ds  Python %s  torch=%s cuda=%s" % (d["time"], d["uptime"], d["python"], d["torch"], d["cuda"]),
         "公网地址: %s  隧道: %s" % (d["public_url"], json.dumps(d["tunnel"], ensure_ascii=False)), "GPU: %s  显存: %s" % (d["gpu"], json.dumps(d.get("gpu_mem"), ensure_ascii=False)), "资源: %s" % d["res"],
         "预算: %s" % json.dumps(d["budgets"]), "总帧数: %d  节点: %s" % (d["frames"], json.dumps(d["nodes"], ensure_ascii=False)), "", "--- 事件 ---"]
    for e in d["recent"]:
        L.append("%s %s [%s] %s" % (time.strftime("%H:%M:%S", time.localtime(e["t"])), e["lv"], e["c"], e["m"]))
    return Response("\n".join(L), mimetype="text/plain; charset=utf-8")


@app.route("/api/clientlog", methods=["POST", "OPTIONS"])
def clientlog():
    if request.method == "OPTIONS":
        return ("", 204)
    j = request.get_json(force=True, silent=True) or {}
    for e in (j.get("entries") or [])[:100]:
        try:
            lv = str(e.get("lv", "INFO"))[:5]
            m = str(e.get("m", ""))
            evt(lv, "web/" + str(e.get("c", ""))[:12], m, echo=False, t=float(e.get("t", 0)) / 1000.0 or None)
            if lv == "ERR":
                evt_rate("web:" + m[:50], 15, "ERR", "web", m[:300])
        except Exception:
            continue
    return jsonify(ok=True)


@app.route("/api/reset", methods=["POST", "OPTIONS"])
def reset_state():
    global SEQ, SOLVED
    if request.method == "OPTIONS":
        return ("", 204)
    with LOCK:
        FRAMES.clear()
        NODES.clear()
        SERIES.clear()
        SOLVED = {}
        SEQ = 0
    evt("INFO", "server", "已清空帧缓存/节点/历史序列（/api/reset）", echo=True)
    return jsonify(ok=True)


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


# ---------------------------------------------------------------- v5：CSI 感知（GPU FFT）
CSI = {}                # node -> deque[(t, rssi, mean_amp, turbulence)]
CSI_LAST = {}           # node -> 固件时间戳去重
CSI_STAT = {"batches": 0, "samples": 0, "last": 0.0, "from_wifi": 0, "from_usb": 0}
CSI_MAXLEN = 72000      # 约 1 小时 @20Hz（每条 4 个 float，几十 MB）
SENSE = {"v": None}
SENSE_ACT = {"empty": "无人/无明显活动", "still": "静止（呼吸级）", "moving": "小幅动作", "walking": "走动/大幅动作"}


def _csi_dq(node):
    dq = CSI.get(node)
    if dq is None:
        dq = CSI[node] = collections.deque(maxlen=CSI_MAXLEN)
    return dq


def csi_from_frame(f, t, nid):
    """ESP32 WiFi 直传帧里的 cs 特征序列：[[固件ms, rssi, 平均幅度x10, 湍流x1000], ...]"""
    cs = f.get("cs")
    if not isinstance(cs, dict) or not isinstance(cs.get("v"), list):
        return 0
    try:
        now_fw = float(cs.get("now", 0))
    except Exception:
        return 0
    n = 0
    last = CSI_LAST.get(nid, -1)
    if cs["v"] and cs["v"][0][0] < last - 1000:
        last = -1
    dq = _csi_dq(nid)
    for v in cs["v"]:
        try:
            fw = float(v[0])
            if fw <= last:
                continue
            tt = t - (now_fw - fw) / 1000.0
            if dq and tt <= dq[-1][0]:
                continue
            dq.append((tt, float(v[1]), float(v[2]) / 10.0, float(v[3]) / 1000.0))
            last = fw
            n += 1
        except Exception:
            continue
    CSI_LAST[nid] = last
    if n:
        CSI_STAT["samples"] += n
        CSI_STAT["from_wifi"] += n
        CSI_STAT["last"] = t
    return n


@app.route("/api/csi", methods=["POST", "OPTIONS"])
def csi_ingest():
    if request.method == "OPTIONS":
        return ("", 204)
    key = request.headers.get("X-Key") or request.args.get("key")
    origin_host = urlparse(request.headers.get("Origin", "") or "").netloc
    same = request.headers.get("Sec-Fetch-Site") == "same-origin" or (origin_host != "" and origin_host == request.host)
    if key != API_KEY and not same:
        return jsonify(ok=False, error="bad key"), 401
    j = request.get_json(force=True, silent=True)
    if not isinstance(j, dict) or not isinstance(j.get("v"), list):
        return jsonify(ok=False, error="bad csi batch"), 400
    node = str(j.get("node", "node"))
    n = 0
    with LOCK:
        dq = _csi_dq(node)
        for v in j["v"]:
            try:
                tt = float(v[0]) / 1000.0
                if dq and tt <= dq[-1][0]:
                    continue
                dq.append((tt, float(v[1]), float(v[2]), float(v[3])))
                n += 1
            except Exception:
                continue
        CSI_STAT["batches"] += 1
        CSI_STAT["samples"] += n
        CSI_STAT["from_usb"] += n
        CSI_STAT["last"] = time.time()
    if CSI_STAT["batches"] == 1:
        evt("OK", "csi", "收到第一批 CSI（网页 USB 转发）：node=%s %d 条" % (node, n), echo=True)
    return jsonify(ok=True, n=n)


@app.get("/api/sense")
def api_sense():
    return jsonify(sense=SENSE["v"], stat=CSI_STAT, nodes={k: len(v) for k, v in CSI.items()})


def _band(x, fs, f0, f1, dev):
    """x: 1D numpy。GPU 上做去趋势 + Hann + 补零 FFT，返回 (峰值频率, 峰值/中位数 SNR, 峰值幅度)。"""
    import numpy as np
    n = len(x)
    if torch is not None:
        t = torch.tensor(x, dtype=torch.float32, device=dev).view(1, 1, -1)
        k = 51 if n > 120 else 11
        trend = torch.nn.functional.avg_pool1d(t, k, 1, k // 2, count_include_pad=False)
        y = (t - trend).view(-1)
        y = y * torch.hann_window(n, device=dev)
        sp = torch.fft.rfft(y, n=4096).abs().cpu().numpy() / n
    else:
        k = 51 if n > 120 else 11
        tr = np.convolve(x, np.ones(k) / k, mode="same")
        y = (x - tr) * np.hanning(n)
        sp = np.abs(np.fft.rfft(y, n=4096)) / n
    fr = np.fft.rfftfreq(4096, 1.0 / fs)
    m = (fr >= f0) & (fr <= f1)
    if not m.any():
        return 0.0, 0.0, 0.0
    s = sp[m]
    i = int(s.argmax())
    med = float(np.median(s)) or 1e-9
    return float(fr[m][i]), float(s[i] / med), float(s[i])


def sense_loop():
    import numpy as np
    floor_hist = collections.deque(maxlen=180)
    st = {"present": False, "on": 0.0, "off": 0.0}
    dev = torch.device("cuda:0" if NGPU else "cpu") if torch is not None else None
    while True:
        time.sleep(1.0)
        try:
            now = time.time()
            with LOCK:
                best = None
                for nid, dq in CSI.items():
                    if dq and now - dq[-1][0] < 8 and (best is None or dq[-1][0] > best[1][-1][0]):
                        best = (nid, dq)
                if best is None:
                    SENSE["v"] = None
                    continue
                arr = np.array([x for x in list(best[1])[-1500:] if now - x[0] < 45], dtype=np.float64)
            if len(arr) < 20:
                continue
            t, r, m, d = arr[:, 0], arr[:, 1], arr[:, 2], arr[:, 3]
            age = now - t[-1]
            w2 = t > now - 2.5
            w1 = t > now - 1.2
            mv = float(d[w2].mean()) if w2.any() else 0.0
            mv1 = float(d[w1].mean()) if w1.any() else mv
            if age < 3:
                floor_hist.append(mv1)
            floor = max(0.004, float(np.percentile(list(floor_hist), 20)) * 1.1) if len(floor_hist) >= 8 else 0.0
            level = mv / floor if floor else 0.0
            tt = np.arange(now - 6, now, 0.05)
            dd = np.interp(tt, t, d)
            dom, _, _ = _band(dd, 20.0, 0.5, 8.0, dev)
            breath, snr = 0.0, 0.0
            if t[0] < now - 26 and age < 3:
                tm = np.arange(now - 32, now, 0.1)
                mm = np.interp(tm, t, m)
                bf, snr, bp = _band(mm, 10.0, 0.1, 0.55, dev)
                if snr >= 5 and bp > 0.02:
                    breath = bf * 60.0
            if floor and age < 3:
                if not st["present"] and level > 2.6:
                    st["on"] = st["on"] or now
                    if now - st["on"] > 0.9:
                        st["present"], st["off"] = True, 0.0
                elif not st["present"]:
                    st["on"] = 0.0
                if st["present"] and level < 1.7:
                    st["off"] = st["off"] or now
                    if now - st["off"] > 5:
                        st["present"], st["on"] = False, 0.0
                elif st["present"]:
                    st["off"] = 0.0
            elif age >= 3:
                st["present"], st["on"] = False, 0.0
            if st["present"]:
                act = "walking" if (level >= 7 and dom >= 0.5) else "moving" if level >= 3.5 else ("still" if breath else "moving")
            elif breath and level < 1.7:
                act = "still"
            else:
                act = "empty"
            SENSE["v"] = {"node": best[0], "n": int(len(arr)), "age": round(age, 1), "rate": round(float(w2.sum()) / 2.5, 1),
                          "level": round(level, 2), "floor": round(floor, 4), "present": bool(st["present"] or act == "still"),
                          "act": act, "act_txt": SENSE_ACT[act], "breath": round(breath, 1), "snr": round(snr, 2), "dom": round(dom, 2),
                          "gpu": (GPU_NAMES[0] if NGPU else "CPU"), "t": round(now, 1)}
        except Exception as e:
            evt_rate("sense_err", 30, "ERR", "csi", "CSI 分析出错：%r" % (e,), echo=True)


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
    TUNNEL["state"] = "已建立"
    TUNNEL["provider"] = TUNNEL.get("provider") or "cloudflared"
    TUNNEL["url"] = url
    evt("OK", "tunnel", "公网隧道已建立：" + url)
    threading.Thread(target=publish_url, args=(url,), daemon=True).start()
    line = "=" * 66
    print("\n" + line)
    print("🌐 全屏 3D 网站： " + url)
    print('📟 ESP32 config.h： #define SERVER_URL "%s"' % url)
    print("   或串口输入：     url %s" % url)
    print("🛰  自动发现：     已发布到 ntfy.sh/%s —— ESP32 联网后自动读取，无需重新烧录（固件 RADAR_TOPIC 必须与之相同）" % TOPIC)
    print("🔌 最稳方案：     用电脑 Chrome/Edge 打开上面网址 -> 点【USB 连接 ESP32】")
    print("🔑 API_KEY：       %s" % API_KEY)
    print("🩺 检测日志：     网页里点【🩺 检测日志】，或打开 %s/api/diag.txt（也写入 %s）" % (url, EVT_FILE))
    print(line + "\n", flush=True)
    try:
        from IPython.display import display, HTML as _H
        display(_H('<a href="%s" target="_blank" style="font-size:18px">▶ 点此打开全屏 3D 世界</a>' % url))
    except Exception:
        pass
    threading.Thread(target=_probe, args=(url,), daemon=True).start()


def publish_url(url):
    """把最新网址发布到汇合点 ntfy.sh/<TOPIC>：ESP32 会自动读取，Kaggle 重开后不用重新烧录固件。"""
    try:
        r = requests.post("https://ntfy.sh/" + TOPIC, data=url.encode("utf8"), headers={"Title": "wifi-radar-url", "Cache": "yes", **UA}, timeout=15)
        if r.status_code == 200:
            TUNNEL["published"] = int(time.time())
            TUNNEL["publish_err"] = ""
            evt("OK", "rendezvous", "已把网址发布到汇合点 ntfy.sh/%s（ESP32 将自动读取）" % TOPIC)
            return True
        TUNNEL["publish_err"] = "HTTP %d" % r.status_code
    except Exception as e:
        TUNNEL["publish_err"] = str(e)[:200]
    evt("WARN", "rendezvous", "发布网址到 ntfy.sh 失败：%s（ESP32 将只能用 config.h 里的 SERVER_URL；USB 直连不受影响）" % TUNNEL["publish_err"], echo=True)
    return False


def publish_loop():
    """每 4 分钟重发一次：固件只读取最近 30 分钟内的消息，所以网址始终“新鲜”。"""
    while True:
        time.sleep(240)
        if PUBLIC_URL:
            publish_url(PUBLIC_URL)


def _probe(url):
    for i in range(15):
        try:
            r = requests.get(url + "/api/health", timeout=8, headers=UA)
            if r.status_code == 200:
                TUNNEL["probe"] = "通过"
                evt("OK", "tunnel", "公网自检通过：%s/api/health" % url, echo=True)
                return
        except Exception:
            pass
        time.sleep(4)
    TUNNEL["probe"] = "未通过"
    evt("WARN", "tunnel", "公网自检 15 次均未通过")
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
            TUNNEL["state"] = "重试中"
            TUNNEL["attempts"] = attempt
            evt("WARN", "tunnel", "cloudflared 退出，第 %d 次重试…" % attempt, echo=True)
            time.sleep(3)

    threading.Thread(target=runner, daemon=True).start()


def start_ssh_tunnel():
    """cloudflared 60 秒内没拿到网址时的备用隧道：localhost.run（需要 ssh）。"""
    ssh = shutil.which("ssh")
    if not ssh:
        evt("WARN", "tunnel", "没有 ssh，无法使用备用隧道", echo=True)
        return

    def runner():
        p = subprocess.Popen([ssh, "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "ServerAliveInterval=30", "-o", "ExitOnForwardFailure=yes",
                              "-R", "80:127.0.0.1:%d" % PORT, "nokey@localhost.run"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        for line in p.stdout:
            m = re.search(r"https://[a-z0-9-]+\.lhr\.life", line)
            if m and not PUBLIC_URL:
                TUNNEL["provider"] = "localhost.run"
                _banner(m.group(0))
        evt("WARN", "tunnel", "备用隧道 localhost.run 已退出", echo=True)

    threading.Thread(target=runner, daemon=True).start()


def tunnel_watchdog():
    time.sleep(70)
    if not PUBLIC_URL:
        evt("WARN", "tunnel", "cloudflared 70 秒内没有给出网址，启动备用隧道 localhost.run", echo=True)
        start_ssh_tunnel()


def start_ngrok():
    _ensure("pyngrok")
    from pyngrok import ngrok
    ngrok.set_auth_token(NGROK_TOKEN)
    _banner(ngrok.connect(PORT, "http").public_url.replace("http://", "https://"))


# ===================== v6：GPU 大语言模型“诊断助手”（可选，后台加载，失败不影响雷达） =====================
# 作用：读取网页「检测日志」，用大模型给出“卡在哪一步、下一步怎么做”。不参与 CSI 数学计算（不会编造人体数据）。
# 显卡分配：>=2 张 T4 时用 Qwen2.5-7B-Instruct 切分到两张卡（device_map=auto，约 15GB）；1 张用 3B；无 GPU 用规则诊断。
# 环境变量：RADAR_LLM=off 关闭；RADAR_LLM=<HuggingFace 模型名> 指定模型。
LLM_NAME = os.environ.get("RADAR_LLM", "auto")
LLM = {"state": "未启动", "model": "", "err": "", "load_s": 0.0, "calls": 0, "last_ms": 0, "gpus": []}
_LLM_OBJ = {"tok": None, "model": None}
_LLM_LOCK = threading.Lock()
LLM_SYS = ("你是 ESP32-S3 WiFi 雷达（CSI 人体感知 + 3D 网页）的运维诊断助手。根据用户给出的『检测日志』，用中文简洁回答：1) 当前卡在哪一步；"
           "2) 最可能的原因（按概率排序，最多3条）；3) 对应的具体操作步骤。只依据日志里出现的事实，不要编造不存在的数据。"
           "务必记住物理边界：单个 ESP32 只能判断存在/运动/呼吸，3D 人体是示意模型；室内墙体无法还原。")


def rule_advice(report):
    r = report or ""
    tips = []
    if re.search(r"HTTP -1|connect timeout|连不上|无响应", r):
        tips.append("ESP32 或网页连不上服务器：Kaggle 重启后网址会变（固件通过汇合点自动读取），确认 Cell 仍在运行。")
    if re.search(r"401|API_KEY 不一致|bad key", r):
        tips.append("API_KEY 不一致：把 config.h 的 API_KEY 改成与本脚本一致（默认 radar-key）。")
    if re.search(r"0 字节|没有任何串口数据", r):
        tips.append("串口 0 字节：换 USB 口、关闭 PlatformIO 串口监视器、换数据线，重新 Upload 最新固件。")
    if re.search(r"下载模式|DOWNLOAD", r):
        tips.append("ESP32 在下载模式：松开 BOOT，按一下 RESET。")
    if re.search(r"CSI.*(未收到|等待|关闭)|csi=0", r):
        tips.append("没有 CSI：固件需填好 WIFI_SSID/WIFI_PASS（2.4GHz）后对路由器 ping 才有 CSI。")
    if not tips:
        tips.append("日志里没有发现明显故障。3D 里没人体时：让房间安静约 10 秒建立基线，再在 ESP32↔路由器连线附近走动。")
    return "【规则诊断】\n" + "\n".join("%d. %s" % (i + 1, t) for i, t in enumerate(tips))


def _llm_pick():
    if LLM_NAME.lower() in ("off", "0", "no", "none"):
        return []
    if LLM_NAME != "auto":
        return [LLM_NAME]
    if NGPU >= 2:
        return ["Qwen/Qwen2.5-7B-Instruct", "Qwen/Qwen2.5-3B-Instruct"]
    if NGPU == 1:
        return ["Qwen/Qwen2.5-3B-Instruct", "Qwen/Qwen2.5-1.5B-Instruct"]
    return []


def llm_loader():
    names = _llm_pick()
    if not names or torch is None or not NGPU:
        LLM["state"] = "关闭（无 GPU 或已禁用）"
        evt("INFO", "llm", "大模型诊断助手未启用：%s" % LLM["state"], echo=True)
        return
    try:
        _ensure("transformers")
        _ensure("accelerate")
        from transformers import AutoTokenizer, AutoModelForCausalLM
    except Exception as e:
        LLM["state"], LLM["err"] = "依赖安装失败", repr(e)[:300]
        evt("ERR", "llm", "transformers 安装/导入失败：%r（将使用规则诊断）" % (e,), echo=True)
        return
    for name in names:
        t0 = time.time()
        try:
            LLM["state"], LLM["model"] = "加载中", name
            evt("INFO", "llm", "开始加载大模型 %s（首次需下载，几分钟；后台进行，不影响雷达）" % name, echo=True)
            tok = AutoTokenizer.from_pretrained(name)
            if "7B" in name or "8B" in name or "14B" in name:
                mm = {0: "9GiB", 1: "13GiB"} if NGPU >= 2 else {0: "13GiB"}
                mdl = AutoModelForCausalLM.from_pretrained(name, torch_dtype=torch.float16, device_map="auto", max_memory=mm, low_cpu_mem_usage=True)
            else:
                dev = "cuda:%d" % (NGPU - 1)       # 小模型放最后一张卡，第一张留给 CSI FFT/定位求解
                mdl = AutoModelForCausalLM.from_pretrained(name, torch_dtype=torch.float16, low_cpu_mem_usage=True).to(dev)
            mdl.eval()
            _LLM_OBJ["tok"], _LLM_OBJ["model"] = tok, mdl
            LLM["state"], LLM["load_s"], LLM["err"] = "就绪", round(time.time() - t0, 1), ""
            LLM["gpus"] = [{"gpu": i, "used_gb": round(torch.cuda.mem_get_info(i)[1] / 1024 ** 3 - torch.cuda.mem_get_info(i)[0] / 1024 ** 3, 2)} for i in range(NGPU)]
            evt("OK", "llm", "✅ 大模型 %s 已就绪（用时 %.0fs，显存 %s）" % (name, LLM["load_s"], LLM["gpus"]), echo=True)
            return
        except Exception as e:
            LLM["state"], LLM["err"] = "加载失败", repr(e)[:300]
            evt("ERR", "llm", "加载 %s 失败：%r" % (name, e), echo=True)
            _LLM_OBJ["tok"] = _LLM_OBJ["model"] = None
            try:
                import gc
                gc.collect()
                torch.cuda.empty_cache()
            except Exception:
                pass


def llm_answer(report):
    tok, mdl = _LLM_OBJ["tok"], _LLM_OBJ["model"]
    if tok is None or mdl is None:
        return None
    msgs = [{"role": "system", "content": LLM_SYS}, {"role": "user", "content": "以下是检测日志（可能已截断）：\n" + report[-6500:]}]
    text = tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)
    inp = tok([text], return_tensors="pt").to(next(mdl.parameters()).device)
    with torch.no_grad():
        out = mdl.generate(**inp, max_new_tokens=480, do_sample=False, repetition_penalty=1.05)
    return tok.decode(out[0][inp["input_ids"].shape[1]:], skip_special_tokens=True).strip()


@app.route("/api/llm", methods=["GET", "POST", "OPTIONS"])
def api_llm():
    if request.method == "OPTIONS":
        return ("", 204)
    if request.method == "GET":
        return jsonify(ok=True, engine="llm" if _LLM_OBJ["model"] is not None else "rules", **LLM)
    j = request.get_json(force=True, silent=True) or {}
    report = str(j.get("report", ""))[:80000]
    problems = j.get("problems")
    rule_src = problems if isinstance(problems, str) else report
    t0 = time.time()
    if _LLM_OBJ["model"] is not None:
        try:
            with _LLM_LOCK:
                txt = llm_answer(("【未通过的检测项】\n" + problems + "\n\n【完整日志】\n" if isinstance(problems, str) else "") + report)
            ms = int((time.time() - t0) * 1000)
            LLM["calls"] += 1
            LLM["last_ms"] = ms
            evt("OK", "llm", "AI 分析完成：%dms，输出 %d 字" % (ms, len(txt or "")))
            return jsonify(ok=True, engine="llm", model=LLM["model"], text=txt, ms=ms)
        except Exception as e:
            evt("ERR", "llm", "AI 推理失败：%r" % (e,), echo=True)
            return jsonify(ok=True, engine="rules", model=None, text=rule_advice(rule_src) + "\n（大模型推理失败：%s）" % repr(e)[:160])
    return jsonify(ok=True, engine="rules", model=None, text=rule_advice(rule_src) + "\n（大模型状态：%s%s）" % (LLM["state"], "，" + LLM["err"] if LLM["err"] else ""))


def main():
    from werkzeug.serving import make_server
    srv = make_server("0.0.0.0", PORT, app, threaded=True)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print("[server] 监听 0.0.0.0:%d  GPU: %s" % (PORT, ", ".join(GPU_NAMES) or "无(CPU)"))
    print("[budget] 显存<=%.0fG/卡  内存<=%.0fG  磁盘<=%.0fG(%s)  起点数=%d" % (VRAM_GB, RAM_GB, DISK_GB, HIST_DIR, RESTARTS), flush=True)
    evt("INFO", "boot", "服务端 v%s 启动：python=%s torch=%s GPU=%s 日志文件=%s" % (VERSION, sys.version.split()[0], getattr(torch, "__version__", None) if torch is not None else "未安装", GPU_NAMES or "无", EVT_FILE), echo=True)
    for fn in (motion_loop, sense_loop, res_loop, hist_writer, publish_loop, llm_loader):
        threading.Thread(target=fn, daemon=True).start()
    threading.Thread(target=selftest, daemon=True).start()
    if USE_TUNNEL:
        if NGROK_TOKEN:
            start_ngrok()
        else:
            start_cloudflared()
            threading.Thread(target=tunnel_watchdog, daemon=True).start()
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
