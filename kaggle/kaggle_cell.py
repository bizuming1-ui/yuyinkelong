# =============================================================================
#  Kaggle 单元 v8.0（粘贴到 Notebook 第一个代码单元直接 Run）· 三 ESP32-S3 WiFi CSI 2.5D 感知系统
#  Settings → Accelerator: None（CPU 即可，本单元不用 GPU） | Internet: On
#
#  ★ 针对 "Oops something went wrong · Draft Session Fatal · status code 44" 的根因修复（v8.0，换了思路）
#
#   v5/v6/v7 都崩，而且 v7 已经把输出换成纯文本、依然崩。真正的共同点不是"输出方式"，而是：
#   它们都在 Kaggle 里【拉起了公网隧道】（cloudflared / localhost.run），并让它长时间运行。
#   证据：你的截图里，网址 https://xxx.trycloudflare.com 已经打印出来（隧道已建立）之后才弹窗；
#         社区公开反馈：Kaggle 会封禁/终止除 ngrok 以外的隧道（cloudflared、localtunnel、SSH 隧道），
#         表现就是会话突然 Fatal，没有任何有用的报错。
#   所以 v8 不是"再优化一次隧道"，而是把【Kaggle 里的隧道、守护进程、npm 构建、GPU 初始化、MQTT 长连接】全部删掉：
#     1) 网站本体托管在 GitHub Pages（永久网址，不依赖 Kaggle、不依赖你的电脑）；
#        推送到 main 后由 .github/workflows/pages.yml 自动构建发布。
#     2) 三块 ESP32 → MQTT → 浏览器 的数据链路本来就不经过 Kaggle，所以 Kaggle 掉线不影响实时检测。
#     3) 本单元只做几秒钟的事：检测永久网址是否在线且是最新 → 打印网址 → 把单文件模拟器保存到
#        /kaggle/working/simulator.html（可在右侧 Output 下载，双击即可用）→ 检测你粘贴的单元是不是最新版 → 结束。
#        单元自己会"运行完并返回"，没有 while 循环、没有后台线程、没有常驻子进程、没有隧道。
#        若 GitHub Pages 还没开通（需要一次性设置），单元会自动从 GitHub 源码在本机构建出同一个单文件网页
#        （npm 构建只在构建期间运行，结束即退出；约 1~3 分钟，输出只有几行），同样保存到 simulator.html。
#     4) 如果你一定要 Kaggle 自己对外提供网址：把下面 ENABLE_NGROK 改成 True，并在 Kaggle
#        Add-ons → Secrets 里添加 NGROK_AUTHTOKEN（ngrok 是社区验证过在 Kaggle 可用的唯一隧道；默认关闭）。
#
#  停止 ngrok：新开一个单元执行  import pyngrok.ngrok as n; n.kill()
# =============================================================================
import os, sys, re, json, time, gzip, threading, subprocess, urllib.request
from email.utils import parsedate_to_datetime
from datetime import datetime, timezone

CELL_VERSION = "v8.0"
REPO = "bizuming1-ui/yuyinkelong"
BRANCH = "main"
PAGES_URL = "https://bizuming1-ui.github.io/yuyinkelong/"
MIRRORS = [  # Pages 不可用时的备用来源（需要仓库里有 docs/index.html，可选）
    "https://raw.githack.com/%s/%s/docs/index.html" % (REPO, BRANCH),
]
ENABLE_BUILD_FALLBACK = True  # Pages 不可用时，从 GitHub 源码在 Kaggle 本机构建单文件网页（构建完即退出，不留进程）
ENABLE_NGROK = False  # 默认关闭 = 零隧道 = 不会触发 Kaggle 的隧道封禁
SITE_PORT = 8765
OUT_DIR = "/kaggle/working" if os.path.isdir("/kaggle/working") else os.path.abspath("./work")
OUT_FILE = os.path.join(OUT_DIR, "simulator.html")
UA = {"User-Agent": "bzm-kaggle-cell/" + CELL_VERSION, "Cache-Control": "no-cache"}


def http_get(url, timeout=25, tries=3):
    """返回 (body, headers) 或 (None, 错误文字)。"""
    err = ""
    for i in range(tries):
        try:
            sep = "&" if "?" in url else "?"
            req = urllib.request.Request(url + sep + "t=%d" % int(time.time()), headers=UA)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read(), dict(r.headers)
        except Exception as e:  # noqa: BLE001
            err = "%s: %s" % (type(e).__name__, e)
            time.sleep(1.5 * (i + 1))
    return None, err


def looks_like_site(body):
    return bool(body) and len(body) > 100_000 and b"<html" in body[:4000].lower()


