# =============================================================================
#  Kaggle 单元（粘贴到 Notebook 第一个代码单元直接 Run）· 三 ESP32-S3 WiFi CSI 感知系统
#  Settings → Accelerator: GPU T4 x2   |   Internet: On
#
#  这个单元做 5 件事（全部自动、可重复运行）：
#   1) 检测 GPU（是否真的有两张 T4）
#   2) 从 GitHub 拉取仓库 → 构建 3D 浏览器模拟器（单文件 dist/index.html）
#   3) 本地 HTTP 托管 + Cloudflare 隧道 → 在输出框打印一个 https://….trycloudflare.com 网址（点开即用）
#   4) MQTT 采集器：订阅 ESP32-B/C 的原始 CSI 并「原样落盘」到 /kaggle/working/csi_raw（滚动文件 + 容量上限）
#   5) GPU 离线分析：B 在 cuda:0、C 在 cuda:1 并行做 STFT 时频特征（任务并行，不假装「双卡自动加速」）
#
#  v5 稳定性修复（针对 Kaggle 弹窗 "Oops something went wrong · Draft Session Fatal"）：
#   · 构建目录/node_modules/node/cloudflared 全部放在 /tmp/bzm（不在 /kaggle/working）：数万个小文件放在 working 会拖垮 Kaggle 的草稿保存/文件同步
#   · 原始 CSI 落盘到 /kaggle/temp（不被保存、不占 Output），默认上限 500MB；/kaggle/working 里只留一个很小的 site_url.txt
#   · 输出框内容恒定：用 clear_output(wait=True) 每 30s 重绘一次「网址 + 健康统计」，不会无限增长（输出过大是前端崩溃的常见原因）
#   · torch/CUDA 放进独立子进程（带超时），即使 GPU 分析崩溃也不会拖死 Notebook 内核
#   · MQTT client_id 带随机后缀（重跑单元不会和旧会话互相踢线）；连接/断线只计数不刷屏
#   · cloudflared 强制 http2 协议（Kaggle 常封 QUIC/UDP），后台线程持续读走日志，只提取网址
#   · 本地 HTTP 额外提供 /api/health（GPU/设备/采集状态，模拟器页面自动读取并显示「Kaggle GPU 辅助」徽标）
#
#  诚实说明：Kaggle 会话可能被停止/回收，不是永久服务器。设备 → 浏览器 的 MQTT 链路不经过 Kaggle，
#  Kaggle 停止后 ESP32 不会断连，只是网址失效；重新 Run 本单元会得到新网址。
# =============================================================================
import os, sys, re, json, time, glob, shutil, struct, socket, threading, subprocess, tarfile, urllib.request, uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from functools import partial

REPO_URL = os.environ.get("REPO_URL", "https://github.com/bizuming1-ui/yuyinkelong.git")
BRANCH = os.environ.get("REPO_BRANCH", "main")
MQTT_ROOT = os.environ.get("MQTT_ROOT", "bzm-csi/tri-5d2e8a1c")  # 必须与固件 config.h 的 MQTT_ROOT 一致
LOCAL_SRC = os.environ.get("LOCAL_SRC", "")  # 调试用：直接使用本地源码目录而不 git clone
PORT = int(os.environ.get("SITE_PORT", "8000"))
ON_KAGGLE = os.path.isdir("/kaggle")
BASE = "/tmp/bzm" if ON_KAGGLE else os.path.abspath("./work")  # 构建/依赖/隧道程序：不放进 /kaggle/working
os.makedirs(BASE, exist_ok=True)
SRC = os.path.join(BASE, "yuyinkelong")
RAW_DIR = os.path.join("/kaggle/temp" if os.path.isdir("/kaggle/temp") else BASE, "csi_raw")
RAW_LIMIT_BYTES = int(os.environ.get("RAW_LIMIT_MB", "500")) * 1024 * 1024
RUN_ID = uuid.uuid4().hex[:8]
STATE = {"gpu": {"n": 0, "names": [], "analysis": ""}, "url": "", "devices": "", "stats": {}, "t0": time.time()}
BROKERS_TCP = [("broker.hivemq.com", 1883), ("broker.emqx.io", 1883), ("test.mosquitto.org", 1883)]
BROKER_WS = ("broker.hivemq.com", 8884, "/mqtt")
STOP = threading.Event()


