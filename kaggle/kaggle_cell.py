# =============================================================================
#  Kaggle 单元 v6.0（粘贴到 Notebook 第一个代码单元直接 Run）· 三 ESP32-S3 WiFi CSI 2.5D 感知系统
#  Settings → Accelerator: GPU T4 x2 (或 CPU)   |   Internet: On
#
#  ★ v6.0 针对图片中 Kaggle 报错 "Oops something went wrong · Draft Session Fatal" 的根因级彻底修复：
#   1) 自动清理 /kaggle/working 历史残留：启动时立即清除旧版遗留在 /kaggle/working/yuyinkelong 与
#      /kaggle/working/csi_raw 的数万个 node_modules 小文件（这是拖垮 Kaggle Draft 文件同步代理导致 Fatal 的头号元凶）。
#   2) 彻底消除后台线程 print() 并发写 ZMQ 崩溃：图片中崩溃正好发生在多个 paho-mqtt 线程同时 print("MQTT 已连接...")
#      的瞬间。v6.0 严禁任何后台线程（MQTT / Tunnel / HTTP）调用 print()，所有状态统一写入线程安全 STATE，仅主线程输出。
#   3) 子进程文件描述符隔离（close_fds=True + start_new_session=True + stdin=DEVNULL）：防止 cloudflared / npm
#      继承 Jupyter 内核的 ZMQ 心跳套接字导致内核假死。
#   4) 摒弃高频 clear_output() 刷屏：改用 IPython DisplayHandle.update() 原地轻量更新单个 HTML 仪表盘面板，
#      避免触发 Kaggle 前端高频自动保存 Draft 导致浏览器内存溢出。
#   5) 端口自动复用与僵尸进程清理：重跑单元时自动清理旧隧道进程并支持端口无缝切换，绝不报 Address already in use。
#   6) 输出框直接提供「点击打开浏览器模拟器网址」大按钮 + 实时健康监控。
# =============================================================================
import os, sys, re, json, time, glob, shutil, struct, socket, signal, threading, subprocess, tarfile, urllib.request, uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from functools import partial

REPO_URL = os.environ.get("REPO_URL", "https://github.com/bizuming1-ui/yuyinkelong.git")
BRANCH = os.environ.get("REPO_BRANCH", "main")
MQTT_ROOT = os.environ.get("MQTT_ROOT", "bzm-csi/tri-5d2e8a1c")  # 必须与固件 config.h 的 MQTT_ROOT 一致
LOCAL_SRC = os.environ.get("LOCAL_SRC", "")  # 调试用：直接使用本地源码目录而不 git clone
PORT = int(os.environ.get("SITE_PORT", "8000"))
MAX_RUN_SECONDS = int(os.environ.get("MAX_RUN_SECONDS", "0"))  # 0=持续运行；>0 用于沙盒自检定时退出
ON_KAGGLE = os.path.isdir("/kaggle")
BASE = "/tmp/bzm" if ON_KAGGLE else os.path.abspath("./work")
os.makedirs(BASE, exist_ok=True)
SRC = os.path.join(BASE, "yuyinkelong")
RAW_DIR = os.path.join("/kaggle/temp" if os.path.isdir("/kaggle/temp") else BASE, "csi_raw")
RAW_LIMIT_BYTES = int(os.environ.get("RAW_LIMIT_MB", "400")) * 1024 * 1024
RUN_ID = uuid.uuid4().hex[:8]
STATE_LOCK = threading.Lock()
STATE = {
    "gpu": {"n": 0, "names": [], "analysis": "（等待数据，约 90 秒后首次分析）"},
    "url": "",
    "local_url": "",
    "devices": "等待设备数据…",
    "stats": {"msgs": 0, "bytes": 0, "dups": 0, "reconnects": 0},
    "t0": time.time(),
}
BROKERS_TCP = [("broker.hivemq.com", 1883), ("broker.emqx.io", 1883), ("test.mosquitto.org", 1883)]
BROKER_WS = ("broker.hivemq.com", 8884, "/mqtt")
STOP = threading.Event()


