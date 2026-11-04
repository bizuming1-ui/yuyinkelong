#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
双节点 ESP32 模拟器：不需要硬件，生成与固件【字节完全相同】的上传数据，用来验证 Kaggle 主机端。
物理模型（故意把真实硬件的麻烦都加上）：
  · 多径信道  H(f)=Σ a_i·exp(-j2π f τ_i)，f 为真实射频频率（2412+5(ch-1)MHz + k·312.5kHz）
  · 每次换台两端 PLL 随机相位 φA/φB：H_AB 带 e^{j(φA-φB)}，H_BA 带 e^{j(φB-φA)}（双向乘积可抵消）
  · 每帧随机采样时间偏移(线性相位)、随机常数相位(CFO)、随机增益(AGC)、噪声、int8 量化
场景：empty 空场 / walk 前 30 轮空场校准，之后一个人在 8~10m 路径处走动 / breath 静止呼吸(15 BPM) / two 两个静态反射体(路径 8m、14m)
用法：python3 tools/sim_esp32_csi.py --url http://127.0.0.1:8000 --plan full --scenario walk --sweeps 60 [--check]
"""
import argparse, struct, time, json, sys, math
import numpy as np
import requests

C = 299792458.0
DF = 312500.0
K = np.arange(-32, 32)


def channel_resp(ch, paths):
    f = 2412e6 + 5e6 * (ch - 1) + K * DF
    H = np.zeros(64, complex)
    for L, a, ph in paths:
        H += a * np.exp(-1j * 2 * np.pi * f * (L / C) + 1j * ph)
    return H


def to_csi_bytes(H, scale):
    # 固件字节序：fftshift 的逆（k=-32..31 -> 缓冲区 0..31, -32..-1），每子载波 [imag, real]
    buf = np.fft.ifftshift(H)
    out = np.zeros(128, np.int8)
    out[0::2] = np.clip(np.round(buf.imag * scale), -127, 127).astype(np.int8)
    out[1::2] = np.clip(np.round(buf.real * scale), -127, 127).astype(np.int8)
    return out


REC = np.dtype([("dir", "u1"), ("ch", "u1"), ("seq", "u1"), ("rssi", "i1"), ("sweep", "<u2"), ("ts", "<u4"), ("aux", "<u4"),
                ("len", "u1"), ("flags", "u1"), ("csi", "i1", (128,))])


def make_body(node, recs, boot, up_ms):
    arr = np.zeros(len(recs), REC)
    for i, r in enumerate(recs):
        arr[i] = r
    return struct.pack("<2sBBHHII", b"RC", 1, node, len(recs), boot, up_ms, 0) + arr.tobytes()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8000")
    ap.add_argument("--key", default="radar-key")
    ap.add_argument("--plan", default="full", choices=["full", "sparse"])
    ap.add_argument("--scenario", default="walk", choices=["empty", "walk", "breath", "two"])
    ap.add_argument("--sweeps", type=int, default=60)
    ap.add_argument("--exch", type=int, default=8)
    ap.add_argument("--baseline", type=float, default=3.0)
    ap.add_argument("--snr", type=float, default=28.0)
    ap.add_argument("--loss", type=float, default=0.05, help="每次交换丢包概率")
    ap.add_argument("--only", default="", help="A 或 B：只让一个节点上传（测试单向退化）")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--realtime", action="store_true")
    ap.add_argument("--seed", type=int, default=1)
    a = ap.parse_args()
    rng = np.random.default_rng(a.seed)
    plan = list(range(1, 14)) if a.plan == "full" else [1, 6, 11]
    d0 = a.baseline
    static = [(d0, 1.0, 0.3), (6.0, 0.35, 1.0), (11.0, 0.25, 2.0), (17.0, 0.15, 0.5)]
    hdr = {"X-Radar-Key": a.key, "Content-Type": "application/octet-stream"}
    info = f"fw=10.0.0-sim;mac=SIM;rssi=-48;ch=6;ip=127.0.0.1;plan={len(plan)};rst=poweron;last=none;lnk=sync:5/5,probe:400,reply:380,csi:370,data:360,stat:20,txerr:0;pwr=15"
    t_us = 1_000_000.0
    recA, recB = [], []
    BOOT = 4242
    sweep_id = 0
    sent = 0
    for sw in range(1, a.sweeps + 1):
        tsec = (t_us / 1e6)
        paths = list(static)
        if a.scenario == "walk" and sw > 30:   # 前 30 轮空场用于基线校准（真实使用时也要先让房间安静）
            L = 9.0 + 1.2 * math.sin(tsec * 0.9)
            paths.append((L, 0.55, 0.2))
        elif a.scenario == "breath":
            L = 9.0 + 0.012 * math.sin(2 * math.pi * 0.25 * tsec)
            paths.append((L, 0.5, 0.2))
        elif a.scenario == "two":
            paths = [(d0, 1.0, 0.3), (8.0, 0.5, 1.0), (14.0, 0.45, 2.0)]
        sweep_id += 1
        for ch in plan:
            phiA, phiB = rng.uniform(0, 2 * np.pi, 2)
            Hc = channel_resp(ch, paths)
            for seq in range(a.exch):
                t_us += 5000
                if rng.random() < a.loss:
                    continue
                def meas(sign):
                    sto = rng.uniform(-30e-9, 30e-9)
                    cfo = rng.uniform(0, 2 * np.pi)
                    g = rng.uniform(0.7, 1.3)
                    H = Hc * np.exp(1j * sign * (phiA - phiB)) * np.exp(-1j * 2 * np.pi * K * DF * sto) * np.exp(1j * cfo) * g
                    sig = np.sqrt(np.mean(np.abs(H[np.abs(K) <= 26]) ** 2))
                    n = (rng.standard_normal(64) + 1j * rng.standard_normal(64)) * sig / np.sqrt(2) * 10 ** (-a.snr / 20)
                    return to_csi_bytes(H + n, 60.0 / (np.abs(Hc).max() * 1.3))
                ts = int(t_us) & 0xFFFFFFFF
                recB.append((0, ch, seq, -50, sweep_id, ts, ts, 128, 0, meas(+1)))
                recA.append((1, ch, seq, -48, sweep_id, ts + 800, 180, 128, 0, meas(-1)))
            t_us += 7000
        if sw % 3 == 0 or sw == a.sweeps:
            for node, recs in ((0, recA), (1, recB)):
                if a.only and "AB"[node] != a.only:
                    continue
                body = make_body(node, recs, BOOT + node, int(t_us / 1000))
                r = requests.post(a.url + "/api/ingest", data=body, headers=dict(hdr, **{"X-Radar-Info": info}), timeout=10)
                if r.status_code != 200:
                    print("ingest failed", r.status_code, r.text)
                    sys.exit(2)
                sent += len(recs)
            recA, recB = [], []
            t_us += 1_800_000
            if a.realtime:
                time.sleep(2.0)
    time.sleep(1.5)
    st = requests.get(a.url + "/api/state?since=0", timeout=10).json()
    last = st.get("last") or {}
    sense = last.get("sense", {})
    print(json.dumps({"seq": st["seq"], "mode": last.get("mode"), "channelsOk": len(last.get("channelsOk", [])), "pairs": last.get("pairs"),
                      "coherence": last.get("coherence"), "refCorr": last.get("refCorr"), "bwMHz": last.get("bwMHz"), "resM": last.get("resM"),
                      "peaks": last.get("peaks"), "musicPeaks": last.get("musicPeaks"), "sense": sense, "music": bool(last.get("music")), "syncLoss": st.get("syncLossPct")}, ensure_ascii=False))
    if a.check:
        ok = True
        peaks = last.get("peaks") or []
        rs = [p["r"] for p in peaks]
        rm = [p["r"] for p in (last.get("musicPeaks") or [])]
        def near(x, tol): return any(abs(r - x) <= tol for r in rs)
        if a.scenario == "two":
            tol = 1.6 if a.plan == "full" else 3.0
            ok &= any(abs(r - 8.0) <= tol for r in rs + rm) and any(abs(r - 14.0) <= tol for r in rs + rm)
            print("两目标分辨(IFFT 或 MUSIC):", "PASS" if ok else "FAIL", rs, rm)
        elif a.scenario == "walk":
            ok &= sense.get("present", False) and sense.get("motion", 0) > 0.2
            print("走动检出:", "PASS" if ok else "FAIL", sense)
            ok &= near(d0, 1.2)
        elif a.scenario == "breath":
            b = sense.get("breathBpm")
            ok &= (b is not None and abs(b - 15.0) < 2.0)
            print("呼吸检出:", "PASS" if ok else "FAIL", sense)
        elif a.scenario == "empty":
            ok &= not sense.get("present", False)
            print("空场不误报:", "PASS" if ok else "FAIL", sense)
        ok &= near(d0, 1.5) or a.scenario == "walk"
        print("RESULT", "PASS" if ok else "FAIL")
        sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