def get_site():
    """按顺序取单文件模拟器：GitHub Pages → 备用镜像。返回 (body, 来源, headers, 说明)。"""
    note = ""
    for url in [PAGES_URL] + MIRRORS:
        body, h = http_get(url)
        if looks_like_site(body):
            return body, url, h, note
        note += "  · %s 不可用（%s）\n" % (url, h if body is None else "内容不像模拟器页面（可能是 404 页）")
    return None, "", {}, note


def sh(cmd, log, cwd=None, env=None, timeout=900):
    """只写日志文件，不向输出框写任何东西。"""
    try:
        return subprocess.run(cmd, shell=True, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, timeout=timeout).returncode
    except subprocess.TimeoutExpired:
        return 124
    except Exception:  # noqa: BLE001
        return 1


def build_from_source():
    """Pages 不可用时的兜底：git clone → npm install → npm run build → 返回 dist/index.html 的字节。构建结束所有子进程都已退出。"""
    import shutil, tarfile
    base = "/tmp/bzm" if os.path.isdir("/kaggle") else os.path.abspath("./work/build")
    src = os.path.join(base, "src")
    os.makedirs(base, exist_ok=True)
    logp = os.path.join(base, "build.log")
    with open(logp, "ab") as log:
        node_bin = ""
        try:
            v = subprocess.run("node -v", shell=True, capture_output=True, text=True, timeout=10).stdout.strip()
            ok = v.startswith("v") and int(v[1:].split(".")[0]) >= 18
        except Exception:  # noqa: BLE001
            ok = False
        if not ok:
            print("  · 安装 Node 20（约 30 秒）…")
            ver = "v20.18.0"
            tgz = os.path.join(base, "node.tar.xz")
            try:
                urllib.request.urlretrieve("https://nodejs.org/dist/%s/node-%s-linux-x64.tar.xz" % (ver, ver), tgz)
                with tarfile.open(tgz) as t:
                    t.extractall(base)
                node_bin = os.path.join(base, "node-%s-linux-x64" % ver, "bin")
            except Exception as e:  # noqa: BLE001
                return None, "安装 Node 失败：%s" % e
        env = dict(os.environ, CI="1", NO_COLOR="1", NODE_OPTIONS="--max-old-space-size=2048", npm_config_cache=os.path.join(base, "npm-cache"), npm_config_update_notifier="false", npm_config_fund="false", npm_config_audit="false")
        if node_bin:
            env["PATH"] = node_bin + ":" + env["PATH"]
        shutil.rmtree(src, ignore_errors=True)
        print("  · 拉取 GitHub 源码…")
        if sh("git clone --depth 1 -b %s https://github.com/%s.git %s" % (BRANCH, REPO, src), log, timeout=240) != 0:
            return None, "git clone 失败（日志 %s）" % logp
        print("  · npm install + vite build（约 1~3 分钟，期间无输出是正常的）…")
        if sh("npm install --no-audit --no-fund --loglevel=error", log, cwd=src, env=env, timeout=900) != 0:
            return None, "npm install 失败（日志 %s）" % logp
        if sh("npm run build", log, cwd=src, env=env, timeout=600) != 0:
            return None, "npm run build 失败（日志 %s）" % logp
    out = os.path.join(src, "dist", "index.html")
    if not os.path.exists(out):
        return None, "没有生成 dist/index.html（日志 %s）" % logp
    with open(out, "rb") as f:
        return f.read(), ""


def latest_commit():
    body, h = http_get("https://api.github.com/repos/%s/commits/%s" % (REPO, BRANCH), timeout=20, tries=2)
    if body is None:
        return None
    try:
        j = json.loads(body.decode("utf-8"))
        when = datetime.fromisoformat(j["commit"]["committer"]["date"].replace("Z", "+00:00"))
        return {"sha": j["sha"][:7], "when": when, "msg": j["commit"]["message"].splitlines()[0][:60]}
    except Exception:  # noqa: BLE001
        return None


def remote_cell_version():
    body, _ = http_get("https://raw.githubusercontent.com/%s/%s/kaggle/kaggle_cell.py" % (REPO, BRANCH), timeout=20, tries=2)
    if body is None:
        return None
    m = re.search(rb'CELL_VERSION\s*=\s*"([^"]+)"', body)
    return m.group(1).decode() if m else None