def clean_kaggle_working():
    """清理旧版本在 /kaggle/working 下遗留的 node_modules / 源码 / 原始数据目录，防止 Kaggle Draft 同步崩溃。"""
    if not ON_KAGGLE:
        return
    working = "/kaggle/working"
    for bad in ("yuyinkelong", "csi_raw", "node_modules", "work", "cloudflared"):
        p = os.path.join(working, bad)
        if os.path.exists(p):
            try:
                if os.path.isdir(p):
                    shutil.rmtree(p, ignore_errors=True)
                else:
                    os.remove(p)
                print(f"  ✓ 已清理 /kaggle/working/{bad}（释放 Draft 同步压力）")
            except Exception:
                pass


def sh(cmd, cwd=None, check=True, quiet=False, env=None, timeout=900):
    if not quiet:
        print("$", cmd if isinstance(cmd, str) else " ".join(cmd), flush=True)
    r = subprocess.run(
        cmd,
        shell=isinstance(cmd, str),
        cwd=cwd,
        env=env,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=timeout,
        close_fds=True,
        start_new_session=True,
    )
    if r.stdout and not quiet:
        print(r.stdout[-360:], flush=True)
    if r.returncode != 0 and check:
        print(r.stderr[-2000:], flush=True)
        raise RuntimeError(f"命令失败({r.returncode}): {cmd}")
    return r


# ----------------------------------------------------------------------------- 1) GPU
def gpu_report():
    """只用 nvidia-smi 检测（不在主内核里初始化 CUDA，零显存/内核开销）。"""
    print("=" * 70, "\n[1/5] 环境清理与 GPU 检测", flush=True)
    clean_kaggle_working()
    names = []
    try:
        r = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=15,
            close_fds=True,
        )
        names = [x.strip() for x in r.stdout.strip().splitlines() if x.strip()]
    except Exception:
        pass
    for i, nme in enumerate(names):
        print(f"  cuda:{i} {nme}", flush=True)
    t4 = sum("T4" in x for x in names)
    print(
        f"  → 检测到 {len(names)} 张 GPU（其中 T4 × {t4}）"
        + ("：双 GPU 并行离线分析已启用" if len(names) >= 2 else "：单卡/CPU 离线分析已就绪"),
        flush=True,
    )
    with STATE_LOCK:
        STATE["gpu"]["n"] = len(names)
        STATE["gpu"]["names"] = names
    return len(names)


# ----------------------------------------------------------------------------- 2) 构建
def ensure_node():
    r = sh("node -v", check=False, quiet=True)
    if r.returncode == 0 and r.stdout.strip().startswith("v"):
        try:
            major = int(r.stdout.strip()[1:].split(".")[0])
            if major >= 18:
                print("  Node.js 已就绪:", r.stdout.strip(), flush=True)
                return
        except Exception:
            pass
    print("  安装 Node.js 20（官方二进制包到 /tmp）…", flush=True)
    ver = "v20.18.0"
    url = f"https://nodejs.org/dist/{ver}/node-{ver}-linux-x64.tar.xz"
    dst = os.path.join(BASE, "node.tar.xz")
    urllib.request.urlretrieve(url, dst)
    with tarfile.open(dst) as t:
        t.extractall("/tmp")
    os.environ["PATH"] = f"/tmp/node-{ver}-linux-x64/bin:" + os.environ["PATH"]
    sh("node -v")


