#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
==============================================================================
 ESP32-S3 双节点 WiFi CSI 全信道拼接雷达 —— Kaggle 单文件主机端 (v8)
==============================================================================
用法（Kaggle Notebook：Settings → Accelerator = GPU T4 x2，Internet = On）：
  1. 新建一个 Code Cell，把本文件【全部内容】粘贴进去，点运行。
  2. 约 20 秒后，输出框里会打印一个醒目的方框，里面是形如  https://xxxx.trycloudflare.com  的网址。
  3. 把这个网址复制出来，粘贴到网页「复制代码界面」顶部的「Kaggle 网址」输入框 → config.h 会自动带上它
     → 复制 config.h 到两个 PlatformIO 工程 → Upload 两块 ESP32 → 供电即可（不用接电脑）。
  4. 同一个网址也填进「浏览器模拟器」顶部的 Kaggle 输入框，即可看到实时 3D 画面和检测日志。

主机端做的事（ESP32 算不动的部分）：
  · 解析两个节点上传的原始 CSI（L-LTF 64 子载波）
  · 双向相位标定：H_AB 与 H_BA 互为共轭相位，Z=H_AB·conj(H_BA) 估出两端本振/采样偏移 θ(k)，两个方向校正后平均（避免乘积的交叉项鬼影）
  · 帧间相位对齐 → 相邻信道重叠子载波相位拼接（信道间隔 5MHz = 16 子载波，13 个信道 → 约 245 个频点 ≈ 76.6MHz）
  · IFFT（GPU0，8192 点零填充）得到距离-时间剖面；MUSIC 超分辨（GPU1）
  · 存在 / 运动 / 呼吸（Lomb–Scargle，支持不等间隔采样）