def serve_with_ngrok(body):
    """可选：stdlib HTTP 服务（守护线程）+ ngrok。仅当 ENABLE_NGROK=True 且有 NGROK_AUTHTOKEN。"""
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    token = os.environ.get("NGROK_AUTHTOKEN", "")
    if not token:
        try:
            from kaggle_secrets import UserSecretsClient  # type: ignore
            token = UserSecretsClient().get_secret("NGROK_AUTHTOKEN")
        except Exception:  # noqa: BLE001
            token = ""
    if not token:
        return "未找到 NGROK_AUTHTOKEN（Kaggle → Add-ons → Secrets 添加后重新运行）"
    gz = gzip.compress(body, 6)

    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):  # 不向输出框写任何东西
            pass

        def do_GET(self):  # noqa: N802
            p = self.path.split("?")[0]
            if p in ("/", "/index.html"):
                use_gz = "gzip" in (self.headers.get("Accept-Encoding") or "")
                data = gz if use_gz else body
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                if use_gz:
                    self.send_header("Content-Encoding", "gzip")
                self.end_headers()
                self.wfile.write(data)
            elif p == "/api/health":
                data = b'{"ok":true}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            else:
                self.send_response(404)
                self.send_header("Content-Length", "0")
                self.end_headers()

    try:
        srv = ThreadingHTTPServer(("127.0.0.1", SITE_PORT), H)
    except OSError:
        return "端口 %d 已被占用（上次运行的服务还在）。直接复用即可，或换 SITE_PORT" % SITE_PORT
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        subprocess.run([sys.executable, "-m", "pip", "install", "-q", "pyngrok"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=240)
        from pyngrok import ngrok  # type: ignore

        ngrok.set_auth_token(token)
        return ngrok.connect(SITE_PORT, "http").public_url
    except Exception as e:  # noqa: BLE001
        return "ngrok 启动失败：%s" % e


def main():
    print("[bzm %s] 三 ESP32-S3 · WiFi CSI · 2.5D 感知系统（无隧道 / 无常驻进程）" % CELL_VERSION)
    body, src, h, note = get_site()
    pages_ok = body is not None
    if body is None and ENABLE_BUILD_FALLBACK:
        print("\n  GitHub Pages 暂不可用（见文末说明），改为从 GitHub 源码在本机构建同一个单文件网页：")
        body, err = build_from_source()
        if body is not None:
            src = "本机构建（来自 GitHub 源码）"
        else:
            note += "  · 本机构建失败：%s\n" % err
    commit = latest_commit()

    if not pages_ok:
        print("\n! 永久网址目前不可用：\n" + note.rstrip())
        print("  一次性设置：GitHub 仓库 Settings → Pages → Build and deployment → Source 选 “GitHub Actions”；")
        print("  然后到 Actions 页面确认 “Deploy simulator to GitHub Pages” 是绿色，永久网址就生效了：")
        print("  " + PAGES_URL)
    if body is None:
        print("\n✗ 没有拿到网页，也没有构建出来。请把上面的信息发给我。")
    else:
        print("\n" + "=" * 68)
        if pages_ok:
            print("  浏览器模拟器网址（点击或复制到浏览器打开）：")
            print("  " + src)
        else:
            print("  浏览器模拟器已生成（单文件）：" + OUT_FILE)
            print("  右侧 Output 面板下载 simulator.html，双击即可在浏览器打开。")
        print("=" * 68)
        print("  页面 %d KB · 来源：%s" % (len(body) // 1024, "GitHub Pages" if src == PAGES_URL else ("备用镜像" if pages_ok else src)))
        try:
            os.makedirs(OUT_DIR, exist_ok=True)
            with open(OUT_FILE, "wb") as f:
                f.write(body)
            print("  单文件离线版：%s（右侧 Output 面板可下载，下载后双击就能用）" % OUT_FILE)
        except Exception as e:  # noqa: BLE001
            print("  （保存离线版失败：%s）" % e)

    if commit:
        line = "  GitHub 最新提交：%s · %s · %s" % (commit["sha"], commit["when"].astimezone().strftime("%m-%d %H:%M"), commit["msg"])
        print(line)
        lm = (h or {}).get("Last-Modified") or (h or {}).get("last-modified")
        if lm and pages_ok and src == PAGES_URL:
            try:
                dep = parsedate_to_datetime(lm)
                lag = (commit["when"] - dep.astimezone(timezone.utc)).total_seconds()
                if lag > 600:
                    print("  ⚠ 网页部署时间比最新提交早 %d 分钟：Actions 可能还在构建，或构建失败了（去 GitHub → Actions 看一眼）" % (lag // 60))
                else:
                    print("  ✓ 网页已是最新提交的构建")
            except Exception:  # noqa: BLE001
                pass
    else:
        print("  （GitHub API 暂不可用，已跳过最新提交检测）")

    rv = remote_cell_version()
    if rv and rv != CELL_VERSION:
        print("  ⚠ GitHub 上的 kaggle_cell.py 是 %s，你粘贴的是 %s —— 请从「复制代码界面 → Kaggle」重新复制" % (rv, CELL_VERSION))
    elif rv:
        print("  ✓ 本单元就是 GitHub 上的最新版（%s）" % rv)

    if ENABLE_NGROK and body is not None:
        print("  正在启动可选的 ngrok 公网服务…")
        res = serve_with_ngrok(body)
        print("  ngrok：" + res)

    print("\n  说明：ESP32 的实时数据经 MQTT 直连你的浏览器，不经过 Kaggle；本单元已结束，没有任何后台进程。")


main()