def sh(cmd, cwd=None, check=True, quiet=False, env=None):
    if not quiet:
        print("$", cmd if isinstance(cmd, str) else " ".join(cmd))
    r = subprocess.run(cmd, shell=isinstance(cmd, str), cwd=cwd, env=env, capture_output=True, text=True, timeout=900)
    if r.stdout and not quiet:
        print(r.stdout[-400:])
    if r.returncode != 0 and check:
        print(r.stderr[-3000:])
        raise RuntimeError(f"命令失败({r.returncode}): {cmd}")
    return r


# ----------------------------------------------------------------------------- 1) GPU
def gpu_report():
    """只用 nvidia-smi 检测（不在内核里 import torch/初始化 CUDA，避免拖垮 Notebook 内核）。"""
    print("=" * 70, "\n[1/5] GPU 检测")
    names = []
    try:
        r = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"], capture_output=True, text=True, timeout=20)
        names = [x.strip() for x in r.stdout.strip().splitlines() if x.strip()]
    except Exception as e:  # noqa
        print("  nvidia-smi 不可用：", e)
    for i, nme in enumerate(names):
        print(f"  cuda:{i} {nme}")
    t4 = sum("T4" in x for x in names)
    print(f"  → 检测到 {len(names)} 张 GPU（其中 T4 × {t4}）" + ("：双 GPU 并行分析已启用" if len(names) >= 2 else "：<2 张 GPU，分析退回单卡/CPU，不假装双卡"))
    STATE["gpu"]["n"] = len(names)
    STATE["gpu"]["names"] = names
    return len(names)


# ----------------------------------------------------------------------------- 2) 构建
def ensure_node():
    r = sh("node -v", check=False, quiet=True)
    if r.returncode == 0 and r.stdout.strip().startswith("v") and int(r.stdout.strip()[1:].split(".")[0]) >= 18:
        print("node", r.stdout.strip())
        return
    print("安装 Node.js 20（官方二进制包）…")
    ver = "v20.18.0"
    url = f"https://nodejs.org/dist/{ver}/node-{ver}-linux-x64.tar.xz"
    dst = os.path.join(BASE, "node.tar.xz")
    urllib.request.urlretrieve(url, dst)
    with tarfile.open(dst) as t:
        t.extractall("/tmp")
    os.environ["PATH"] = f"/tmp/node-{ver}-linux-x64/bin:" + os.environ["PATH"]
    sh("node -v")


def build_site():
    print("=" * 70, "\n[2/5] 获取源码并构建浏览器模拟器")
    if LOCAL_SRC:
        if os.path.exists(SRC):
            shutil.rmtree(SRC)
        shutil.copytree(LOCAL_SRC, SRC, ignore=shutil.ignore_patterns("node_modules", ".git", "dist", ".pio", "work"))
    elif os.path.isdir(os.path.join(SRC, ".git")):
        sh(["git", "fetch", "--depth", "1", "origin", BRANCH], cwd=SRC, check=False)
        sh(["git", "reset", "--hard", f"origin/{BRANCH}"], cwd=SRC)
    else:
        if os.path.exists(SRC):
            shutil.rmtree(SRC)
        sh(["git", "clone", "--depth", "1", "-b", BRANCH, REPO_URL, SRC])
    dist = os.path.join(SRC, "dist", "index.html")
    try:
        ensure_node()
        env = dict(os.environ, NODE_OPTIONS="--max-old-space-size=3072", CI="1")
        sh("npm install --no-audit --no-fund --loglevel=error --prefer-offline", cwd=SRC, env=env, quiet=True)
        r = sh("npm run build", cwd=SRC, env=env, quiet=True)
        print("  npm run build 完成")
    except Exception as e:  # noqa
        print("构建失败：", e)
        for alt in ("docs/index.html", "dist/index.html"):
            if os.path.exists(os.path.join(SRC, alt)):
                print("使用仓库里已提交的预构建文件：", alt)
                dist = os.path.join(SRC, alt)
                break
    if not os.path.exists(dist):
        raise SystemExit("找不到 dist/index.html：请确认 GitHub 仓库已同步最新代码（含 src/lib/manifest.ts、package.json），模拟器『复制代码』界面里全部显示『已同步』后再运行。")
    print("构建完成：", dist, f"{os.path.getsize(dist) / 1024:.0f} KB")
    return os.path.dirname(dist)


