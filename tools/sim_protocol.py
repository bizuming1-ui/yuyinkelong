#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ESP-NOW 跳频协议逻辑仿真（无硬件）——把固件里 A / B 的状态机逐行翻译成 Python 协程，放在“有丢包、有上传耗时、B 随机上电”的介质上跑。
用途：验证 v10 的会合 / 跟随 / 找回逻辑（SCAN→FOLLOW→WAIT→SCAN）在各种丢包率、上传耗时、B 晚上电、B 中途断电下都能持续出数据。
注意：这只验证【协议逻辑】。射频层（ESP-NOW 是否真的收到、CSI 回调是否触发）只能在真板子上验证，板子会把各层计数通过
      X-Radar-Info 的 lnk= 字段发到 Kaggle，网页「检测日志」里的「ESP-NOW 链路」一项会指出哪一层不通。

运行：python3 tools/sim_protocol.py            （默认 3 个随机种子 × 4 种场景，全部达标才返回 0）
      python3 tools/sim_protocol.py --legacy   （同时跑 v9 协议作对比）
"""
import argparse, heapq, random, sys

NPLAN, EXCH, SWEEPS, DWELL, GAP = 13, 8, 3, 55, 5
SYNC_WAIT, B_WAIT, SCAN_DWELL, HELLO = 6000, 25000, 120, 30000


class Sim:
    def __init__(self, seed, loss, up_ms, b_boot, b_cut=None, router_ch=6, legacy=False):
        self.r = random.Random(seed)
        self.loss, self.up_ms, self.legacy = loss, up_ms, legacy
        self.t = 0.0
        self.q = []
        self.n = 0
        self.router = router_ch
        self.b_boot, self.b_cut = b_boot, b_cut
        # A
        self.A = dict(ch=1, home=1, ack=False, rep=None, expect=None, bufA=[], bufB=[], up=0, syncok=0, syncfail=0, last_hello=-1e9, uploads=[])
        # B
        self.B = dict(ch=0, state="OFF", home=1, last_rx=0, peer=False, lost=0, syncs=0, data=0, bufB=[], last_up=-1e9, uploading=False, ready_since=0)
        self.pairs = 0
        self.first_sync = None
        self.sweeps_done = 0

    # ---- 调度 ----
    def spawn(self, gen, at=0.0):
        self.n += 1
        heapq.heappush(self.q, (at, self.n, gen))

    def run(self, until):
        while self.q and self.q[0][0] <= until:
            at, _, gen = heapq.heappop(self.q)
            self.t = at
            try:
                d = next(gen)
            except StopIteration:
                continue
            self.n += 1
            heapq.heappush(self.q, (self.t + max(d, 0.0), self.n, gen))

    def ok(self):
        return self.r.random() >= self.loss

    def up_time(self):
        return self.r.uniform(*self.up_ms)

    # ---- 介质 ----
    def a_send(self, f):
        B = self.B
        if B["state"] in ("OFF", "UPLOAD") or B["ch"] != self.A["ch"] or not self.ok():
            return
        self.b_recv(f)

    def b_send(self, f):
        A = self.A
        if A["ch"] != self.B["ch"] or not self.ok():
            return
        self.a_recv(f)

    def a_recv(self, f):
        A = self.A
        if f["t"] == "ACK":
            A["ack"] = True
        elif f["t"] == "REPLY" and A["expect"] == (f["sweep"], f["seq"]):
            A["rep"] = f
        elif f["t"] == "DATA":
            A["bufB"].append((f["sweep"], f["ch"], f["seq"]))
        elif f["t"] == "STAT":
            A["stat"] = self.t

    def b_recv(self, f):
        B = self.B
        t = f["t"]
        if t == "SYNC":
            if self.legacy and B["state"] != "READY":
                return
            B.update(peer=True, home=f["home"], ch=B["ch"], last_rx=self.t, state="FOLLOW")
            B["syncs"] += 1
            self.a_recv({"t": "ACK"}) if self.ok() else None
        elif t == "HOP" and B["state"] == "FOLLOW":
            B["ch"] = f["ch"]
            B["last_rx"] = self.t
        elif t == "PROBE" and B["state"] == "FOLLOW" and f["ch"] == B["ch"]:
            B["last_rx"] = self.t
            self.b_send({"t": "REPLY", "sweep": f["sweep"], "seq": f["seq"]})
            if self.legacy:
                B["bufB"].append((f["sweep"], f["ch"], f["seq"]))
            elif self.ok() or self.ok():      # 单播有 MAC 层重传
                self.b_send({"t": "DATA", "sweep": f["sweep"], "ch": f["ch"], "seq": f["seq"]})
        elif t == "HOME" and B["state"] == "FOLLOW":
            if self.legacy:
                B["state"], B["ch"] = "UPLOAD", f["home"]
            else:
                B.update(state="WAIT", ch=f["home"], home=f["home"], last_rx=self.t)

    # ---- Node A（v9 与 v10 的 A 相同，区别只在 homeUpload 里要不要带 B 的数据） ----
    def a_proc(self):
        A = self.A
        while True:
            if A["bufA"] or A["bufB"] or self.t - A["last_hello"] > HELLO:
                yield self.up_time()                      # 连路由器 + HTTPS 上传
                A["ch"] = A["home"] = self.router
                A["uploads"].append((self.t, len(A["bufA"]), len(A["bufB"])))
                A["bufA"], A["bufB"] = [], []
                A["last_hello"] = self.t
            A["ch"] = A["home"]
            A["ack"] = False
            t0 = self.t
            sync_wait = 10000 if self.legacy else SYNC_WAIT
            while self.t - t0 < sync_wait and not A["ack"]:
                self.a_send({"t": "SYNC", "home": A["home"]})
                yield 24
            if not A["ack"]:
                A["syncfail"] += 1
                continue
            A["syncok"] += 1
            if self.first_sync is None:
                self.first_sync = self.t
            yield 40
            for s in range(SWEEPS):
                sw = A["syncok"] * 10 + s
                for i in range(NPLAN):
                    ch = i + 1
                    tc = self.t
                    for _ in range(3):
                        self.a_send({"t": "HOP", "ch": ch})
                        yield 2
                    A["ch"] = ch
                    yield 3
                    t1 = self.t
                    for q in range(EXCH):
                        A["rep"], A["expect"] = None, (sw, q)
                        self.a_send({"t": "PROBE", "sweep": sw, "ch": ch, "seq": q})
                        if A["rep"]:
                            A["bufA"].append((sw, ch, q))
                        yield max(t1 + (q + 1) * GAP - self.t, 0)
                    yield max(DWELL - (self.t - tc), 0)
                self.sweeps_done += 1
            for _ in range(3):
                self.a_send({"t": "HOME", "home": A["home"]})
                yield 3
            A["ch"] = A["home"]
            if self.legacy:                                # v9：B 自己上传自己的数据，A 看不到
                pass
            # 统计这一批的配对
            yield 0

    # ---- Node B ----
    def b_proc(self):
        B = self.B
        yield self.b_boot
        B["state"] = "UPLOAD" if self.legacy else "SCAN"
        B["ch"] = 1 if not self.legacy else 1
        scan_ch = 0
        while True:
            if self.b_cut and self.b_cut[0] <= self.t < self.b_cut[1]:   # B 断电一段时间
                B["state"], B["ch"] = "OFF", 0
                yield self.b_cut[1] - self.t
                B["state"], B["ch"] = ("UPLOAD" if self.legacy else "SCAN"), 1
                continue
            st = B["state"]
            if self.legacy:
                if st == "UPLOAD":
                    if B["bufB"] or self.t - B["last_up"] > HELLO:
                        yield self.up_time()
                        B["home"] = self.router
                        self.pairs += len(B["bufB"])
                        B["bufB"] = []
                        B["last_up"] = self.t
                    B["ch"] = B["home"]
                    B["state"], B["ready_since"] = "READY", self.t
                elif st == "READY":
                    if self.t - B["ready_since"] > 4000:
                        for c in range(1, 14):
                            if B["state"] != "READY":
                                break
                            B["ch"] = c
                            yield 120
                        if B["state"] == "READY":
                            B["ch"] = B["home"]
                        B["ready_since"] = self.t
                    else:
                        yield 5
                elif st == "FOLLOW":
                    if self.t - B["last_rx"] > 400:
                        B["lost"] += 1
                        B["ch"], B["state"] = B["home"], "UPLOAD"
                    else:
                        yield 5
                else:
                    yield 5
                continue
            if st == "SCAN":
                scan_ch = scan_ch % 13 + 1
                B["ch"] = scan_ch
                for _ in range(SCAN_DWELL // 5):
                    if B["state"] != "SCAN":
                        break
                    yield 5
            elif st == "WAIT":
                if self.t - B["last_rx"] > B_WAIT:
                    B["state"] = "SCAN"
                else:
                    yield 5
            elif st == "FOLLOW":
                if self.t - B["last_rx"] > 400:
                    B["lost"] += 1
                    B.update(state="WAIT", ch=B["home"], last_rx=self.t)
                else:
                    yield 5
            else:
                yield 5


def scenario(name, seed, legacy, minutes=10, **kw):
    s = Sim(seed, legacy=legacy, **kw)
    s.spawn(s.a_proc(), 0)
    s.spawn(s.b_proc(), 0)
    s.run(minutes * 60 * 1000.0)
    A = s.A
    up = A["uploads"]
    nB = sum(u[2] for u in up)
    nA = sum(u[1] for u in up)
    # v9：B 的记录由 B 自己上传（s.pairs）；v10：由 A 转发（nB）
    dB = s.pairs if legacy else nB
    full = SWEEPS * NPLAN * EXCH
    return dict(name=name, seed=seed, first_sync=s.first_sync, syncok=A["syncok"], syncfail=A["syncfail"], recsA=nA, recsB=dB,
                sweeps=s.sweeps_done, lost=s.B["lost"], rate=(min(nA, dB) / (s.sweeps_done / SWEEPS * full)) if s.sweeps_done else 0.0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--legacy", action="store_true")
    ap.add_argument("--seeds", type=int, nargs="*", default=[1, 2, 3])
    a = ap.parse_args()
    cases = [
        ("理想(丢包2%, 上传2~5s, B同时上电)", dict(loss=0.02, up_ms=(2000, 5000), b_boot=0)),
        ("B 晚 47 秒上电", dict(loss=0.02, up_ms=(2000, 5000), b_boot=47000)),
        ("手机热点(丢包8%, 上传3~12s)", dict(loss=0.08, up_ms=(3000, 12000), b_boot=3000)),
        ("B 中途断电 60~110 秒 + 丢包15%", dict(loss=0.15, up_ms=(2000, 8000), b_boot=0, b_cut=(60000, 110000))),
    ]
    bad = 0
    for legacy in ([False, True] if a.legacy else [False]):
        print(f"\n=== {'v9 旧协议（对比）' if legacy else 'v10 新协议'} ===")
        for nm, kw in cases:
            for sd in a.seeds:
                r = scenario(nm, sd, legacy, **kw)
                good = r["syncok"] >= 10 and r["recsA"] > 500 and r["recsB"] > 500 and r["rate"] > 0.5
                if not legacy and not good:
                    bad += 1
                print(f"{'PASS' if good else 'FAIL'} {nm:34s} seed={sd} 首次同步={None if r['first_sync'] is None else round(r['first_sync']/1000,1)}s "
                      f"同步成功/失败={r['syncok']}/{r['syncfail']} 扫描轮={r['sweeps']} 上传记录 A={r['recsA']} B={r['recsB']} 有效率={r['rate']:.0%} B丢同步={r['lost']}")
    print("\n结论：", "全部场景达标 ✅" if bad == 0 else f"{bad} 个场景未达标 ❌")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