def build_site():
    print("=" * 70, "\n[2/5] 获取源码并构建单文件 2.5D 浏览器模拟器", flush=True)
    if LOCAL_SRC:
        if os.path.exists(SRC):
            shutil.rmtree(SRC)
        shutil.copytree(LOCAL_SRC, SRC, ignore=shutil.ignore_patterns("node_modules", ".git", "dist", ".pio", "work"))
    elif os.path.isdir(os.path.join(SRC, ".git")):
        sh(["git", "fetch", "--depth", "1", "origin", BRANCH], cwd=SRC, check=False, quiet=True)
        sh(["git", "reset", "--hard", f"origin/{BRANCH}"], cwd=SRC, quiet=True)
    else:
        if os.path.exists(SRC):
            shutil.rmtree(SRC)
        sh(["git", "clone", "--depth", "1", "-b", BRANCH, REPO_URL, SRC], quiet=True)
    dist = os.path.join(SRC, "dist", "index.html")
    try:
        ensure_node()
        env = dict(os.environ, NODE_OPTIONS="--max-old-space-size=2560", CI="1", NO_COLOR="1")
        sh("npm install --no-audit --no-fund --loglevel=error --prefer-offline", cwd=SRC, env=env, quiet=True)
        sh("npm run build", cwd=SRC, env=env, quiet=True)
        print("  ✓ npm run build 完成", flush=True)
    except Exception as e:
        print("  ⚠ 构建异常，尝试回退预构建产物：", e, flush=True)
        for alt in ("docs/index.html", "dist/index.html"):
            if os.path.exists(os.path.join(SRC, alt)):
                dist = os.path.join(SRC, alt)
                break
    if not os.path.exists(dist):
        raise SystemExit("找不到 dist/index.html：请确认 GitHub 仓库已同步最新代码。")
    size_kb = os.path.getsize(dist) / 1024
    print(f"  ✓ 模拟器构建成功：{dist} ({size_kb:.0f} KB)", flush=True)
    if ON_KAGGLE and os.path.isdir("/kaggle/working"):
        try:
            shutil.copyfile(dist, "/kaggle/working/simulator_standalone.html")
        except Exception:
            pass
    return os.path.dirname(dist)


# ----------------------------------------------------------------------------- 3) 托管 + 隧道
class ReusableHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def do_GET(self):
        if self.path.split("?")[0] == "/api/health":
            with STATE_LOCK:
                payload = {
                    "ok": True,
                    "uptime": int(time.time() - STATE["t0"]),
                    "gpu": STATE["gpu"],
                    "devices": STATE["devices"],
                    "stats": STATE["stats"],
                    "url": STATE["url"],
                    "ts": time.time(),
                }
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def log_message(self, *args):
        pass  # 严禁在 HTTP 线程内向 stdout 打印，避免触发 ipykernel ZMQ 线程竞争


def serve(site_dir):
    global PORT
    srv = None
    for p in range(PORT, PORT + 15):
        try:
            srv = ReusableHTTPServer(("0.0.0.0", p), partial(NoCacheHandler, directory=site_dir))
            PORT = p
            break
        except OSError:
            continue
    if srv is None:
        srv = ReusableHTTPServer(("0.0.0.0", 0), partial(NoCacheHandler, directory=site_dir))
        PORT = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    local_u = f"http://127.0.0.1:{PORT}"
    with STATE_LOCK:
        STATE["local_url"] = local_u
    print(f"  ✓ 本地 HTTP 托管已启动：{local_u}", flush=True)
    return srv


def get_cloudflared():
    exe = os.path.join(BASE, "cloudflared")
    if not os.path.exists(exe) or os.path.getsize(exe) < 1_000_000:
        print("  下载 cloudflared 隧道客户端…", flush=True)
        for attempt in range(3):
            try:
                urllib.request.urlretrieve(
                    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64",
                    exe + ".part",
                )
                os.replace(exe + ".part", exe)
                break
            except Exception:
                time.sleep(2)
        if os.path.exists(exe):
            os.chmod(exe, 0o755)
    return exe