物理边界（务必知道）：2 个节点 = 1 条双基地链路，得到的是“路径长度（椭圆）”维度的一维剖面，
不是摄像头式的图像，也不能解算角度；合成带宽上限约 80MHz → 路径长度分辨率 c/B ≈ 3.9m（等效单站距离 R=L/2，分辨率 c/2B ≈ 2m）；MUSIC 超分辨可略好。
"""
import os, sys, time, json, re, math, struct, threading, subprocess, shutil, collections, traceback, platform, logging

def _ensure(pkg, mod=None):
    try:
        __import__(mod or pkg)
    except Exception:
        print(f"[setup] pip install {pkg} ...", flush=True)
        subprocess.call([sys.executable, "-m", "pip", "install", "-q", pkg])

_ensure("numpy"); _ensure("scipy"); _ensure("flask"); _ensure("requests")
import numpy as np
from flask import Flask, request, jsonify, Response
try:
    from scipy.signal import lombscargle
except Exception:  # pragma: no cover
    lombscargle = None

# ------------------------------- 配置（环境变量可覆盖） -------------------------------
API_KEY = os.environ.get("RADAR_KEY", "radar-key")             # 必须与 ESP32 config.h 的 API_KEY 一致
TOPIC = os.environ.get("RADAR_TOPIC", "wradar-bzm-5f2k9q7d")   # 自动发现网址的 ntfy 主题，与 config.h 的 RADAR_TOPIC 一致
PORT = int(os.environ.get("RADAR_PORT", "8000"))
NO_TUNNEL = os.environ.get("RADAR_NO_TUNNEL", "0") == "1"
BASELINE_M = float(os.environ.get("RADAR_BASELINE_M", "3.0"))  # 两块 ESP32 之间的距离（米），用来把最强径锚定到 LOS
NFFT = int(os.environ.get("RADAR_NFFT", "8192"))               # IFFT 点数（零填充倍数，GPU 上可开更大）
NSRC = int(os.environ.get("RADAR_NSRC", "6"))                  # MUSIC 假设的径数
R_MAX = 30.0                                                    # 显示的最大路径长度（米）
NPROF = 128                                                     # 剖面分辨点数
BREATH_CONF = float(os.environ.get('RADAR_BREATH_CONF', '6'))
BREATH_POW = float(os.environ.get('RADAR_BREATH_POW', '0.5'))
CAL_SWEEPS = 24                                                 # 校准用的静态扫描轮数
IS_KAGGLE = os.path.exists("/kaggle")
WORK = "/kaggle/working" if IS_KAGGLE else "/tmp"
RAW_DIR = os.environ.get("RADAR_RAW_DIR", os.path.join(WORK, "radar_raw"))
RAW_MAX_GB = float(os.environ.get("RADAR_RAW_MAX_GB", "20" if IS_KAGGLE else "0.5"))  # 原始 CSI 滚动落盘上限（Kaggle 磁盘最大 57.6GB）
RAW_ON = os.environ.get("RADAR_RAW", "1") == "1"

DF = 312500.0
C = 299792458.0
K = np.arange(-32, 32)
VALID = (np.abs(K) >= 1) & (np.abs(K) <= 26)
DT = 1.0 / (NFFT * DF)

HDR = struct.Struct("<2sBBHHII")
REC_DT = np.dtype([("dir", "u1"), ("ch", "u1"), ("seq", "u1"), ("rssi", "i1"), ("sweep", "<u2"), ("ts", "<u4"),
                   ("aux", "<u4"), ("len", "u1"), ("flags", "u1"), ("csi", "i1", (128,))])
assert REC_DT.itemsize == 144

T0 = time.time()


# =============================== 信号处理基础 ===============================
def csi_c(buf):
    """(m,128) int8 [imag,real]... -> (m,64) complex，按子载波 k=-32..31 排列"""
    b = buf.astype(np.float32)
    c = b[:, 1::2] + 1j * b[:, 0::2]
    return np.fft.fftshift(c, axes=1)


def fit_phase(Z, g, mask):
    """拟合 Z ≈ exp(j(a + b g))：b 用相邻子载波相位增量估计（无需解卷绕），a 用去斜率后的平均相位"""
    z = Z[mask]
    gg = g[mask]
    d = np.diff(gg) == 1
    inc = np.sum(z[1:][d] * np.conj(z[:-1][d])) if d.any() else 0j
    b = float(np.angle(inc)) if abs(inc) > 0 else 0.0
    a = float(np.angle(np.sum(z * np.exp(-1j * b * gg))))
    return a, b


def align_frames(X):
    """同一信道停留内的多帧：以最强帧为参考，去掉每帧随机的常数相位与线性相位(采样时间偏移)，功率归一后相干平均"""
    amp = np.abs(X[:, VALID]).sum(1)
    ref = X[int(np.argmax(amp))]
    rn = np.linalg.norm(ref[VALID]) + 1e-9
    out = np.empty_like(X)
    qs = []
    for i in range(X.shape[0]):
        Z = X[i] * np.conj(ref)
        a, b = fit_phase(Z, K, VALID)
        xi = X[i] * np.exp(-1j * (a + b * K))
        xi = xi * (rn / (np.linalg.norm(xi[VALID]) + 1e-9))
        out[i] = xi
        qs.append(abs(np.sum(xi[VALID] * np.conj(ref[VALID]))) / (np.linalg.norm(xi[VALID]) * rn + 1e-9))
    return out.mean(0), float(np.mean(qs))


def calibrate_pair(HAB, HBA):
    """双向相位标定：H_AB = h·e^{+jθ}，H_BA = h·e^{-jθ}（θ = 两端本振/采样偏移造成的随机相位，常数+线性）。
    Z = H_AB·conj(H_BA) = |h|²·e^{j2θ} → 拟合得 θ(k)，再把两个方向都校正回 h 并平均。
    相比直接取乘积 h²，这样【不会产生 τi+τj 的交叉项鬼影】，且信噪比多 3dB。"""
    out = np.empty_like(HAB)
    for i in range(HAB.shape[0]):
        ab = HAB[i] / (np.linalg.norm(HAB[i][VALID]) + 1e-9)
        ba = HBA[i] / (np.linalg.norm(HBA[i][VALID]) + 1e-9)
        a, b = fit_phase(ab * np.conj(ba), K, VALID)
        th = 0.5 * (a + b * K)
        out[i] = 0.5 * (ab * np.exp(-1j * th) + ba * np.exp(1j * th))
    return out


def stitch(resp, plan_max, align=True):
    """resp: {ch: complex(64)} -> (H[N], valid[N], g0)。全局网格 g = 16*(ch-1)+k（5MHz = 16 个子载波间隔）"""
    g0 = -26
    N = 16 * (plan_max - 1) + 53
    num = np.zeros(N, np.complex128)
    den = np.zeros(N)
    overlaps = []
    for ch in sorted(resp):
        P = resp[ch].astype(np.complex128).copy()
        gk = 16 * (ch - 1) + K
        idx = gk - g0
        sel = VALID & (idx >= 0) & (idx < N)
        gi = idx[sel]
        gs = gk[sel].astype(float)
        P_v = P[sel]
        ov = den[gi] > 0
        if align and ov.sum() >= 8:
            ref = num[gi][ov] / den[gi][ov]
            Z = P_v[ov] * np.conj(ref)
            a, b = fit_phase(Z, gs[ov], np.ones(int(ov.sum()), bool))
            P_v = P_v * np.exp(-1j * (a + b * gs))
            s = np.sum(np.abs(ref) * np.abs(P_v[ov])) / (np.sum(np.abs(P_v[ov]) ** 2) + 1e-12)
            P_v = P_v * float(np.clip(s, 0.2, 5.0))
            overlaps.append(int(ov.sum()))
        w = np.cos(np.pi / 2 * np.abs(K[sel]) / 27.0) ** 2 + 0.05
        np.add.at(num, gi, w * P_v)
        np.add.at(den, gi, w)
    valid = den > 0
    H = np.zeros(N, np.complex128)
    H[valid] = num[valid] / den[valid]
    return H, valid, g0, overlaps


def find_peaks(db, floor):
    pk = []
    for i in range(1, len(db) - 1):
        if db[i] >= db[i - 1] and db[i] > db[i + 1] and db[i] > floor:
            pk.append((float(db[i]), i))
    pk.sort(reverse=True)
    return [{"r": round((i + 0.5) * R_MAX / len(db), 2), "db": round(d, 1)} for d, i in pk[:6]]


# =============================== GPU / CPU 后端 ===============================
class Backend:
    def __init__(self):
        self.torch = None
        self.names = []
        self.err = ""
        if os.environ.get("RADAR_GPU", "1") != "0":
            try:
                import torch
                self.torch = torch
                if torch.cuda.is_available():
                    for i in range(torch.cuda.device_count()):
                        p = torch.cuda.get_device_properties(i)
                        self.names.append(f"cuda:{i} {p.name} {p.total_memory/2**30:.1f}GiB")
            except Exception as e:
                self.err = str(e)[:120]
        n = len(self.names)
        self.dev_cir = "cuda:0" if n >= 1 else "cpu"
        self.dev_music = "cuda:1" if n >= 2 else self.dev_cir
        self._steer = {}
        self.cir_ms = 0.0
        self.music_ms = 0.0
        try:  # 预热
            self.cir(np.ones((1, 245), np.complex64), -26, 8)
        except Exception as e:
            self.err = "warmup: " + str(e)[:100]
            self.torch = None
            self.dev_cir = self.dev_music = "cpu"

    def info(self):
        return {"torch": bool(self.torch), "cuda": len(self.names), "devices": self.names, "cir": self.dev_cir if self.torch else "numpy",
                "music": self.dev_music if self.torch else "numpy", "nfft": NFFT, "cir_ms": round(self.cir_ms, 2),
                "music_ms": round(self.music_ms, 2), "err": self.err}

    def cir(self, Hs, g0, nkeep):
        """Hs (m,N) complex -> (m,nkeep) complex CIR（Kaiser(β=2.5) 窗 + 零填充 IFFT）"""
        t = time.time()
        Hs = np.asarray(Hs)
        m, N = Hs.shape
        win = np.kaiser(N, 2.5).astype(np.float32)
        g = (np.arange(N) + g0) % NFFT
        if self.torch:
            T = self.torch
            X = T.zeros((m, NFFT), dtype=T.complex64, device=self.dev_cir)
            Hw = T.from_numpy((Hs * (win * (np.abs(Hs) > 0))[None, :]).astype(np.complex64)).to(self.dev_cir)
            X[:, T.from_numpy(g).to(self.dev_cir)] = Hw
            out = T.fft.ifft(X, dim=1)[:, :nkeep] * (NFFT / max(1.0, float(N) / 2))
            res = out.cpu().numpy()
        else:
            X = np.zeros((m, NFFT), np.complex64)
            X[:, g] = Hs * (win * (np.abs(Hs) > 0))[None, :]
            res = (np.fft.ifft(X, axis=1)[:, :nkeep] * (NFFT / max(1.0, float(N) / 2))).astype(np.complex64)
        self.cir_ms = 0.8 * self.cir_ms + 0.2 * (time.time() - t) * 1000
        return res

    def music(self, x, nsrc, ns):
        """x: 连续均匀频点上的响应 (M,) -> MUSIC 伪谱 (len(ns),)；ns 为 CIR 采样序号"""
        t = time.time()
        x = np.asarray(x, np.complex64)
        M = len(x)
        L = M // 2
        Kc = M - L + 1
        nsrc = int(min(nsrc, L - 2))
        key = (L, tuple(ns[:2]), len(ns))
        if key not in self._steer:
            i = np.arange(L)[:, None]
            tau = (np.asarray(ns, float) * DT)[None, :]
            self._steer[key] = np.exp(-1j * 2 * np.pi * DF * i * tau).astype(np.complex64)
        A = self._steer[key]
        idx = np.arange(L)[:, None] + np.arange(Kc)[None, :]
        X = (x / (np.abs(x).max() + 1e-9))[idx]
        if self.torch:
            T = self.torch
            d = self.dev_music
            Xt = T.from_numpy(X).to(d)
            R = Xt @ Xt.conj().T / Kc
            R = 0.5 * (R + T.flip(T.flip(R.conj(), 0), 1))
            R = R + 1e-4 * T.trace(R).real / L * T.eye(L, dtype=R.dtype, device=d)
            _, V = T.linalg.eigh(R)
            En = V[:, : L - nsrc]
            E = En.conj().T @ T.from_numpy(A).to(d)
            P = 1.0 / ((E.abs() ** 2).sum(0) + 1e-12)
            res = P.cpu().numpy()
        else:
            R = X @ X.conj().T / Kc
            R = 0.5 * (R + np.flipud(np.fliplr(R.conj())))
            R = R + 1e-4 * np.trace(R).real / L * np.eye(L)
            _, V = np.linalg.eigh(R)
            En = V[:, : L - nsrc]
            E = En.conj().T @ A
            res = 1.0 / ((np.abs(E) ** 2).sum(0) + 1e-12)
        self.music_ms = 0.8 * self.music_ms + 0.2 * (time.time() - t) * 1000
        return res


# =============================== 原始数据滚动落盘 ===============================
class RawLog:
    def __init__(self):
        self.ok = RAW_ON
        self.f = None
        self.n = 0
        self.bytes = 0
        if self.ok:
            try:
                os.makedirs(RAW_DIR, exist_ok=True)
            except Exception:
                self.ok = False

    def write(self, body):
        if not self.ok:
            return
        try:
            if self.f is None or self.f.tell() > 128 * 2**20:
                if self.f:
                    self.f.close()
                self.n += 1
                self.f = open(os.path.join(RAW_DIR, f"raw_{int(time.time())}_{self.n:04d}.bin"), "ab")
                self._trim()
            self.f.write(struct.pack("<dI", time.time(), len(body)) + body)
            self.bytes += len(body)
        except Exception:
            self.ok = False

    def _trim(self):
        files = sorted((os.path.join(RAW_DIR, x) for x in os.listdir(RAW_DIR) if x.startswith("raw_")), key=os.path.getmtime)
        tot = sum(os.path.getsize(x) for x in files)
        while files and tot > RAW_MAX_GB * 2**30:
            x = files.pop(0)
            tot -= os.path.getsize(x)
            os.remove(x)


# =============================== 核心：配对 / 拼接 / 感知 ===============================
class Node:
    def __init__(self, name):
        self.name = name
        self.last = 0.0
        self.uploads = 0
        self.recs = 0
        self.boot = None
        self.boots = 0
        self.info = {}
        self.uptime_ms = 0
        self.dropped = 0
        self.online = False
        self.wraps = 0
        self.last_ts = None

    def unwrap(self, ts):
        if self.last_ts is not None and ts + 2**31 < self.last_ts:
            self.wraps += 1
        self.last_ts = ts
        return (ts + self.wraps * 2**32) / 1e6


class Core:
    def __init__(self):
        self.lock = threading.RLock()
        self.be = Backend()
        self.raw = RawLog()
        self.nodes = {"A": Node("A"), "B": Node("B")}
        self.pending = {}
        self.events = collections.deque(maxlen=400)
        self.rows = collections.deque(maxlen=400)
        self.seq = 0
        self.public_url = ""
        self.plan = 13
        self.baseline_m = BASELINE_M
        self.errors = collections.Counter()
        self.last_error = ""
        self.client_logs = collections.deque(maxlen=20)
        self.reset_dsp()
        self.proc_times = collections.deque(maxlen=30)
        self.sweeps_done = 0
        self.sweeps_skipped = 0
        self.sync_hist = collections.deque(maxlen=30)
        self.last = {}
        self.ev("info", f"服务启动 · numpy {np.__version__} · GPU {len(self.be.names)} 块 · NFFT={NFFT}")
        threading.Thread(target=self._worker, daemon=True).start()

    # ---------- 日志 ----------
    def ev(self, level, msg):
        self.events.append({"t": time.time(), "lv": level, "msg": msg})

    def reset_dsp(self):
        self.ref = None
        self.ref_peak = 1e-9
        self.hist_t = collections.deque(maxlen=200)
        self.hist_cir = collections.deque(maxlen=200)
        self.hist_prof = collections.deque(maxlen=200)
        self.hist_D = collections.deque(maxlen=200)
        self.prevA = None
        self.cal_D = []
        self.base = None
        self.present_hist = collections.deque(maxlen=4)
        self.anchored = False

    def calibrate(self):
        with self.lock:
            self.reset_dsp()
            self.ev("info", "收到校准指令：清空参考与基线，请保持房间安静约 20 秒")

    # ---------- 接收 ----------
    def ingest(self, body, info_hdr, ip):
        if len(body) < HDR.size:
            self.errors["bad_len"] += 1
            self.last_error = f"body 太短 {len(body)}B"
            return False, "short"
        magic, ver, node, nrec, boot, up_ms, dropped = HDR.unpack_from(body, 0)
        if magic != b"RC" or ver != 1 or node > 1:
            self.errors["bad_magic"] += 1
            self.last_error = f"magic/版本不对 {magic!r} v{ver} node{node}"
            return False, "magic"
        if len(body) < HDR.size + nrec * 144:
            self.errors["bad_len"] += 1
            self.last_error = f"记录被截断 {len(body)}B < {HDR.size + nrec * 144}B"
            return False, "trunc"
        name = "AB"[node]
        recs = np.frombuffer(body, REC_DT, count=nrec, offset=HDR.size).copy() if nrec else np.zeros(0, REC_DT)
        info = {}
        for kv in (info_hdr or "").split(";"):
            if "=" in kv:
                a, b = kv.split("=", 1)
                info[a.strip()] = b.strip()
        with self.lock:
            nd = self.nodes[name]
            if nd.boot is not None and nd.boot != boot:
                nd.boots += 1
                self.ev("warn", f"Node {name} 重启过（boot {nd.boot}→{boot}）")
                if name == "A":
                    self.pending.clear()
                    self.reset_dsp()
                nd.wraps = 0
                nd.last_ts = None
            if not nd.online:
                self.ev("ok", f"Node {name} 上线 · 固件 {info.get('fw','?')} · IP {ip} · 信道 {info.get('ch','?')} · RSSI {info.get('rssi','?')}")
            nd.boot = boot
            nd.online = True
            nd.last = time.time()
            nd.uploads += 1
            nd.recs += int(nrec)
            nd.uptime_ms = up_ms
            nd.dropped = dropped
            nd.info = info
            nd.info["ip"] = info.get("ip", ip)
            try:
                self.plan = 13 if int(info.get("plan", "13")) > 3 else 3
            except Exception:
                pass
            if nrec:
                for s in np.unique(recs["sweep"]):
                    ent = self.pending.setdefault(int(s), {"A": [], "B": [], "t0": time.time()})
                    ent[name].append(recs[recs["sweep"] == s])
            self.raw.write(body)
        return True, "ok"

    # ---------- 后台处理线程 ----------
    def _worker(self):
        while True:
            try:
                time.sleep(0.08)
                with self.lock:
                    now = time.time()
                    for nd in self.nodes.values():
                        if nd.online and now - nd.last > 45:
                            nd.online = False
                            self.ev("warn", f"Node {nd.name} 超过 45 秒没有上传，判定离线")
                    ready = []
                    for s, ent in list(self.pending.items()):
                        both = len(ent["A"]) > 0 and len(ent["B"]) > 0
                        if both or now - ent["t0"] > 7:
                            ready.append(s)
                    ready.sort()
                    jobs = [(s, self.pending.pop(s)) for s in ready]
                for s, ent in jobs:
                    try:
                        t = time.time()
                        self._process(s, ent)
                        self.proc_times.append(time.time() - t)
                    except Exception as e:
                        self.errors["process"] += 1
                        self.last_error = f"处理扫描 {s} 异常: {e}"
                        self.ev("fail", self.last_error + " | " + traceback.format_exc().splitlines()[-3].strip())
            except Exception:
                time.sleep(0.5)

    def _process(self, sweep, ent):
        A = np.concatenate(ent["A"]) if ent["A"] else np.zeros(0, REC_DT)
        B = np.concatenate(ent["B"]) if ent["B"] else np.zeros(0, REC_DT)
        A = A[A["dir"] == 1]
        B = B[B["dir"] == 0]
        expected = list(range(1, 14)) if self.plan > 3 else [1, 6, 11]
        resp = {}
        qual = []
        npairs = 0
        mode = "none"
        # --- 双向配对：同信道同序号 ---
        for ch in expected:
            a = A[A["ch"] == ch]
            b = B[B["ch"] == ch]
            sa = {int(x["seq"]): x for x in a}
            sb = {int(x["seq"]): x for x in b}
            common = sorted(set(sa) & set(sb))
            if common:
                HBA = csi_c(np.stack([sa[s]["csi"] for s in common]))
                HAB = csi_c(np.stack([sb[s]["csi"] for s in common]))
                r, q = align_frames(calibrate_pair(HAB, HBA))
                resp[ch] = r
                qual.append(q)
                npairs += len(common)
        two = len(resp) >= max(2, len(expected) // 2)
        if two:
            mode = "two-way"
        else:  # 退化：只有单向（另一节点没传到）
            resp = {}
            qual = []
            src = A if len(A) >= len(B) else B
            for ch in expected:
                x = src[src["ch"] == ch]
                if len(x) >= 1:
                    r, q = align_frames(csi_c(x["csi"]))
                    resp[ch] = r
                    qual.append(q)
            if len(resp) >= max(2, len(expected) // 2):
                mode = "one-way"
        ch_ok = sorted(resp)
        self.sync_hist.append(len(ch_ok) / len(expected))
        if mode == "none":
            self.sweeps_skipped += 1
            self.ev("warn", f"扫描 {sweep}: 可用信道 {len(ch_ok)}/{len(expected)}，丢弃（A记录 {len(A)} 条 / B记录 {len(B)} 条）")
            return
        tw = mode == "two-way"
        H, valid, g0, overlaps = stitch(resp, max(expected), align=self.plan > 3)
        N = len(H)
        g = (np.arange(N) + g0).astype(float)
        # --- 时间戳（用 A 的硬件时间戳；没有 A 就用 B） ---
        node_used = self.nodes["A"] if len(A) else self.nodes["B"]
        ts0 = int((A if len(A) else B)["ts"].min())
        t_s = node_used.unwrap(ts0)
        with self.lock:
            if self.hist_t and t_s <= self.hist_t[-1]:
                t_s = self.hist_t[-1] + 0.01
            # --- 锚定 / 对齐到参考响应 ---
            nmax = int(round(R_MAX / C / DT))
            if self.ref is None or len(self.ref) != N or self.ref_tw != tw:
                # 采样时间偏移会让整条 CIR 循环移位（甚至移到负延迟），所以锚定时要在整个 NFFT 圆周上找最强径
                cir_full = self.be.cir(H[None, :], g0, NFFT)[0]
                mag = np.abs(cir_full)
                n_p = int(np.argmax(mag))
                y0, y1, y2 = mag[(n_p - 1) % NFFT], mag[n_p], mag[(n_p + 1) % NFFT]
                n_p = n_p + 0.5 * (y0 - y2) / (y0 - 2 * y1 + y2 + 1e-12)
                if n_p > NFFT / 2:
                    n_p -= NFFT
                n_los = self.baseline_m / C / DT
                H = H * np.exp(-1j * 2 * np.pi * g * (n_los - n_p) / NFFT)
                self.ref = H.copy()
                self.ref_tw = tw
                self.ref_peak = float(np.abs(self.be.cir(H[None, :], g0, nmax)[0]).max())
                self.anchored = True
                self.ev("info", f"已建立参考响应：最强径锚定在 {self.baseline_m:.1f} m（两节点间距，可在网页里调整）")
                q_ref = 1.0
            else:
                m = valid & (np.abs(self.ref) > 0)
                if m.sum() < 20:
                    self.sweeps_skipped += 1
                    return
                a, b = fit_phase(H * np.conj(self.ref), g, m)
                H = H * np.exp(-1j * (a + b * g))
                q_ref = float(abs(np.sum(H[m] * np.conj(self.ref[m]))) / (np.linalg.norm(H[m]) * np.linalg.norm(self.ref[m]) + 1e-9))
                miss = (~valid) & (np.abs(self.ref) > 0)
                H[miss] = self.ref[miss]            # 缺信道时用参考补洞，避免剖面抖动
                new = valid & (np.abs(self.ref) == 0)
                self.ref[new] = H[new]
                if q_ref > 0.5:
                    self.ref[valid] = 0.985 * self.ref[valid] + 0.015 * H[valid]
            full = np.abs(H) > 0
            cir = self.be.cir(H[None, :], g0, nmax)[0]
            mag = np.abs(cir)
            self.ref_peak = max(self.ref_peak * 0.998, float(mag.max()))
            nb = nmax // NPROF
            prof = mag[: nb * NPROF].reshape(NPROF, nb).max(1)
            db = 20 * np.log10(prof / self.ref_peak + 1e-6)
            u8 = np.clip((db + 45) / 45 * 255, 0, 255).astype(np.uint8)
            # --- MUSIC（需要连续频点，GPU1） ---
            music_u8 = None
            if full.sum() > 150:
                runs = np.flatnonzero(np.diff(np.concatenate([[0], full.astype(int), [0]])))
                r0, r1 = max(zip(runs[0::2], runs[1::2]), key=lambda p: p[1] - p[0])
                if r1 - r0 >= 120:
                    try:
                        pdb = None
                        nsel = (np.arange(NPROF) * nb + nb // 2)
                        P = self.be.music(H[r0:r1], NSRC, nsel)
                        pdb = 10 * np.log10(P / (P.max() + 1e-30) + 1e-9)
                        music_u8 = np.clip((pdb + 30) / 30 * 255, 0, 255).astype(np.uint8)
                    except Exception as e:
                        self.errors["music"] += 1
                        self.last_error = f"MUSIC 异常: {e}"
            # --- 感知特征 ---
            An = np.abs(H) / (np.linalg.norm(H) + 1e-9)
            D = float(np.linalg.norm(An - self.prevA)) if self.prevA is not None and len(self.prevA) == N else None
            self.prevA = An
            if D is not None:
                self.hist_D.append(D)
                if self.base is None:
                    self.cal_D.append(D)
                    if len(self.cal_D) >= CAL_SWEEPS:
                        med = float(np.median(self.cal_D))
                        mad = float(np.median(np.abs(np.array(self.cal_D) - med)) * 1.4826)
                        self.base = (med, mad)
                        self.ev("ok", f"基线建立完成：D0={med:.4f} σ={mad:.4f}")
            self.hist_t.append(t_s)
            self.hist_cir.append(cir.astype(np.complex64))
            self.hist_prof.append(prof.astype(np.float32))
            sense = self._sense(nb, tw, nmax)
            # --- 峰值 ---
            peak_list = find_peaks(db, -32)
            music_peaks = find_peaks(pdb, -20) if music_u8 is not None else []
            spec_db = 20 * np.log10(np.abs(H) / (np.abs(H).max() + 1e-9) + 1e-3)
            spec = np.clip((spec_db + 40) / 40 * 255, 0, 255).astype(np.uint8)
            spec[~full] = 0
            self.seq += 1
            self.sweeps_done += 1
            row = {"seq": self.seq, "t": round(t_s, 3), "sweep": sweep, "p": u8.tolist()}
            self.rows.append(row)
            now = time.time()
            self.hz_hist = getattr(self, "hz_hist", collections.deque(maxlen=12))
            self.hz_hist.append(now)
            hz = (len(self.hz_hist) - 1) / (self.hz_hist[-1] - self.hz_hist[0]) if len(self.hz_hist) > 3 and self.hz_hist[-1] > self.hz_hist[0] else 0.0
            ncov = int(valid.sum())
            self.last = {
                "mode": mode, "twoWay": tw, "sweep": sweep, "t": round(t_s, 3), "pairs": npairs, "channelsOk": ch_ok,
                "coherence": round(float(np.mean(qual)), 3) if qual else 0, "refCorr": round(q_ref, 3),
                "overlaps": overlaps[:12], "bins": ncov, "bwMHz": round(ncov * DF / 1e6, 1),
                "resM": round(C / (max(1, ncov) * DF), 2),
                "profile": u8.tolist(), "music": music_u8.tolist() if music_u8 is not None else None, "musicPeaks": music_peaks,
                "spectrum": spec.tolist(), "peaks": peak_list, "sense": sense, "arrive": now,
            }

    def _sense(self, nb, tw, nmax):
        n = len(self.hist_D)
        out = {"calibrated": self.base is not None, "calN": len(self.cal_D), "calNeed": CAL_SWEEPS, "present": False, "motion": 0.0,
               "z": 0.0, "breathBpm": None, "breathConf": 0.0, "activeR": None, "level": "calibrating"}
        if self.base is None:
            return out
        med, mad = self.base
        dsm = float(np.mean(list(self.hist_D)[-3:]))
        z = (dsm - med) / (max(mad, 0.15 * med) + 1e-6)
        out["z"] = round(z, 2)
        out["motion"] = round(float(np.clip(z / 8.0, 0, 1)), 3)
        self.present_hist.append(z > 3.0)
        # 活动距离：最近 16 轮各距离点的相对波动
        P = np.array(list(self.hist_prof)[-16:])
        active_bin = None
        if len(P) >= 6:
            v = P.std(0) / (P.mean(0) + 1e-9)
            v = np.convolve(v, np.ones(3) / 3, "same")
            lo = int(max(0, (0.5 * self.baseline_m) / R_MAX * NPROF))
            vv = v.copy()
            vv[:lo] = 0
            active_bin = int(np.argmax(vv))
            out["activeR"] = round((active_bin + 0.5) * R_MAX / NPROF, 2)
            out["activeConf"] = round(float(vv[active_bin] / (np.median(vv[lo:]) + 1e-9)), 2)
        # 呼吸：Lomb–Scargle（不等间隔），0.1–0.5Hz
        t = np.array(self.hist_t)
        if active_bin is not None and len(t) >= 18 and lombscargle is not None:
            sel = t > t[-1] - 70
            ts = t[sel]
            if ts[-1] - ts[0] >= 20 and np.median(np.diff(ts)) < 3.0:
                Cs = np.array(list(self.hist_cir))[sel]
                x = Cs[:, active_bin * nb:(active_bin + 1) * nb].mean(1)
                f = np.linspace(0.1, 0.5, 81)
                w = 2 * np.pi * f
                pw = np.zeros_like(f)
                for y in (x.real, x.imag):
                    y = y - y.mean()
                    if y.std() > 0:
                        pw += lombscargle(ts - ts[0], y / y.std(), w, normalize=True)
                k = int(np.argmax(pw))
                conf = float(pw[k] / (np.median(pw) + 1e-9))
                pk_norm = float(pw[k] / 2.0)       # 两路(实/虚)归一化功率之和 /2 ∈[0,1]
                out["breathConf"] = round(conf, 2)
                out["breathPow"] = round(pk_norm, 3)
                if conf > BREATH_CONF and pk_norm > BREATH_POW and out["motion"] < 0.6:
                    out["breathBpm"] = round(60 * float(f[k]), 1)
        present = sum(self.present_hist) >= 2 or (out["breathBpm"] is not None and out["motion"] < 0.35)
        out["present"] = bool(present)
        out["level"] = "moving" if out["motion"] >= 0.35 and present else ("still" if present else "none")
        return out

    # ---------- 对外 ----------
    def state(self, since):
        with self.lock:
            now = time.time()
            nodes = {}
            for k, nd in self.nodes.items():
                nodes[k] = {"online": nd.online, "age": round(now - nd.last, 1) if nd.last else None, "uploads": nd.uploads, "recs": nd.recs,
                            "boots": nd.boots, "uptimeMs": nd.uptime_ms, "dropped": nd.dropped, "info": nd.info}
            rows = [r for r in self.rows if r["seq"] > since][-60:]
            L = self.last
            return {"ok": True, "seq": self.seq, "now": now, "uptime": round(now - T0, 1), "plan": self.plan, "baselineM": self.baseline_m,
                    "rangeMax": R_MAX, "nprof": NPROF, "nodes": nodes, "tunnel": self.public_url,
                    "gpu": self.be.info(), "stats": self._stats(), "last": {k: v for k, v in L.items() if k not in ("profile",)} if L else None,
                    "profile": L.get("profile") if L else None, "rows": rows, "errors": dict(self.errors), "lastError": self.last_error,
                    "syncLossPct": round(100 * (1 - float(np.mean(self.sync_hist))), 1) if self.sync_hist else None}

    def _stats(self):
        pt = list(self.proc_times)
        return {"done": self.sweeps_done, "skipped": self.sweeps_skipped, "pending": len(self.pending),
                "procMs": round(1000 * float(np.mean(pt)), 1) if pt else 0, "rawBytes": self.raw.bytes, "rawOn": self.raw.ok}

    def diag(self):
        with self.lock:
            now = time.time()
            items = []

            def add(id_, name, status, detail):
                items.append({"id": id_, "name": name, "status": status, "detail": detail})

            add("server", "主机服务", "ok", f"运行 {now - T0:.0f}s · Python {platform.python_version()} · numpy {np.__version__} · 端口 {PORT} · {'Kaggle' if IS_KAGGLE else '本地'}")
            add("tunnel", "公网隧道", "ok" if self.public_url else ("info" if NO_TUNNEL else "warn"), self.public_url or ("本地模式（未启用隧道）" if NO_TUNNEL else "隧道尚未就绪（等待 cloudflared 输出网址）"))
            g = self.be.info()
            add("gpu", "GPU 加速", "ok" if g["cuda"] else "info",
                (", ".join(g["devices"]) + f" · CIR→{g['cir']} · MUSIC→{g['music']}") if g["cuda"] else f"未检测到 CUDA（{g['err'] or '使用 numpy'}）· 点数据很小，CPU 也够用")
            for k in "AB":
                nd = self.nodes[k]
                if nd.last == 0:
                    add("node" + k, f"Node {k}", "fail", "从未收到上传。检查：WiFi 名/密码(2.4GHz)、config.h 的 KAGGLE_URL、API_KEY；串口应出现 [upload] HTTP 200")
                else:
                    age = now - nd.last
                    st = "ok" if age < 20 else ("warn" if age < 45 else "fail")
                    inf = nd.info
                    add("node" + k, f"Node {k}", st, f"{'在线' if nd.online else '离线'} · {age:.0f}s 前 · 固件 {inf.get('fw','?')} · IP {inf.get('ip','?')} · 路由器信道 {inf.get('ch','?')} · RSSI {inf.get('rssi','?')} · 上传 {nd.uploads} 次 / {nd.recs} 条 · 缓冲丢弃 {nd.dropped} · 重启 {nd.boots}")
            L = self.last
            if not L:
                if self.nodes["A"].recs == 0 and self.nodes["B"].recs == 0:
                    add("csi", "CSI 数据", "fail" if (self.nodes["A"].last or self.nodes["B"].last) else "warn",
                        "两个节点都还没有上传 CSI 记录。节点在线但记录为 0 → 两块板子没有同步（看串口 [sync]）；都没在线 → 先解决上传")
                else:
                    add("csi", "CSI 数据", "warn", f"已收到 A {self.nodes['A'].recs} 条 / B {self.nodes['B'].recs} 条，但还没有凑齐一轮扫描")
            else:
                st = "ok" if L["mode"] == "two-way" else "warn"
                add("pair", "双向配对", st, f"模式 {L['mode']} · 本轮配对 {L['pairs']} 对 · 信道 {len(L['channelsOk'])}/{13 if self.plan > 3 else 3}：{L['channelsOk']}" + ("" if L["mode"] == "two-way" else " ← 只有单向，另一节点的数据没有到达"))
                add("stitch", "频谱拼接", "ok" if L["coherence"] > 0.6 else "warn", f"覆盖 {L['bins']} 个频点 ≈ {L['bwMHz']} MHz · 帧内相干度 {L['coherence']} · 与参考相关 {L['refCorr']} · 重叠子载波 {L['overlaps']}")
                age = now - L["arrive"]
                add("fresh", "数据新鲜度", "ok" if age < 15 else ("warn" if age < 40 else "fail"), f"最近一轮 {age:.1f}s 前 · 处理速率 {self.hz_text()} · 单轮处理 {self._stats()['procMs']} ms")
                add("music", "MUSIC 超分辨", "ok" if L.get("music") else "info", "已输出" if L.get("music") else "频点不连续（[1,6,11] 稀疏模式下不做 MUSIC）")
                s = L["sense"]
                add("sense", "感知", "ok" if s["calibrated"] else "info", f"校准 {s['calN']}/{s['calNeed']} · 存在 {s['present']} · 运动 {s['motion']} · 呼吸 {s['breathBpm']} BPM (置信 {s['breathConf']}) · 活动距离 {s['activeR']} m")
            if self.sync_hist:
                loss = 100 * (1 - float(np.mean(self.sync_hist)))
                add("sync", "信道同步丢失率", "ok" if loss < 10 else ("warn" if loss < 30 else "fail"), f"最近 {len(self.sync_hist)} 轮平均 {loss:.1f}%（验收目标 <10%）")
            tot_err = sum(self.errors.values())
            add("errors", "错误计数", "ok" if tot_err == 0 else "warn", f"{dict(self.errors)} · 最近错误：{self.last_error or '无'}")
            add("raw", "原始数据落盘", "ok" if self.raw.ok else "info", f"{self.raw.bytes/2**20:.1f} MB 已写入 {RAW_DIR}（上限 {RAW_MAX_GB} GB）" if self.raw.ok else "未启用")
            return {"ok": True, "now": now, "items": items, "events": list(self.events)[-120:], "client": list(self.client_logs)[-3:]}

    def hz_text(self):
        h = getattr(self, "hz_hist", None)
        if h and len(h) > 3 and h[-1] > h[0]:
            return f"{(len(h) - 1) / (h[-1] - h[0]):.2f} 轮/秒"
        return "—"

    def diag_text(self):
        d = self.diag()
        lines = [f"# ESP32-S3 CSI Radar 服务端检测日志  {time.strftime('%Y-%m-%d %H:%M:%S')}"]
        mark = {"ok": "✅", "warn": "⚠️", "fail": "❌", "info": "ℹ️"}
        for it in d["items"]:
            lines.append(f"{mark.get(it['status'],'•')} {it['name']}: {it['detail']}")
        lines.append("\n## 事件")
        for e in d["events"]:
            lines.append(f"{time.strftime('%H:%M:%S', time.localtime(e['t']))} [{e['lv']}] {e['msg']}")
        return "\n".join(lines)


core = Core()
app = Flask(__name__)
logging.getLogger("werkzeug").setLevel(logging.ERROR)


@app.after_request
def _cors(r):
    r.headers["Access-Control-Allow-Origin"] = "*"
    r.headers["Access-Control-Allow-Headers"] = "Content-Type, X-Radar-Key"
    r.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    r.headers["Cache-Control"] = "no-store"
    return r


def _key_ok():
    return (request.headers.get("X-Radar-Key") or request.args.get("key") or "") == API_KEY


@app.route("/api/<path:_p>", methods=["OPTIONS"])
def _opt(_p):
    return "", 204


@app.route("/api/health")
def health():
    return jsonify({"ok": True, "t": time.time(), "uptime": round(time.time() - T0, 1), "version": "8.0", "kind": "csi-radar"})


@app.route("/api/ingest", methods=["POST"])
def ingest():
    if not _key_ok():
        core.errors["bad_key"] += 1
        core.last_error = "上传密钥不对（ESP32 的 API_KEY 与 Kaggle 的 RADAR_KEY 不一致）"
        core.ev("fail", core.last_error + f" 来自 {request.remote_addr}")
        return jsonify({"ok": False, "err": "key"}), 401
    ok, why = core.ingest(request.get_data(), request.headers.get("X-Radar-Info", ""), request.headers.get("CF-Connecting-IP") or request.remote_addr)
    return jsonify({"ok": ok, "why": why}), (200 if ok else 400)


@app.route("/api/state")
def state():
    try:
        since = int(request.args.get("since", "0"))
    except Exception:
        since = 0
    return jsonify(core.state(since))


@app.route("/api/rows")
def rows():
    with core.lock:
        return jsonify({"rows": list(core.rows)[-200:], "nprof": NPROF, "rangeMax": R_MAX})


@app.route("/api/diag")
def diag():
    return jsonify(core.diag())


@app.route("/api/diag.txt")
def diag_txt():
    return Response(core.diag_text(), mimetype="text/plain; charset=utf-8")


@app.route("/api/calibrate", methods=["POST"])
def calibrate():
    if not _key_ok():
        return jsonify({"ok": False}), 401
    core.calibrate()
    return jsonify({"ok": True})


@app.route("/api/config", methods=["POST"])
def config():
    if not _key_ok():
        return jsonify({"ok": False}), 401
    try:
        j = request.get_json(force=True) or {}
        if "baselineM" in j:
            core.baseline_m = float(np.clip(float(j["baselineM"]), 0.3, 25))
            core.calibrate()
            core.ev("info", f"两节点间距设为 {core.baseline_m:.2f} m，重新校准")
        return jsonify({"ok": True, "baselineM": core.baseline_m})
    except Exception as e:
        return jsonify({"ok": False, "err": str(e)}), 400


@app.route("/api/clientlog", methods=["POST"])
def clientlog():
    try:
        core.client_logs.append({"t": time.time(), "text": (request.get_data(as_text=True) or "")[:20000]})
    except Exception:
        pass
    return jsonify({"ok": True})


PAGE = """<!doctype html><meta charset=utf-8><title>CSI Radar 主机</title>
<body style="background:#050b14;color:#cfe;font:14px/1.6 ui-monospace,Menlo,monospace;padding:20px">
<h2>📡 ESP32-S3 CSI Radar · 主机端在线</h2>
<p>把本页网址填进「复制代码界面」的 Kaggle 网址框，ESP32 才会上传；3D 画面在你的浏览器模拟器里看。</p>
<pre id=o>加载中…</pre>
<script>async function t(){try{const r=await fetch('/api/diag.txt');document.getElementById('o').textContent=await r.text()}catch(e){document.getElementById('o').textContent=String(e)}}
t();setInterval(t,2000)</script></body>"""


@app.route("/")
def index():
    return Response(PAGE, mimetype="text/html; charset=utf-8")


# =============================== 隧道 / 网址发布 ===============================
def _publish(url):
    try:
        import requests
        requests.post(f"https://ntfy.sh/{TOPIC}", data=url.encode(), timeout=8)
        core.ev("info", f"网址已发布到 ntfy.sh/{TOPIC}（ESP32 可自动发现）")
    except Exception as e:
        core.ev("warn", f"ntfy 发布失败：{str(e)[:80]}")


def _set_url(url):
    core.public_url = url
    core.ev("ok", f"公网网址：{url}")
    box = "═" * 74
    print("\n" + box)
    print("  📡 ESP32 上传地址（把下面这行复制到网页「复制代码界面」的 Kaggle 网址框）：")
    print(f"\n      {url}\n")
    print("  同一个网址也填到「浏览器模拟器」顶部的 Kaggle 输入框，即可看到 3D 画面。")
    print(box + "\n", flush=True)
    try:
        with open(os.path.join(WORK, "radar_url.txt"), "w") as f:
            f.write(url + "\n")
    except Exception:
        pass
    threading.Thread(target=_publish, args=(url,), daemon=True).start()

    def loop():
        while True:
            time.sleep(240)
            _publish(url)
    threading.Thread(target=loop, daemon=True).start()


def start_tunnel():
    exe = shutil.which("cloudflared")
    if not exe:
        exe = os.path.join(WORK, "cloudflared")
        if not os.path.exists(exe):
            print("[tunnel] 下载 cloudflared ...", flush=True)
            try:
                import requests
                r = requests.get("https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64", timeout=120)
                open(exe, "wb").write(r.content)
                os.chmod(exe, 0o755)
            except Exception as e:
                core.ev("fail", f"cloudflared 下载失败：{e}（请确认 Kaggle 右侧 Internet 已开启）")
                print("[tunnel] ❌ 下载失败：", e, flush=True)
                return
    p = subprocess.Popen([exe, "tunnel", "--url", f"http://127.0.0.1:{PORT}", "--no-autoupdate"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)

    def reader():
        for line in p.stdout:
            m = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", line)
            if m and not core.public_url:
                _set_url(m.group(0))
    threading.Thread(target=reader, daemon=True).start()
    t0 = time.time()
    while time.time() - t0 < 75 and not core.public_url:
        time.sleep(1)
    if not core.public_url:
        core.ev("warn", "cloudflared 75 秒没给网址，改用 localhost.run 备用隧道")
        try:
            q = subprocess.Popen(["ssh", "-o", "StrictHostKeyChecking=no", "-R", f"80:127.0.0.1:{PORT}", "nokey@localhost.run"],
                                 stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)

            def rd2():
                for line in q.stdout:
                    m = re.search(r"https://[a-z0-9]+\.lhr\.life", line)
                    if m and not core.public_url:
                        _set_url(m.group(0))
            threading.Thread(target=rd2, daemon=True).start()
        except Exception as e:
            core.ev("fail", f"备用隧道失败：{e}")


def main():
    from werkzeug.serving import make_server
    srv = make_server("0.0.0.0", PORT, app, threaded=True)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print(f"[server] 监听 0.0.0.0:{PORT} · GPU: {core.be.names or '无'} · 原始数据目录 {RAW_DIR}", flush=True)
    if NO_TUNNEL:
        print(f"[server] 本地模式 http://127.0.0.1:{PORT}", flush=True)
    else:
        threading.Thread(target=start_tunnel, daemon=True).start()
    last = 0
    while True:
        time.sleep(5)
        if time.time() - last >= 30:
            last = time.time()
            a, b = core.nodes["A"], core.nodes["B"]
            print(f"[status] A:{'在线' if a.online else '离线'}({a.recs}条) B:{'在线' if b.online else '离线'}({b.recs}条) 已处理 {core.sweeps_done} 轮 速率 {core.hz_text()} "
                  f"{'URL ' + core.public_url if core.public_url else ''}", flush=True)


if __name__ == "__main__":
    main()
