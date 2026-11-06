# =============================================================================
#  Kaggle 单元 v7.0（粘贴到 Notebook 第一个代码单元直接 Run）· 三 ESP32-S3 WiFi CSI 2.5D 感知系统
#  Settings → Accelerator: GPU T4 x2（或 CPU 也行）   |   Internet: On
#
#  ★ 针对 "Oops something went wrong · Draft Session Fatal" 的第一性原理修复（v7.0）
#
#   证据：你保存的 notebook 输出里，最后一条输出是 display_data（"正在初始化实时监控面板…"），
#         崩溃正好发生在 display(HTML, display_id=...) + 后续 update 的时刻。
#         v5 用高频 clear_output() 也崩，v6 改成 DisplayHandle.update() 仍崩 —— 两个版本的共同点是：
#         「长时间运行的单元里，持续向 Kaggle 前端推送【富输出/可更新输出】」。
#   结论：问题不在后端而在前端的输出通道。所以 v7 不是"再优化一次面板"，而是彻底移除这条通道：
#     1) 单元里不再出现 IPython.display / HTML / display_id / clear_output / update_display，只有少量纯文本 print（总计 < 40 行）。
#     2) 所有重活（git / npm / Vite 构建 / HTTP / 隧道 / MQTT 采集 / GPU 分析）都在【独立守护进程】里（kaggle/bzm_daemon.py，
#        已内嵌本文件）。守护进程的输出只写日志文件 /tmp/bzm/logs，内核零后台线程、零并发 stdout 写入。
#     3) 单元只做三件事：启动守护进程 → 等网址 → 打印一次 → 静默 sleep 保活（不输出）。网址变化才再打印一行（最多 8 次）。
#     4) 构建物与 node_modules 全部在 /tmp/bzm；原始 CSI 在 /kaggle/temp 或 /tmp（有 400MB 上限）；不碰 /kaggle/working。
#     5) 守护进程自带监督：隧道进程挂了自动重建（cloudflared ⇄ localhost.run 轮换），并每 8 秒用公网网址回访自检；
#        单元在守护进程意外退出时自动拉起（最多 5 次）。
#     6) 修复一个真实 bug：旧正则会把 cloudflared 日志里的 api.trycloudflare.com 当成站点网址，现已排除。
#
#  可选环境变量（在本单元最前面用 os.environ[...] = ... 设置即可）：
#     REPO_URL / REPO_BRANCH / MQTT_ROOT / SITE_PORT / RAW_LIMIT_MB / COPY_STANDALONE=1（把单文件模拟器复制到 /kaggle/working）
#  停止后台服务：新开一个单元执行  !pkill -f bzm_daemon.py
#  查看日志：     !tail -n 40 /tmp/bzm/logs/daemon.log
#
#  维护说明：下面 DAEMON_SRC 是 kaggle/bzm_daemon.py 的内嵌副本。改了 bzm_daemon.py 之后运行
#            python tools/make_kaggle_cell.py   即可重新生成；python tools/make_kaggle_cell.py --check 可检查是否同步。
# =============================================================================
import os, sys, json, time, signal, shutil, subprocess

CELL_VERSION = "v7.0"
REPO_URL = os.environ.get("REPO_URL", "https://github.com/bizuming1-ui/yuyinkelong.git")
BRANCH = os.environ.get("REPO_BRANCH", "main")
MQTT_ROOT = os.environ.get("MQTT_ROOT", "bzm-csi/tri-5d2e8a1c")  # 必须与固件 config.h 的 MQTT_ROOT 一致
ON_KAGGLE = os.path.isdir("/kaggle")
BASE = "/tmp/bzm" if ON_KAGGLE else os.path.abspath(os.environ.get("BZM_BASE", "./work"))
RAW_PARENT = "/kaggle/temp" if os.path.isdir("/kaggle/temp") else BASE
STATE_PATH = os.path.join(BASE, "state.json")
DAEMON_PATH = os.path.join(BASE, "bzm_daemon.py")
CFG_PATH = os.path.join(BASE, "config.json")
LOG_PATH = os.path.join(BASE, "logs", "daemon.log")
MAX_RUN = int(os.environ.get("MAX_RUN_SECONDS", "0"))  # 0 = 一直运行；>0 仅用于自检