class Tunnel:
    """后台静默读取隧道 URL，绝不在后台线程调用 print()，彻底避免 Jupyter ZMQ iopub 崩溃。"""

    def __init__(self):
        self.url = ""
        self.proc = None
        self.kind = ""
        self.restarts = 0
        self.printed_once = False

    def _read_stream(self, proc, pat):
        try:
            for line in iter(proc.stdout.readline, ""):
                if STOP.is_set():
                    break
                m = re.search(pat, line)
                if m and not self.url:
                    u = m.group(0).strip()
                    self.url = u
                    with STATE_LOCK:
                        STATE["url"] = u
                    for p in filter(None, [os.path.join(BASE, "site_url.txt"), "/kaggle/working/site_url.txt" if ON_KAGGLE else None]):
                        try:
                            with open(p, "w") as f:
                                f.write(u + "\n")
                        except Exception:
                            pass
        except Exception:
            pass

    def start(self):
        if os.environ.get("SKIP_TUNNEL") == "1":
            self.url = f"http://127.0.0.1:{PORT}"
            with STATE_LOCK:
                STATE["url"] = self.url
            return
        self.stop_proc()
        self.url = ""
        try:
            if self.restarts < 4:
                self.kind = "cloudflared"
                exe = get_cloudflared()
                self.proc = subprocess.Popen(
                    [exe, "tunnel", "--url", f"http://127.0.0.1:{PORT}", "--no-autoupdate", "--protocol", "http2"],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    close_fds=True,
                    start_new_session=True,
                )
                pat = r"https://[-a-z0-9]+\.trycloudflare\.com"
            else:
                self.kind = "localtunnel"
                self.proc = subprocess.Popen(
                    f"npx -y localtunnel --port {PORT}",
                    shell=True,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    close_fds=True,
                    start_new_session=True,
                )
                pat = r"https://[-a-z0-9]+\.loca\.lt"
            threading.Thread(target=self._read_stream, args=(self.proc, pat), daemon=True).start()
        except Exception:
            pass

    def alive(self):
        return self.proc is not None and self.proc.poll() is None

    def stop_proc(self):
        if self.proc is not None:
            try:
                self.proc.terminate()
                self.proc.wait(timeout=3)
            except Exception:
                try:
                    self.proc.kill()
                except Exception:
                    pass
            self.proc = None

    def watch(self):
        if os.environ.get("SKIP_TUNNEL") == "1":
            return
        if not self.alive():
            self.restarts += 1
            self.start()