# ----------------------------------------------------------------------------- 3) 托管 + 隧道
class NoCache(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def do_GET(self):
        if self.path.split("?")[0] == "/api/health":
            body = json.dumps({"ok": True, "uptime": int(time.time() - STATE["t0"]), "gpu": STATE["gpu"], "devices": STATE["devices"], "stats": STATE["stats"], "ts": time.time()}, ensure_ascii=False).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def log_message(self, *a):
        pass


def serve(site_dir):
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), partial(NoCache, directory=site_dir))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print(f"本地托管 http://127.0.0.1:{PORT}")
    return srv


def get_cloudflared():
    exe = os.path.join(BASE, "cloudflared")
    if not os.path.exists(exe):
        print("下载 cloudflared…")
        for attempt in range(3):
            try:
                urllib.request.urlretrieve("https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64", exe + ".part")
                os.replace(exe + ".part", exe)
                break
            except Exception as e:  # noqa
                print("  cloudflared 下载失败，重试：", e)
                time.sleep(3)
        os.chmod(exe, 0o755)
    return exe


class Tunnel:
    """cloudflared 快速隧道；失败自动重启，失败多次则退回 localtunnel。"""

    def __init__(self):
        self.url = ""
        self.proc = None
        self.kind = ""
        self.restarts = 0

    def _read(self, proc, pat):
        for line in iter(proc.stdout.readline, ""):
            m = re.search(pat, line)
            if m and not self.url:
                self.url = m.group(0)
                STATE["url"] = self.url
                print("\n" + "★" * 70 + f"\n  浏览器模拟器网址（点开即用）：\n  {self.url}\n" + "★" * 70 + "\n")
                try:
                    open(os.path.join(BASE, "site_url.txt"), "w").write(self.url)
                except Exception:  # noqa
                    pass

    def start(self):
        self.url = ""
        try:
            if self.restarts < 3:
                self.kind = "cloudflared"
                self.proc = subprocess.Popen([get_cloudflared(), "tunnel", "--url", f"http://127.0.0.1:{PORT}", "--no-autoupdate", "--protocol", "http2"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
                pat = r"https://[-a-z0-9]+\.trycloudflare\.com"
            else:
                self.kind = "localtunnel"
                self.proc = subprocess.Popen("npx -y localtunnel --port %d" % PORT, shell=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
                pat = r"https://[-a-z0-9]+\.loca\.lt"
                try:
                    ip = urllib.request.urlopen("https://ipv4.icanhazip.com", timeout=8).read().decode().strip()
                    print(f"（localtunnel 首次访问会要求输入 Tunnel Password = 本机公网 IP：{ip}）")
                except Exception:  # noqa
                    pass
            threading.Thread(target=self._read, args=(self.proc, pat), daemon=True).start()
        except Exception as e:  # noqa
            print("隧道启动失败：", e)

    def alive(self):
        return self.proc is not None and self.proc.poll() is None

    def watch(self):
        if not self.alive():
            self.restarts += 1
            print(f"隧道已退出，重启（第 {self.restarts} 次，方式 {'cloudflared' if self.restarts < 3 else 'localtunnel'}）…")
            self.start()


# ----------------------------------------------------------------------------- 4) MQTT 采集器
class Collector:
    """订阅三台服务器；原始 payload 原样落盘（8 字节时间戳 + 4 字节长度 + 数据），按 node 分目录滚动。"""

    def __init__(self):
        os.makedirs(RAW_DIR, exist_ok=True)
        self.lock = threading.Lock()
        self.files = {}
        self.stats = {"msgs": 0, "bytes": 0, "dups": 0, "status": {}, "reconnects": 0, "last": {}}
        self.seen = set()
        self.seen_q = []
        self.clients = []
        self.connected = set()

    def _open(self, node):
        d = os.path.join(RAW_DIR, f"n{node}")
        os.makedirs(d, exist_ok=True)
        path = os.path.join(d, time.strftime("%Y%m%d_%H%M%S") + ".bin")
        self.files[node] = (open(path, "ab"), time.time(), 0, path)
        return self.files[node]

    def _write(self, node, payload):
        f, t0, n, path = self.files.get(node) or self._open(node)
        f.write(struct.pack("<QI", int(time.time() * 1e6), len(payload)) + payload)
        n += len(payload)
        self.files[node] = (f, t0, n, path)
        if n > 64 * 2**20 or time.time() - t0 > 600:
            f.close()
            self._open(node)
            self._cap()

    def _cap(self):
        fs = sorted(glob.glob(os.path.join(RAW_DIR, "n*", "*.bin")), key=os.path.getmtime)
        total = sum(os.path.getsize(p) for p in fs)
        while total > RAW_LIMIT_BYTES and len(fs) > 2:
            p = fs.pop(0)
            total -= os.path.getsize(p)
            os.remove(p)

    def on_message(self, topic, payload):
        t = topic[len(MQTT_ROOT) + 1:]
        with self.lock:
            if t.endswith("/csi") and len(payload) >= 8 and payload[0] == 0xC5 and payload[1] == 3:
                key = bytes(payload[:8]) + bytes(payload[8:20])
                if key in self.seen:
                    self.stats["dups"] += 1
                    return
                self.seen.add(key)
                self.seen_q.append(key)
                if len(self.seen_q) > 600:
                    self.seen.discard(self.seen_q.pop(0))
                node = payload[2]
                self._write(node, bytes(payload))
                self.stats["msgs"] += 1
                self.stats["bytes"] += len(payload)
                self.stats["last"][node] = time.time()
            elif t.endswith("/status"):
                try:
                    j = json.loads(payload.decode())
                    self.stats["status"][j.get("id")] = j
                except Exception:  # noqa
                    pass

    def start(self):
        try:
            import paho.mqtt.client as mqtt
        except ImportError:
            for extra in ([], ["--break-system-packages"], ["--user", "--break-system-packages"]):
                r = sh([sys.executable, "-m", "pip", "install", "-q", "paho-mqtt"] + extra, check=False, quiet=True)
                if r.returncode == 0:
                    break
            try:
                import importlib
                import site
                importlib.invalidate_caches()
                sys.path.append(site.getusersitepackages())
                import paho.mqtt.client as mqtt
            except ImportError:
                print("  ⚠ 无法安装 paho-mqtt：采集器已跳过（网站托管与隧道不受影响）")
                return
        ver2 = hasattr(mqtt, "CallbackAPIVersion")
        targets = [("tcp", h, p, None) for h, p in BROKERS_TCP] + [("ws", BROKER_WS[0], BROKER_WS[1], BROKER_WS[2])]
        for i, (kind, host, port, path) in enumerate(targets):
            cid = f"bzm-kaggle-{RUN_ID}-{i}"
            c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=cid, transport="websockets" if kind == "ws" else "tcp") if ver2 else mqtt.Client(client_id=cid, transport="websockets" if kind == "ws" else "tcp")
            if kind == "ws":
                c.tls_set()
                c.ws_set_options(path=path)

            def on_connect(cl, ud, *a, _h=host):
                cl.subscribe([(f"{MQTT_ROOT}/+/csi", 0), (f"{MQTT_ROOT}/+/status", 0)])
                self.connected.add(_h + str(id(cl) % 997))
                self.stats["connects"] = self.stats.get("connects", 0) + 1

            def on_disconnect(cl, ud, *a, _h=host):
                self.stats["reconnects"] += 1
                self.connected.discard(_h + str(id(cl) % 997))

            c.on_connect = on_connect
            c.on_disconnect = on_disconnect
            c.on_message = lambda cl, ud, m: self.on_message(m.topic, m.payload)
            c.reconnect_delay_set(1, 10)
            try:
                c.connect_async(host, port, keepalive=15)
                c.loop_start()
                self.clients.append(c)
            except Exception as e:  # noqa
                print("  MQTT 启动失败", host, e)

    def health(self):
        now = time.time()
        s = self.stats
        lines = []
        for nid, name in ((1, "A"), (2, "B"), (3, "C")):
            st = s["status"].get(nid)
            seen = s["last"].get(nid)
            if nid == 1:
                lines.append(f"A: {'在线 state=' + str(st.get('state')) + ' 发射=' + str(st.get('nowTx')) if st and st.get('online') else '离线/未收到'}")
            else:
                age = f"{now - seen:.0f}s 前" if seen else "未收到 CSI"
                extra = f" 配对={st.get('paired')} 未配对={st.get('unpaired')} 丢={st.get('drop')} rssi={st.get('rssi')}" if st else ""
                lines.append(f"{name}: CSI {age}{extra}")
        return " | ".join(lines)


# ----------------------------------------------------------------------------- 5) GPU 离线分析
def parse_file(path):
    import numpy as np

    amps = []
    with open(path, "rb") as f:
        while True:
            h = f.read(12)
            if len(h) < 12:
                break
            _, n = struct.unpack("<QI", h)
            p = f.read(n)
            if len(p) < n or n < 8 or p[0] != 0xC5:
                continue
            cnt = p[3]
            for i in range(cnt):
                o = 8 + i * 140
                if o + 140 > len(p):
                    break
                a = np.frombuffer(p[o + 12:o + 140], dtype=np.int8).astype(np.float32).reshape(64, 2)
                valid = np.r_[1:27, 38:64]
                amps.append(np.hypot(a[valid, 0], a[valid, 1]))
    return np.asarray(amps, dtype=np.float32)


GPU_WORKER = r"""
import sys, os, glob, json, struct, threading
import numpy as np
import torch
raw_dir, ngpu = sys.argv[1], int(sys.argv[2])
def parse_file(path, max_batches=3000):
    amps = []; nb = 0
    with open(path, "rb") as f:
        while nb < max_batches:
            h = f.read(12)
            if len(h) < 12: break
            _, n = struct.unpack("<QI", h)
            p = f.read(n)
            if len(p) < n or n < 8 or p[0] != 0xC5: continue
            nb += 1
            for i in range(p[3]):
                o = 8 + i * 140
                if o + 140 > len(p): break
                a = np.frombuffer(p[o + 12:o + 140], dtype=np.int8).astype(np.float32).reshape(64, 2)
                valid = np.r_[1:27, 38:64]
                amps.append(np.hypot(a[valid, 0], a[valid, 1]))
    return np.asarray(amps, dtype=np.float32)
res = {}
def work(node, dev):
    fs = sorted(glob.glob(os.path.join(raw_dir, "n%d" % node, "*.bin")), key=os.path.getmtime)
    if not fs: return
    a = parse_file(fs[-1])
    if len(a) < 256: return
    x = torch.from_numpy(a).to(dev)
    shape = x / x.mean(1, keepdim=True).clamp_min(1e-3)
    turb = (shape[1:] - shape[:-1]).abs().mean(1)
    series = x.mean(1) - x.mean(1).mean()
    spec = torch.stft(series, n_fft=128, hop_length=32, window=torch.hann_window(128, device=dev), return_complex=True).abs()
    res[node] = (len(a), float(turb.mean()), float(turb.std()), float(spec.mean()), str(dev))
ths = []
for node, i in ((2, 0), (3, 1)):
    dev = torch.device("cuda:%d" % i) if ngpu > i else (torch.device("cuda:0") if ngpu > 0 else torch.device("cpu"))
    t = threading.Thread(target=work, args=(node, dev)); t.start(); ths.append(t)
for t in ths: t.join()
out = []
for node, v in sorted(res.items()):
    out.append("节点%s@%s: %d 包 turb=%.4f±%.4f STFT均值=%.2f" % ("BC"[node - 2], v[4], v[0], v[1], v[2], v[3]))
print("RESULT:" + (" | ".join(out) if out else "（还没有足够的 CSI 数据可分析）"))
"""


def gpu_analyze(ngpu):
    """B→cuda:0，C→cuda:1 并行：每包形状湍流 + 平均幅度序列的 STFT 能量。放进独立子进程（超时保护），仅示范离线特征，不是定位结果。"""
    wp = os.path.join(BASE, "gpu_worker.py")
    with open(wp, "w") as f:
        f.write(GPU_WORKER)
    try:
        r = subprocess.run([sys.executable, wp, RAW_DIR, str(ngpu)], capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired:
        return "（GPU 分析超时，已跳过；不影响托管/隧道/采集）"
    for line in r.stdout.splitlines():
        if line.startswith("RESULT:"):
            return line[7:]
    return "（GPU 分析子进程失败：%s）" % (r.stderr.strip().splitlines() or ["无输出"])[-1][:160]


# ----------------------------------------------------------------------------- main
def render(tun, col, du, t0, gpu_line):
    """整块输出每次重绘（clear_output），输出框大小恒定。"""
    s = col.stats
    bar = "★" * 60
    lines = [
        bar,
        "  浏览器模拟器网址（点开即用，已启用 MQTT 三服务器并联）：",
        f"  {tun.url or '(获取中… 通常 5~20 秒)'}",
        bar,
        f"[{time.strftime('%H:%M:%S')}] 已运行 {int((time.time() - t0) / 60)} 分钟 | GPU: {', '.join(STATE['gpu']['names']) or '无'}",
        f"  设备: {col.health()}",
        f"  采集: {s['msgs']} 包 / {s['bytes'] / 1e6:.1f} MB，重复丢弃 {s['dups']}，MQTT 在线 {len(col.connected)}/{len(col.clients)}（累计重连 {s['reconnects']}），磁盘剩余 {du.free / 2**30:.1f} GiB",
        f"  GPU 离线分析: {gpu_line}",
        "  （这个单元要一直保持运行；Kaggle 停止后网址失效，但 ESP32 ↔ 浏览器的 MQTT 链路不受影响）",
    ]
    try:
        from IPython.display import clear_output

        clear_output(wait=True)
    except Exception:  # noqa
        pass
    print("\n".join(lines), flush=True)


def main():
    ngpu = gpu_report()
    site = build_site()
    print("=" * 70, "\n[3/5] 启动托管与隧道")
    serve(site)
    tun = Tunnel()
    tun.start()
    print("=" * 70, "\n[4/5] 启动 MQTT 采集器（原始 CSI 落盘到", RAW_DIR, "）")
    col = Collector()
    try:
        col.start()
    except Exception as e:  # noqa
        print("  ⚠ 采集器启动失败（网站托管与隧道不受影响）：", e)
    print("=" * 70, "\n[5/5] 运行中（Interrupt 停止）。输出框每 30 秒原地刷新一次。\n", flush=True)
    t0 = time.time()
    last_gpu = 0
    gpu_line = "（等待数据，约 2 分钟后首次分析）"
    try:
        while not STOP.is_set():
            for _ in range(30):
                if STOP.is_set():
                    break
                time.sleep(1)
                if not tun.url and _ == 14:
                    tun.watch()
            tun.watch()
            du = shutil.disk_usage(BASE)
            if time.time() - last_gpu > 120:
                last_gpu = time.time()
                try:
                    gpu_line = gpu_analyze(ngpu)
                except Exception as e:  # noqa
                    gpu_line = f"GPU 分析出错：{e}"
                STATE["gpu"]["analysis"] = gpu_line
            STATE["devices"] = col.health()
            STATE["stats"] = {k: v for k, v in col.stats.items() if k in ("msgs", "bytes", "dups", "reconnects")}
            render(tun, col, du, t0, gpu_line)
    except KeyboardInterrupt:
        pass
    finally:
        STOP.set()
        for c in col.clients:
            try:
                c.loop_stop()
            except Exception:  # noqa
                pass
        if tun.proc:
            tun.proc.terminate()
        print("已停止。原始 CSI 保留在", RAW_DIR)


if __name__ == "__main__":
    main()
