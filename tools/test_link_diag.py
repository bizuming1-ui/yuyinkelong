#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
v10 链路分层诊断回归：用 curl 风格的“心跳”模拟 A 上报不同的 lnk 计数，检查主机 /api/diag 里「ESP-NOW 链路」是否给出正确的层级结论。
用法：python3 tools/test_link_diag.py [--port 8300]
"""
import argparse, os, struct, subprocess, sys, time, signal
import requests

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def start(port):
    env = dict(os.environ, RADAR_NO_TUNNEL="1", RADAR_PORT=str(port), RADAR_RAW_DIR=f"/tmp/rr_l{port}")
    p = subprocess.Popen([sys.executable, os.path.join(ROOT, "kaggle", "csi_radar_kaggle.py")], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, preexec_fn=os.setsid)
    for _ in range(60):
        try:
            if requests.get(f"http://127.0.0.1:{port}/api/health", timeout=1).ok:
                return p
        except Exception:
            time.sleep(0.25)
    raise SystemExit("server did not start")


def hello(port, node, info, boot=1234):
    body = struct.pack("<2sBBHHII", b"RC", 1, node, 0, boot, 5000, 0)
    return requests.post(f"http://127.0.0.1:{port}/api/ingest", data=body, headers={"X-Radar-Key": "radar-key", "X-Radar-Info": info}, timeout=5)


def link_item(port):
    d = requests.get(f"http://127.0.0.1:{port}/api/diag", timeout=5).json()
    for it in d["items"]:
        if it["id"] == "link":
            return it
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8300)
    a = ap.parse_args()
    cases = [
        ("第1层 B 从未应答", "sync:0/5,probe:0,reply:0,csi:0,data:0,stat:0,txerr:0", "fail", "第 1 层"),
        ("第2层 B 不回复", "sync:3/3,probe:200,reply:0,csi:0,data:0,stat:4,txerr:0", "fail", "第 2 层"),
        ("第3层 CSI 没触发", "sync:3/3,probe:200,reply:150,csi:0,data:0,stat:4,txerr:0", "fail", "第 3 层"),
        ("第4层 B 的数据没回来", "sync:3/3,probe:200,reply:150,csi:140,data:0,stat:4,txerr:0", "warn", "第 4 层"),
        ("全部正常", "sync:5/5,probe:400,reply:380,csi:370,data:360,stat:9,txerr:0", "ok", "成功率"),
    ]
    p = start(a.port)
    bad = 0
    try:
        for nm, lnk, st, key in cases:
            info = f"fw=10.0.0;mac=AA;rssi=-30;ch=6;ip=1.2.3.4;plan=13;seen=100;kept=50;lerr=0;rst=BROWNOUT(power);last=https-post;lnk={lnk};pwr=15"
            r = hello(a.port, 0, info)
            it = link_item(a.port)
            good = r.ok and it and it["status"] == st and key in it["detail"]
            bad += 0 if good else 1
            print(("PASS " if good else "FAIL ") + nm, "|", (it or {}).get("status"), (it or {}).get("detail", "")[:90])
        d = requests.get(f"http://127.0.0.1:{a.port}/api/diag", timeout=5).json()
        ev = " ".join(e["msg"] for e in d["events"])
        g = "BROWNOUT" in ev
        bad += 0 if g else 1
        print(("PASS " if g else "FAIL ") + "复位原因事件(欠压提示)", "|", [e["msg"][:80] for e in d["events"] if "复位" in e["msg"]][:1])
        nodeA = [i for i in d["items"] if i["id"] == "nodeA"][0]["detail"]
        g = "链路 sync" in nodeA
        bad += 0 if g else 1
        print(("PASS " if g else "FAIL ") + "Node A 详情含链路计数")
    finally:
        os.killpg(os.getpgid(p.pid), signal.SIGTERM)
    print("结果:", "全部通过" if bad == 0 else f"{bad} 项失败")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