# <<<DAEMON_BEGIN>>>
DAEMON_SRC = r'''
# -*- coding: utf-8 -*-
# bzm_daemon —— 三 ESP32-S3 WiFi CSI 2.5D 感知系统 · Kaggle 后台守护进程（由 kaggle_cell.py 自动写出并启动）
# 设计原则：本进程"完全脱离 Jupyter 内核"，所有输出只写日志文件，绝不向 Notebook 输出框写任何内容。
# 注意：kaggle_cell.py 里内嵌了本文件的完整副本；修改本文件后运行 `python tools/make_kaggle_cell.py` 重新生成。
import os, sys, re, json, time, glob, shutil, struct, signal, threading, subprocess, tarfile, urllib.request, uuid, gzip, logging
from logging.handlers import RotatingFileHandler
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CFG = json.load(open(sys.argv[1], "r", encoding="utf-8"))
BASE = CFG["base"]
VERSION = CFG["version"]
SRC = os.path.join(BASE, "yuyinkelong")
LOGDIR = os.path.join(BASE, "logs")
STATE_PATH = os.path.join(BASE, "state.json")
RAW_DIR = os.path.join(CFG["raw_parent"], "csi_raw")
RAW_LIMIT = int(CFG["raw_limit_mb"]) * 1024 * 1024
MQTT_ROOT = CFG["mqtt_root"]
RUN_ID = uuid.uuid4().hex[:8]
STOP = threading.Event()
LOCK = threading.Lock()
T0 = time.time()
os.makedirs(LOGDIR, exist_ok=True)

_h = RotatingFileHandler(os.path.join(LOGDIR, "daemon.log"), maxBytes=1_000_000, backupCount=2, encoding="utf-8")
_h.setFormatter(logging.Formatter("%(asctime)s %(message)s", "%H:%M:%S"))
log = logging.getLogger("bzm")
log.setLevel(logging.INFO)
log.addHandler(_h)

STATE = {
    "version": VERSION, "pid": os.getpid(), "stage": "init", "msg": "启动中", "error": "",
    "url": "", "url_ok": False, "provider": "", "local_url": "", "port": 0,
    "gpu": {"n": 0, "names": [], "analysis": "等待 CSI 数据"},
    "devices": "等待设备数据", "stats": {"msgs": 0, "bytes": 0, "dups": 0, "reconnects": 0, "mqtt_on": 0, "mqtt_total": 0},
    "site_kb": 0, "built": False, "tunnel_restarts": 0, "ts": time.time(), "t0": T0,
}


def set_state(**kw):
    with LOCK:
        STATE.update(kw)


def save_state():
    with LOCK:
        STATE["ts"] = time.time()
        data = json.dumps(STATE, ensure_ascii=False)
    tmp = STATE_PATH + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(data)
        os.replace(tmp, STATE_PATH)
    except Exception as e:
        log.info("save_state 失败: %r", e)


def stage(name, msg):
    log.info("[%s] %s", name, msg)
    set_state(stage=name, msg=msg)
    save_state()


def run(cmd, cwd=None, env=None, timeout=900, name="cmd"):
    """子进程输出只写文件，不占内存，不回显。返回码。"""
    lp = os.path.join(LOGDIR, name + ".log")
    log.info("$ %s", cmd if isinstance(cmd, str) else " ".join(cmd))
    try:
        with open(lp, "ab") as f:
            r = subprocess.run(cmd, shell=isinstance(cmd, str), cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=f, stderr=subprocess.STDOUT, timeout=timeout, close_fds=True)
        return r.returncode
    except subprocess.TimeoutExpired:
        log.info("命令超时: %s", cmd)
        return 124
    except Exception as e:
        log.info("命令异常: %r", e)
        return 1


def out(cmd, timeout=20):
    try:
        r = subprocess.run(cmd, shell=isinstance(cmd, str), stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout, close_fds=True)
        return r.returncode, (r.stdout or "").strip()
    except Exception:
        return 1, ""


# ------------------------------------------------------------------ 1) GPU（只用 nvidia-smi，不在本进程初始化 CUDA）
def gpu_detect():
    rc, txt = out(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"], 15)
    names = [x.strip() for x in txt.splitlines() if x.strip()] if rc == 0 else []
    with LOCK:
        STATE["gpu"]["n"] = len(names)
        STATE["gpu"]["names"] = names
    log.info("GPU: %s", names)


# ------------------------------------------------------------------ 2) 源码与构建
def ensure_node():
    rc, v = out("node -v", 10)
    if rc == 0 and v.startswith("v"):
        try:
            if int(v[1:].split(".")[0]) >= 18:
                return True
        except Exception:
            pass
    ver = "v20.18.0"
    dst = os.path.join(BASE, "node.tar.xz")
    try:
        urllib.request.urlretrieve("https://nodejs.org/dist/%s/node-%s-linux-x64.tar.xz" % (ver, ver), dst)
        with tarfile.open(dst) as t:
            t.extractall(BASE)
        os.environ["PATH"] = os.path.join(BASE, "node-%s-linux-x64" % ver, "bin") + ":" + os.environ["PATH"]
        return True
    except Exception as e:
        log.info("安装 Node 失败: %r", e)
        return False


def fetch_source():
    if CFG["local_src"]:
        if os.path.exists(SRC):
            shutil.rmtree(SRC, ignore_errors=True)
        shutil.copytree(CFG["local_src"], SRC, ignore=shutil.ignore_patterns("node_modules", ".git", "dist", ".pio", "work", ".next"))
        return True
    for attempt in range(3):
        if os.path.isdir(os.path.join(SRC, ".git")):
            rc1 = run(["git", "fetch", "--depth", "1", "origin", CFG["branch"]], cwd=SRC, timeout=180, name="git")
            rc2 = run(["git", "reset", "--hard", "origin/" + CFG["branch"]], cwd=SRC, timeout=60, name="git") if rc1 == 0 else 1
            if rc2 == 0:
                return True
            shutil.rmtree(SRC, ignore_errors=True)
        rc = run(["git", "clone", "--depth", "1", "-b", CFG["branch"], CFG["repo"], SRC], timeout=240, name="git")
        if rc == 0:
            return True
        time.sleep(3 * (attempt + 1))
    return False


def build_site():
    stage("source", "获取 GitHub 源码")
    ok = fetch_source()
    cand = None
    if ok:
        stage("build", "npm install + npm run build（约 1~3 分钟）")
        if ensure_node():
            env = dict(os.environ, NODE_OPTIONS="--max-old-space-size=2048", CI="1", NO_COLOR="1", npm_config_cache=os.path.join(BASE, "npm-cache"), npm_config_update_notifier="false")
            rc = 1
            for attempt in range(2):
                rc = run("npm install --no-audit --no-fund --loglevel=error --prefer-offline", cwd=SRC, env=env, timeout=900, name="npm")
                if rc == 0:
                    rc = run("npm run build", cwd=SRC, env=env, timeout=600, name="npm")
                if rc == 0:
                    break
                shutil.rmtree(os.path.join(SRC, "node_modules"), ignore_errors=True)
            if rc == 0 and os.path.exists(os.path.join(SRC, "dist", "index.html")):
                cand = os.path.join(SRC, "dist", "index.html")
                set_state(built=True)
    if cand is None:
        for alt in ("docs/index.html", "dist/index.html"):
            p = os.path.join(SRC, alt)
            if os.path.exists(p) and os.path.getsize(p) > 100_000:
                cand = p
                log.info("使用预构建产物 %s", alt)
                break
    if cand is None:
        # 最后兜底：GitHub Actions 发布到 GitHub Pages 的预构建单文件（.github/workflows/pages.yml）
        try:
            dst = os.path.join(BASE, "pages_fallback.html")
            req = urllib.request.Request(CFG.get("pages_url", "https://bizuming1-ui.github.io/yuyinkelong/"), headers={"User-Agent": "bzm-daemon"})
            with urllib.request.urlopen(req, timeout=30) as r:
                body = r.read()
            if len(body) > 100_000 and b"<html" in body[:2000].lower():
                with open(dst, "wb") as f:
                    f.write(body)
                cand = dst
                log.info("使用 GitHub Pages 预构建页面作为兜底（%d KB）", len(body) // 1024)
        except Exception as e:
            log.info("GitHub Pages 兜底失败: %r", e)
    if cand is None:
        set_state(error="构建失败，且 docs/index.html 与 GitHub Pages 兜底都不可用。日志目录：" + LOGDIR)
        return None
    set_state(site_kb=int(os.path.getsize(cand) / 1024))
    return cand


# ------------------------------------------------------------------ 3) HTTP 托管（只暴露白名单路径，自带 gzip）
PAGE = {"path": "", "mtime": 0.0, "raw": b"", "gz": b""}
PAGE_PATHS = ("/", "/index.html", "/standalone-simulator.html", "/simulator_standalone.html")


def load_page():
    try:
        mt = os.path.getmtime(PAGE["path"])
        if mt != PAGE["mtime"]:
            with open(PAGE["path"], "rb") as f:
                raw = f.read()
            PAGE.update(mtime=mt, raw=raw, gz=gzip.compress(raw, 6))
    except Exception as e:
        log.info("load_page 失败: %r", e)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "bzm"

    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype, head, extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if not head:
            self.wfile.write(body)

    def _serve(self, head):
        try:
            p = self.path.split("?")[0].split("#")[0]
            if p in PAGE_PATHS:
                load_page()
                if "gzip" in (self.headers.get("Accept-Encoding") or ""):
                    self._send(200, PAGE["gz"], "text/html; charset=utf-8", head, {"Content-Encoding": "gzip", "Vary": "Accept-Encoding"})
                else:
                    self._send(200, PAGE["raw"], "text/html; charset=utf-8", head)
            elif p in ("/api/health", "/api/ping"):
                with LOCK:
                    j = {k: STATE[k] for k in ("version", "stage", "url", "gpu", "devices", "stats", "site_kb") if k in STATE}
                j["ok"] = True
                j["uptime"] = int(time.time() - T0)
                j["ts"] = time.time()
                self._send(200, json.dumps(j, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8", head)
            elif p == "/favicon.ico":
                self._send(204, b"", "image/x-icon", head)
            else:
                self._send(404, b"not found", "text/plain; charset=utf-8", head)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            log.info("http 异常: %r", e)

    def do_GET(self):
        self._serve(False)

    def do_HEAD(self):
        self._serve(True)

    def do_OPTIONS(self):
        self._send(204, b"", "text/plain", False, {"Access-Control-Allow-Methods": "GET, HEAD, OPTIONS", "Access-Control-Allow-Headers": "*"})


class Srv(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True
    request_queue_size = 64


def serve():
    srv = None
    for p in range(int(CFG["port"]), int(CFG["port"]) + 30):
        try:
            srv = Srv(("0.0.0.0", p), Handler)
            break
        except OSError:
            continue
    if srv is None:
        srv = Srv(("0.0.0.0", 0), Handler)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True, name="http").start()
    set_state(port=port, local_url="http://127.0.0.1:%d" % port)
    log.info("HTTP 托管启动 :%d", port)
    return port


# ------------------------------------------------------------------ 4) 公网隧道（cloudflared ⇄ localhost.run 轮换，监视 + 自动重建）
def get_cloudflared():
    exe = os.path.join(BASE, "cloudflared")
    if os.path.exists(exe) and os.path.getsize(exe) > 5_000_000:
        return exe
    for attempt in range(3):
        try:
            urllib.request.urlretrieve("https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64", exe + ".part")
            os.replace(exe + ".part", exe)
            os.chmod(exe, 0o755)
            return exe
        except Exception as e:
            log.info("下载 cloudflared 失败: %r", e)
            time.sleep(2 * (attempt + 1))
    return None


class Tunnel:
    PROVIDERS = ("cloudflared", "localhost.run")

    def __init__(self, port):
        self.port = port
        self.proc = None
        self.url = ""
        self.kind = ""
        self.fails = 0
        self.born = 0.0
        self.pidx = 0
        self.verify_fail = 0

    def _reader(self, proc, pat):
        try:
            for line in iter(proc.stdout.readline, ""):
                if STOP.is_set() or proc is not self.proc:
                    break
                log.info("[tunnel] %s", line.rstrip()[:300])
                if not self.url:
                    m = re.search(pat, line)
                    if m:
                        self.url = m.group(0)
                        set_state(url=self.url, url_ok=False, provider=self.kind)
                        save_state()
        except Exception:
            pass

    def stop(self):
        p, self.proc = self.proc, None
        if p is not None:
            try:
                p.terminate()
                p.wait(timeout=4)
            except Exception:
                try:
                    p.kill()
                except Exception:
                    pass

    def start(self):
        self.stop()
        self.url = ""
        set_state(url="", url_ok=False)
        self.verify_fail = 0
        self.born = time.time()
        k = self.pidx % len(self.PROVIDERS)
        order = self.PROVIDERS[k:] + self.PROVIDERS[:k]
        for kind in order:
            try:
                if kind == "cloudflared":
                    exe = get_cloudflared()
                    if not exe:
                        raise RuntimeError("no cloudflared")
                    cmd = [exe, "tunnel", "--url", "http://127.0.0.1:%d" % self.port, "--no-autoupdate", "--protocol", "http2"]
                    # 排除 api.trycloudflare.com（失败日志里会出现，它不是站点网址）
                    pat = r"https://(?!api\.)[-a-z0-9]+\.trycloudflare\.com"
                elif shutil.which("ssh"):
                    cmd = ["ssh", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "ServerAliveInterval=20", "-o", "ExitOnForwardFailure=yes", "-T", "-R", "80:127.0.0.1:%d" % self.port, "nokey@localhost.run"]
                    pat = r"https://[-a-z0-9]+\.lhr\.life"
                else:
                    continue
                self.kind = kind
                self.proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, close_fds=True, start_new_session=True)
                threading.Thread(target=self._reader, args=(self.proc, pat), daemon=True, name="tun-reader").start()
                log.info("隧道启动: %s", kind)
                return
            except Exception as e:
                log.info("隧道 %s 启动失败: %r", kind, e)

    def alive(self):
        return self.proc is not None and self.proc.poll() is None

    def verify(self):
        """通过公网地址访问自己的 /api/ping，确认隧道真的通了。"""
        if not self.url:
            return False
        try:
            req = urllib.request.Request(self.url + "/api/ping", headers={"User-Agent": "bzm-check"})
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status == 200
        except Exception:
            return False

    def tick(self):
        """监督循环每 ~8 秒调用一次。"""
        if not self.alive():
            self.fails += 1
            if self.fails % 2 == 0:
                self.pidx += 1
            set_state(tunnel_restarts=STATE["tunnel_restarts"] + 1)
            log.info("隧道进程已退出，重建（第 %d 次）", self.fails)
            STOP.wait(min(30, 2 * self.fails))
            self.start()
            return
        if not self.url:
            if time.time() - self.born > 90:
                log.info("90 秒内未拿到隧道网址，切换服务商重试")
                self.pidx += 1
                self.start()
            return
        if self.verify():
            self.verify_fail = 0
            self.fails = 0
            if not STATE["url_ok"]:
                set_state(url_ok=True)
        else:
            self.verify_fail += 1
            if not STATE["url_ok"] and time.time() - self.born > 60:
                set_state(url_ok=True)  # 本机回访失败不一定代表外部不可达（出站 DNS 差异），60 秒后放行显示
            if self.verify_fail >= 4 and STATE["url_ok"]:
                log.info("公网回访连续失败 %d 次，重建隧道", self.verify_fail)
                self.pidx += 1
                self.start()


# ------------------------------------------------------------------ 5) MQTT 采集器（回调零打印，仅落盘）
class Collector:
    def __init__(self):
        os.makedirs(RAW_DIR, exist_ok=True)
        self.lock = threading.Lock()
        self.files = {}
        self.stats = {"msgs": 0, "bytes": 0, "dups": 0, "reconnects": 0, "status": {}, "last": {}}
        self.seen = set()
        self.seen_q = []
        self.clients = []
        self.connected = set()

    def _open(self, node):
        d = os.path.join(RAW_DIR, "n%d" % node)
        os.makedirs(d, exist_ok=True)
        path = os.path.join(d, time.strftime("%Y%m%d_%H%M%S") + ".bin")
        self.files[node] = [open(path, "ab"), time.time(), 0]
        return self.files[node]

    def _write(self, node, payload):
        rec = self.files.get(node) or self._open(node)
        rec[0].write(struct.pack("<QI", int(time.time() * 1e6), len(payload)) + payload)
        rec[2] += len(payload)
        if rec[2] > 32 * 2**20 or time.time() - rec[1] > 600:
            rec[0].close()
            self._open(node)
            self._cap()

    def _cap(self):
        fs = sorted(glob.glob(os.path.join(RAW_DIR, "n*", "*.bin")), key=os.path.getmtime)
        total = sum(os.path.getsize(p) for p in fs if os.path.exists(p))
        while total > RAW_LIMIT and len(fs) > 2:
            p = fs.pop(0)
            try:
                total -= os.path.getsize(p)
                os.remove(p)
            except Exception:
                pass

    def on_message(self, topic, payload):
        try:
            t = topic[len(MQTT_ROOT) + 1:]
            with self.lock:
                if t.endswith("/csi") and len(payload) >= 8 and payload[0] == 0xC5 and payload[1] == 3:
                    key = bytes(payload[:8]) + bytes(payload[8:20])
                    if key in self.seen:
                        self.stats["dups"] += 1
                        return
                    self.seen.add(key)
                    self.seen_q.append(key)
                    if len(self.seen_q) > 800:
                        self.seen.discard(self.seen_q.pop(0))
                    node = payload[2]
                    self._write(node, bytes(payload))
                    self.stats["msgs"] += 1
                    self.stats["bytes"] += len(payload)
                    self.stats["last"][node] = time.time()
                elif t.endswith("/status"):
                    j = json.loads(payload.decode("utf-8", errors="ignore"))
                    self.stats["status"][j.get("id")] = j
        except Exception:
            pass

    def start(self):
        try:
            import paho.mqtt.client as mqtt
        except ImportError:
            for extra in ([], ["--break-system-packages"], ["--user", "--break-system-packages"]):
                if run([sys.executable, "-m", "pip", "install", "-q", "paho-mqtt"] + extra, timeout=240, name="pip") == 0:
                    break
            try:
                import importlib, site
                importlib.invalidate_caches()
                for sp in site.getsitepackages() + [site.getusersitepackages()]:
                    if sp not in sys.path:
                        sys.path.append(sp)
                import paho.mqtt.client as mqtt
            except ImportError:
                log.info("paho-mqtt 不可用，跳过采集（网页托管不受影响）")
                return
        v2 = hasattr(mqtt, "CallbackAPIVersion")
        targets = [("tcp", "broker.hivemq.com", 1883, None), ("tcp", "broker.emqx.io", 1883, None), ("tcp", "test.mosquitto.org", 1883, None), ("ws", "broker.hivemq.com", 8884, "/mqtt")]
        for i, (kind, host, port, path) in enumerate(targets):
            cid = "bzm-kaggle-%s-%d" % (RUN_ID, i)
            tr = "websockets" if kind == "ws" else "tcp"
            c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=cid, transport=tr) if v2 else mqtt.Client(client_id=cid, transport=tr)
            if kind == "ws":
                c.tls_set()
                c.ws_set_options(path=path)
            key = "%s:%d" % (host, port)

            def on_connect(cl, ud, *a, _k=key):
                cl.subscribe([(MQTT_ROOT + "/+/csi", 0), (MQTT_ROOT + "/+/status", 0)])
                with self.lock:
                    self.connected.add(_k)

            def on_disconnect(cl, ud, *a, _k=key):
                with self.lock:
                    self.stats["reconnects"] += 1
                    self.connected.discard(_k)

            c.on_connect = on_connect
            c.on_disconnect = on_disconnect
            c.on_message = lambda cl, ud, m: self.on_message(m.topic, m.payload)
            c.reconnect_delay_set(1, 10)
            try:
                c.connect_async(host, port, keepalive=20)
                c.loop_start()
                self.clients.append(c)
            except Exception:
                pass

    def summary(self):
        now = time.time()
        with self.lock:
            s = self.stats
            parts = []
            for nid, name in ((1, "ESP32-1(A)"), (2, "ESP32-B"), (3, "ESP32-C")):
                st = s["status"].get(nid)
                seen = s["last"].get(nid)
                if nid == 1:
                    parts.append("%s: %s" % (name, ("在线 发射=%s" % st.get("nowTx")) if st and st.get("online") else "待机/未收到"))
                else:
                    parts.append("%s: %s" % (name, ("%.0fs前" % (now - seen)) if seen else "等待CSI"))
            return " | ".join(parts), dict(msgs=s["msgs"], bytes=s["bytes"], dups=s["dups"], reconnects=s["reconnects"], mqtt_on=len(self.connected), mqtt_total=len(self.clients))


# ------------------------------------------------------------------ 6) GPU 离线分析（独立子进程，失败不影响任何其他部分）
GPU_WORKER = """
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
    t = threading.Thread(target=work, args=(node, i)); t.start(); ths.append(t)
for t in ths: t.join()
o = []
for node, v in sorted(res.items()):
    o.append("ESP32-%s@%s: %d包 turb=%.4f+-%.4f STFT=%.2f" % ("BC"[node - 2], v[4], v[0], v[1], v[2], v[3]))
print("RESULT:" + (" | ".join(o) if o else "等待足够 CSI 数据"))
"""


def gpu_analyze():
    wp = os.path.join(BASE, "gpu_worker.py")
    with open(wp, "w", encoding="utf-8") as f:
        f.write(GPU_WORKER)
    try:
        r = subprocess.run([sys.executable, wp, RAW_DIR, str(STATE["gpu"]["n"])], stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=100, close_fds=True, start_new_session=True)
        for line in r.stdout.splitlines():
            if line.startswith("RESULT:"):
                return line[7:]
        return "等待 CSI 数据积累"
    except subprocess.TimeoutExpired:
        return "分析超时已跳过"
    except Exception as e:
        return "分析跳过: %r" % e


def set_gpu_text(text):
    with LOCK:
        STATE["gpu"]["analysis"] = text


# ------------------------------------------------------------------ 主流程
def main():
    signal.signal(signal.SIGTERM, lambda *a: STOP.set())
    signal.signal(signal.SIGINT, lambda *a: STOP.set())
    stage("gpu", "检测 GPU")
    try:
        gpu_detect()
    except Exception as e:
        log.info("gpu_detect: %r", e)
    page = build_site()
    if page is None:
        stage("error", STATE["error"])
        STOP.wait(5)
        return 2
    PAGE["path"] = page
    load_page()
    try:
        shutil.copyfile(page, os.path.join(BASE, "simulator_standalone.html"))
    except Exception:
        pass
    stage("serve", "启动 HTTP 托管")
    port = serve()
    stage("tunnel", "建立公网隧道")
    tun = None
    if CFG["skip_tunnel"]:
        set_state(url="http://127.0.0.1:%d" % port, url_ok=True, provider="local")
    else:
        tun = Tunnel(port)
        tun.start()
    col = Collector()
    try:
        col.start()
    except Exception as e:
        log.info("采集器启动异常: %r", e)
    stage("run", "运行中")
    last_gpu = 0.0
    last_tick = 0.0
    gpu_thread = None
    while not STOP.is_set():
        now = time.time()
        try:
            dev, st = col.summary()
            set_state(devices=dev, stats=st)
            if tun is not None and now - last_tick >= 8:
                last_tick = now
                tun.tick()
            if now - last_gpu > 120 and (gpu_thread is None or not gpu_thread.is_alive()):
                last_gpu = now
                gpu_thread = threading.Thread(target=lambda: set_gpu_text(gpu_analyze()), daemon=True, name="gpu")
                gpu_thread.start()
            if CFG["max_run"] and now - T0 >= CFG["max_run"]:
                break
        except Exception as e:
            log.info("监督循环异常(已忽略): %r", e)
        save_state()
        STOP.wait(2)
    if tun is not None:
        tun.stop()
    for c in col.clients:
        try:
            c.loop_stop()
        except Exception:
            pass
    set_state(stage="stopped", msg="已停止")
    save_state()
    return 0


if __name__ == "__main__":
    try:
        code = main()
    except Exception as e:
        log.exception("守护进程致命异常: %r", e)
        set_state(stage="error", error=repr(e))
        save_state()
        code = 1
    sys.exit(code)
'''
# <<<DAEMON_END>>>