# ----------------------------------------------------------------------------- 4) MQTT 采集器
class Collector:
    """订阅多台 MQTT 服务器并落盘到 /tmp 或 /kaggle/temp，后台回调零 print()。"""

    def __init__(self):
        os.makedirs(RAW_DIR, exist_ok=True)
        self.lock = threading.Lock()
        self.files = {}
        self.stats = {"msgs": 0, "bytes": 0, "dups": 0, "status": {}, "reconnects": 0, "last": {}, "connects": 0}
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
        if n > 32 * 2**20 or time.time() - t0 > 600:
            f.close()
            self._open(node)
            self._cap()

    def _cap(self):
        fs = sorted(glob.glob(os.path.join(RAW_DIR, "n*", "*.bin")), key=os.path.getmtime)
        total = sum(os.path.getsize(p) for p in fs if os.path.exists(p))
        while total > RAW_LIMIT_BYTES and len(fs) > 2:
            p = fs.pop(0)
            try:
                total -= os.path.getsize(p)
                os.remove(p)
            except Exception:
                pass

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
                    j = json.loads(payload.decode("utf-8", errors="ignore"))
                    self.stats["status"][j.get("id")] = j
                except Exception:
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
                import importlib, site
                importlib.invalidate_caches()
                for sp in site.getsitepackages() + [site.getusersitepackages()]:
                    if sp not in sys.path:
                        sys.path.append(sp)
                import paho.mqtt.client as mqtt
            except ImportError:
                print("  ⚠ 未能安装 paho-mqtt：跳过后台采集（浏览器模拟器网页与隧道不受影响）", flush=True)
                return
        ver2 = hasattr(mqtt, "CallbackAPIVersion")
        targets = [("tcp", h, p, None) for h, p in BROKERS_TCP] + [("ws", BROKER_WS[0], BROKER_WS[1], BROKER_WS[2])]
        for i, (kind, host, port, path) in enumerate(targets):
            cid = f"bzm-kaggle-{RUN_ID}-{i}"
            c = (
                mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=cid, transport="websockets" if kind == "ws" else "tcp")
                if ver2
                else mqtt.Client(client_id=cid, transport="websockets" if kind == "ws" else "tcp")
            )
            if kind == "ws":
                c.tls_set()
                c.ws_set_options(path=path)

            def on_connect(cl, ud, *a, _k=f"{host}:{port}"):
                cl.subscribe([(f"{MQTT_ROOT}/+/csi", 0), (f"{MQTT_ROOT}/+/status", 0)])
                with self.lock:
                    self.connected.add(_k)
                    self.stats["connects"] = self.stats.get("connects", 0) + 1

            def on_disconnect(cl, ud, *a, _k=f"{host}:{port}"):
                with self.lock:
                    self.stats["reconnects"] += 1
                    self.connected.discard(_k)

            c.on_connect = on_connect
            c.on_disconnect = on_disconnect
            c.on_message = lambda cl, ud, m: self.on_message(m.topic, m.payload)
            c.reconnect_delay_set(1, 10)
            try:
                c.connect_async(host, port, keepalive=15)
                c.loop_start()
                self.clients.append(c)
            except Exception:
                pass

    def health(self):
        now = time.time()
        with self.lock:
            s = self.stats
            lines = []
            for nid, name in ((1, "ESP32-1(A)"), (2, "ESP32-B"), (3, "ESP32-C")):
                st = s["status"].get(nid)
                seen = s["last"].get(nid)
                if nid == 1:
                    lines.append(
                        f"{name}: {'在线 state=' + str(st.get('state')) + ' 发射=' + str(st.get('nowTx')) if st and st.get('online') else '待机/未收到'}"
                    )
                else:
                    age = f"{now - seen:.0f}s前" if seen else "等待CSI"
                    extra = f" 配对={st.get('paired')} rssi={st.get('rssi')}" if st else ""
                    lines.append(f"{name}: {age}{extra}")
            return " | ".join(lines)


# ----------------------------------------------------------------------------- 5) GPU 离线分析（独立子进程）
GPU_WORKER = r"""
import sys, os, glob, struct, threading
import numpy as np
raw_dir, ngpu = sys.argv[1], int(sys.argv[2])
def parse_file(path, max_batches=2500):
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

try:
    import torch
    has_torch = True
except Exception:
    has_torch = False

res = {}
def work(node, i):
    fs = sorted(glob.glob(os.path.join(raw_dir, "n%d" % node, "*.bin")), key=os.path.getmtime)
    if not fs: return
    a = parse_file(fs[-1])
    if len(a) < 128: return
    if has_torch:
        dev = torch.device("cuda:%d" % i) if ngpu > i else (torch.device("cuda:0") if ngpu > 0 else torch.device("cpu"))
        x = torch.from_numpy(a).to(dev)
        shape = x / x.mean(1, keepdim=True).clamp_min(1e-3)
        turb = (shape[1:] - shape[:-1]).abs().mean(1)
        series = x.mean(1) - x.mean(1).mean()
        spec = torch.stft(series, n_fft=64, hop_length=16, window=torch.hann_window(64, device=dev), return_complex=True).abs()
        res[node] = (len(a), float(turb.mean()), float(turb.std()), float(spec.mean()), str(dev))
    else:
        shape = a / np.maximum(1e-3, a.mean(axis=1, keepdims=True))
        turb = np.abs(shape[1:] - shape[:-1]).mean(axis=1)
        res[node] = (len(a), float(turb.mean()), float(turb.std()), 0.0, "cpu-numpy")

ths = []
for node, i in ((2, 0), (3, 1)):
    t = threading.Thread(target=work, args=(node, i))
    t.start()
    ths.append(t)
for t in ths: t.join()
out = []
for node, v in sorted(res.items()):
    out.append("ESP32-%s@%s: %d包 turb=%.4f±%.4f STFT=%.2f" % ("BC"[node - 2], v[4], v[0], v[1], v[2], v[3]))
print("RESULT:" + (" | ".join(out) if out else "（等待足够 CSI 数据后自动输出 GPU STFT 特征）"))
"""


