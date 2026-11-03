#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
主机端回归测试（无需硬件）：启动 kaggle/csi_radar_kaggle.py（本地模式），用 tools/sim_esp32_csi.py 生成与固件字节一致的数据，
覆盖：空场不误报 / 走动检出 / 呼吸 15BPM / 两目标分辨(8m,14m) / [1,6,11] 稀疏流程 / 单向退化 / 错误密钥 401 / 坏数据 400。
用法：python3 tools/test_host.py --seed 1 [--port 8200]
"""
import argparse, os, subprocess, sys, time, signal
import requests

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def start(port):
    env = dict(os.environ, RADAR_NO_TUNNEL="1", RADAR_PORT=str(port), RADAR_RAW_DIR=f"/tmp/rr_t{port}")
    p = subprocess.Popen([sys.executable, os.path.join(ROOT, "kaggle", "csi_radar_kaggle.py")], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, preexec_fn=os.setsid)
    for _ in range(40):
        try:
            if requests.get(f"http://127.0.0.1:{port}/api/health", timeout=1).ok:
                return p
        except Exception:
            time.sleep(0.25)
    raise SystemExit("server did not start")


def stop(p):
    os.killpg(os.getpgid(p.pid), signal.SIGTERM)
    time.sleep(0.3)


def sim(port, args):
    r = subprocess.run([sys.executable, os.path.join(HERE, "sim_esp32_csi.py"), "--url", f"http://127.0.0.1:{port}"] + args, capture_output=True, text=True)
    return r.returncode, r.stdout.strip().splitlines()[-1] if r.stdout.strip() else r.stderr[-200:]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--port", type=int, default=8200)
    a = ap.parse_args()
    seed = str(a.seed)
    results = []
    cases = [
        ("空场不误报", ["--scenario", "empty", "--sweeps", "60", "--check"]),
        ("走动检出", ["--scenario", "walk", "--sweeps", "60", "--check"]),
        ("呼吸 15BPM", ["--scenario", "breath", "--sweeps", "90", "--check"]),
        ("两目标 8m/14m 分辨", ["--scenario", "two", "--sweeps", "40", "--check"]),
    ]
    for i, (name, args) in enumerate(cases):
        port = a.port + i
        p = start(port)
        try:
            code, out = sim(port, args + ["--seed", seed])
        finally:
            stop(p)
        results.append((name, code == 0, out[:160]))
    # 稀疏 [1,6,11] 流程
    port = a.port + 10
    p = start(port)
    try:
        code, out = sim(port, ["--plan", "sparse", "--scenario", "empty", "--sweeps", "30", "--seed", seed])
        st = requests.get(f"http://127.0.0.1:{port}/api/state?since=0").json()
        ok = code == 0 and st["last"] is not None and st["last"]["mode"] == "two-way" and len(st["last"]["channelsOk"]) == 3
        results.append(("[1,6,11] 稀疏流程跑通", ok, f"channels={st['last']['channelsOk'] if st['last'] else None} music={bool(st['last'] and st['last']['music'])}"))
    finally:
        stop(p)
    # 单向退化
    port = a.port + 11
    p = start(port)
    try:
        code, out = sim(port, ["--only", "A", "--scenario", "empty", "--sweeps", "30", "--seed", seed])
        time.sleep(9)   # 主机等另一节点最多 7 秒，超时才按单向处理
        st = requests.get(f"http://127.0.0.1:{port}/api/state?since=0").json()
        ok = code == 0 and st["last"] is not None and st["last"]["mode"] == "one-way" and st["nodes"]["B"]["uploads"] == 0 and st["nodes"]["A"]["online"]
        results.append(("只有 Node A 上传 → 单向退化且 B 显示未上线", ok, f"mode={st['last']['mode'] if st['last'] else None}"))
    finally:
        stop(p)
    # 鉴权 / 坏数据
    port = a.port + 12
    p = start(port)
    try:
        u = f"http://127.0.0.1:{port}"
        r1 = requests.post(u + "/api/ingest", data=b"x" * 40, headers={"X-Radar-Key": "wrong"})
        r2 = requests.post(u + "/api/ingest", data=b"x" * 40, headers={"X-Radar-Key": "radar-key"})
        r3 = requests.post(u + "/api/ingest", data=b"RC\x01\x00\x05\x00\x00\x00" + b"\x00" * 8, headers={"X-Radar-Key": "radar-key"})
        d = requests.get(u + "/api/diag").json()
        names = {x["id"]: x["status"] for x in d["items"]}
        ok = r1.status_code == 401 and r2.status_code == 400 and r3.status_code == 400 and names.get("nodeA") == "fail" and names.get("errors") == "warn"
        results.append(("错误密钥 401 / 坏数据 400 / 诊断提示", ok, f"{r1.status_code},{r2.status_code},{r3.status_code} nodeA={names.get('nodeA')} errors={names.get('errors')}"))
        txt = requests.get(u + "/api/diag.txt").text
        results.append(("/api/diag.txt 可读", "检测日志" in txt and "Node A" in txt, f"{len(txt)} 字符"))
    finally:
        stop(p)
    bad = 0
    for n, ok, d in results:
        print(("PASS " if ok else "FAIL ") + n + "  " + d)
        bad += 0 if ok else 1
    print(f"ROUND seed={seed}: {'ALL PASS' if not bad else str(bad) + ' FAILED'}")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