def read_state():
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def state_fresh(st, max_age=30):
    return bool(st) and (time.time() - st.get("ts", 0)) < max_age and st.get("stage") not in ("stopped", "error")


def stop_old(st):
    """关闭旧守护进程（含它启动的隧道），保证重跑单元永远不会端口冲突/僵尸残留。"""
    try:
        if st and st.get("pid"):
            os.kill(int(st["pid"]), signal.SIGTERM)
            for _ in range(20):
                time.sleep(0.25)
                try:
                    os.kill(int(st["pid"]), 0)
                except OSError:
                    break
            else:
                os.kill(int(st["pid"]), signal.SIGKILL)
    except Exception:
        pass
    for pat in ("cloudflared tunnel --url", "nokey@localhost.run"):
        try:
            subprocess.run(["pkill", "-f", pat], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
        except Exception:
            pass


def start_daemon():
    os.makedirs(os.path.join(BASE, "logs"), exist_ok=True)
    with open(DAEMON_PATH, "w", encoding="utf-8") as f:
        f.write(DAEMON_SRC.lstrip("\n"))
    cfg = {
        "base": BASE, "raw_parent": RAW_PARENT, "version": CELL_VERSION, "repo": REPO_URL, "branch": BRANCH,
        "mqtt_root": MQTT_ROOT, "local_src": os.environ.get("LOCAL_SRC", ""), "port": int(os.environ.get("SITE_PORT", "8000")),
        "skip_tunnel": os.environ.get("SKIP_TUNNEL") == "1", "max_run": MAX_RUN, "raw_limit_mb": int(os.environ.get("RAW_LIMIT_MB", "400")),
    }
    with open(CFG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f)
    # 删除旧状态，防止把上一次的 url 当成这一次的
    try:
        os.remove(STATE_PATH)
    except OSError:
        pass
    logf = open(os.path.join(BASE, "logs", "stdout.log"), "ab")
    proc = subprocess.Popen(
        [sys.executable, DAEMON_PATH, CFG_PATH],
        stdin=subprocess.DEVNULL, stdout=logf, stderr=subprocess.STDOUT,
        close_fds=True, start_new_session=True, cwd=BASE,
    )
    logf.close()
    return proc


def tail(path, n=12):
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            return "".join(f.readlines()[-n:]).rstrip()
    except Exception:
        return "（无日志）"


STAGE_TEXT = {
    "init": "启动守护进程", "gpu": "检测 GPU", "source": "获取 GitHub 源码", "build": "构建 2.5D 浏览器模拟器（npm，约 1~3 分钟）",
    "serve": "启动 HTTP 托管", "tunnel": "建立公网隧道（5~20 秒）", "run": "服务运行中",
}


def wait_for_url(timeout=900):
    """等守护进程拿到可用网址。仅在阶段变化时打印一行。返回 (state|None, 原因)。"""
    last = None
    t_end = time.time() + timeout
    while time.time() < t_end:
        st = read_state()
        if st:
            sg = st.get("stage")
            if sg != last and sg in STAGE_TEXT:
                print("  · " + STAGE_TEXT[sg], flush=True)
            last = sg
            if sg == "error":
                return st, "error"
            if st.get("url") and st.get("url_ok"):
                return st, "ok"
        time.sleep(2)
    return read_state(), "timeout"


def banner(st):
    gpu = st.get("gpu", {}).get("names") or []
    print("", flush=True)
    print("=" * 66, flush=True)
    print("  浏览器模拟器网址（点击或复制到浏览器打开）：", flush=True)
    print("  " + st["url"], flush=True)
    print("=" * 66, flush=True)
    print("  GPU: %s | 页面 %s KB | 隧道: %s" % (", ".join(gpu) or "无/CPU", st.get("site_kb", "?"), st.get("provider", "?")), flush=True)
    print("  之后本单元保持静默（不再刷屏，这是防止 Kaggle 前端崩溃的关键）。", flush=True)
    print("  状态/日志： %s/api/health   或   !tail -n 40 %s" % (st["url"], LOG_PATH), flush=True)


def main():
    print("[bzm %s] 三 ESP32-S3 2.5D 感知系统 · Kaggle 启动" % CELL_VERSION, flush=True)
    if ON_KAGGLE:
        cleaned = 0
        for bad in ("yuyinkelong", "csi_raw", "node_modules", "work", "cloudflared"):
            p = os.path.join("/kaggle/working", bad)
            if os.path.exists(p):
                shutil.rmtree(p, ignore_errors=True) if os.path.isdir(p) else os.remove(p)
                cleaned += 1
        if cleaned:
            print("  · 已清理 /kaggle/working 里 %d 个旧版残留（减轻 Draft 同步压力）" % cleaned, flush=True)
    os.makedirs(BASE, exist_ok=True)

    st = read_state()
    proc = None
    if state_fresh(st) and st.get("version") == CELL_VERSION and st.get("url") and not os.environ.get("FORCE_RESTART"):
        print("  · 检测到守护进程已在运行，直接复用（不重复构建）", flush=True)
    else:
        if st:
            stop_old(st)
        proc = start_daemon()
    st, why = wait_for_url()
    if why == "error":
        print("\n✗ 构建失败：%s\n--- 日志末尾 ---\n%s" % (st.get("error"), tail(os.path.join(BASE, "logs", "npm.log"), 15)), flush=True)
        return
    if why == "timeout" or not st or not st.get("url"):
        print("\n✗ 15 分钟内未拿到网址。请确认 Settings → Internet 已打开。日志末尾：\n" + tail(LOG_PATH, 15), flush=True)
        return
    banner(st)
    if os.environ.get("COPY_STANDALONE") == "1" and ON_KAGGLE:
        try:
            shutil.copyfile(os.path.join(BASE, "simulator_standalone.html"), "/kaggle/working/simulator_standalone.html")
        except Exception:
            pass

    shown = {st["url"]}
    restarts = 0
    try:
        while True:
            time.sleep(15)  # ← 静默保活：不 print、不 display
            cur = read_state()
            if cur and cur.get("stage") == "stopped":
                print("服务已按设定停止。", flush=True)
                return
            if not state_fresh(cur):
                if restarts >= 5:
                    print("守护进程连续 5 次异常退出，已停止自动重启。日志：\n" + tail(LOG_PATH, 15), flush=True)
                    return
                restarts += 1
                print("守护进程意外退出，自动重启（第 %d 次）…" % restarts, flush=True)
                stop_old(cur)
                proc = start_daemon()
                cur, why = wait_for_url()
                if why != "ok":
                    continue
            if cur and cur.get("url") and cur.get("url_ok") and cur["url"] not in shown and len(shown) < 8:
                shown.add(cur["url"])
                print("★ 网址已更新（隧道重建）：" + cur["url"], flush=True)
            if proc is not None:
                proc.poll()  # 回收僵尸进程
    except KeyboardInterrupt:
        print("已中断本单元；后台服务仍在运行，要停止请执行：!pkill -f bzm_daemon.py", flush=True)


main()