def gpu_analyze(ngpu):
    wp = os.path.join(BASE, "gpu_worker.py")
    with open(wp, "w") as f:
        f.write(GPU_WORKER)
    try:
        r = subprocess.run(
            [sys.executable, wp, RAW_DIR, str(ngpu)],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=90,
            close_fds=True,
            start_new_session=True,
        )
    except subprocess.TimeoutExpired:
        return "（GPU 分析子进程超时已跳过，不影响模拟器网页与采集）"
    for line in r.stdout.splitlines():
        if line.startswith("RESULT:"):
            return line[7:]
    return "（等待 CSI 数据积累中）"


def make_html_panel(url, local_url, up_min, gpu_names, dev_line, msgs, mb, dups, mq_on, mq_tot, reconn, free_gb, gpu_line):
    u_show = url or "正在分配 Cloudflare 公网安全隧道网址（约需 5~15 秒）…"
    btn_html = (
        f'<a href="{url}" target="_blank" rel="noopener noreferrer" '
        f'style="display:inline-block;margin-top:8px;padding:10px 20px;background:#22d3ee;color:#0f172a;'
        f'font-weight:800;border-radius:8px;text-decoration:none;font-size:14px;">'
        f'🚀 点击在新标签页打开 3D/2.5D 浏览器模拟器</a>'
        if url
        else '<span style="color:#fbbf24;font-size:12px;">⏳ 隧道连接建立中，请稍候…</span>'
    )
    return f"""
    <div style="font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;background:#071120;color:#e2e8f0;padding:16px;border-radius:12px;border:2px solid #0ea5e9;max-width:880px;line-height:1.5;">
      <div style="font-size:15px;font-weight:800;color:#38bdf8;margin-bottom:6px;">
        ★ 三 ESP32-S3 (ESP32-1/A · ESP32-B · ESP32-C) 2.5D 浏览器模拟器已就绪（Kaggle v6.0 零崩溃守护）
      </div>
      <div style="background:#020617;padding:10px 12px;border-radius:8px;border:1px solid #1e293b;margin-bottom:8px;">
        <div style="font-size:12px;color:#94a3b8;">🌐 浏览器模拟器公网网址（复制或直接点击下方按钮打开）：</div>
        <div style="font-size:15px;font-weight:700;color:#67e8f9;word-break:break-all;margin-top:2px;">{u_show}</div>
        {btn_html}
      </div>
      <div style="font-size:12px;color:#cbd5e1;">
        <div>⏱ 运行时长: <b>{up_min} 分钟</b> | 本地托管: <code>{local_url}</code> | GPU: <b>{', '.join(gpu_names) or 'CPU模式'}</b></div>
        <div>📡 设备状态: {dev_line}</div>
        <div>📊 采集统计: <b>{msgs}</b> 包 ({mb:.2f} MB) | 重复过滤: {dups} | MQTT 在线: <b>{mq_on}/{mq_tot}</b> (重连 {reconn}) | 临时盘剩余: {free_gb:.1f} GiB</div>
        <div>🧠 离线分析: {gpu_line}</div>
        <div style="color:#64748b;margin-top:4px;font-size:11px;">
          提示：右侧 Output 中已生成 simulator_standalone.html，也可随时下载到本地直接用浏览器双击打开。
        </div>
      </div>
    </div>
    """


def main():
    ngpu = gpu_report()
    site = build_site()
    print("=" * 70, "\n[3/5] 启动 HTTP 托管与 Cloudflare 隧道", flush=True)
    serve(site)
    tun = Tunnel()
    tun.start()
    print("=" * 70, "\n[4/5] 启动 MQTT 多路并联采集器（数据落盘到", RAW_DIR, "）", flush=True)
    col = Collector()
    try:
        col.start()
    except Exception as e:
        print("  ⚠ 采集器启动跳过：", e, flush=True)

    # 等待最多 12 秒以尽早拿到公网网址并首次打印
    for _ in range(24):
        if tun.url or STOP.is_set():
            break
        time.sleep(0.5)
    if tun.url:
        print("\n" + "★" * 72, flush=True)
        print("  浏览器模拟器网址（点开即用）：", flush=True)
        print(" ", tun.url, flush=True)
        print("★" * 72 + "\n", flush=True)

    print("=" * 70, "\n[5/5] 稳定运行中（v6.0 零崩溃模式）。面板每 30 秒原地轻量更新一次。\n", flush=True)

    disp_handle = None
    HTML_cls = None
    try:
        from IPython.display import display, HTML
        HTML_cls = HTML
        disp_handle = display(HTML("<div>正在初始化实时监控面板…</div>"), display_id="bzm_live_panel")
    except Exception:
        disp_handle = None

    t0 = time.time()
    last_gpu = 0
    gpu_line = "（等待数据，约 90 秒后首次分析）"
    printed_url = tun.url
    try:
        while not STOP.is_set():
            if not tun.url:
                tun.watch()
            elif tun.url != printed_url:
                printed_url = tun.url
                print(f"\n★ 浏览器模拟器网址：{tun.url}\n", flush=True)

            du = shutil.disk_usage(BASE)
            now = time.time()
            if now - last_gpu > 90:
                last_gpu = now
                try:
                    gpu_line = gpu_analyze(ngpu)
                except Exception as e:
                    gpu_line = f"GPU 分析跳过：{e}"

            dev_line = col.health()
            with col.lock:
                msgs = col.stats["msgs"]
                byts = col.stats["bytes"]
                dups = col.stats["dups"]
                reconn = col.stats["reconnects"]
                mq_on = len(col.connected)
                mq_tot = len(col.clients)

            with STATE_LOCK:
                STATE["gpu"]["analysis"] = gpu_line
                STATE["devices"] = dev_line
                STATE["stats"] = {"msgs": msgs, "bytes": byts, "dups": dups, "reconnects": reconn}

            up_min = int((now - t0) / 60)
            if disp_handle is not None and HTML_cls is not None:
                try:
                    panel = make_html_panel(
                        tun.url,
                        STATE["local_url"],
                        up_min,
                        STATE["gpu"]["names"],
                        dev_line,
                        msgs,
                        byts / 1e6,
                        dups,
                        mq_on,
                        mq_tot,
                        reconn,
                        du.free / 2**30,
                        gpu_line,
                    )
                    disp_handle.update(HTML_cls(panel))
                except Exception:
                    pass
            else:
                print(
                    f"[{time.strftime('%H:%M:%S')}] 网址={tun.url or STATE['local_url']} | {dev_line} | 采集={msgs}包 MQTT={mq_on}/{mq_tot}",
                    flush=True,
                )

            if MAX_RUN_SECONDS > 0 and (now - t0) >= MAX_RUN_SECONDS:
                print(f"  ✓ 已达到设定的自检运行时间 ({MAX_RUN_SECONDS}s)，正常退出。", flush=True)
                break

            for _ in range(30):
                if STOP.is_set() or (MAX_RUN_SECONDS > 0 and (time.time() - t0) >= MAX_RUN_SECONDS):
                    break
                time.sleep(1)
                if not tun.url and _ == 12:
                    tun.watch()
            tun.watch()
    except KeyboardInterrupt:
        pass
    finally:
        STOP.set()
        for c in col.clients:
            try:
                c.loop_stop()
            except Exception:
                pass
        tun.stop_proc()
        print("已安全停止。原始 CSI 保存在", RAW_DIR, flush=True)


if __name__ == "__main__":
    main()
