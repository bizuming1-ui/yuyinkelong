import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FusedDetector, LinkAnalyzer, type Fused } from "@/lib/tri/features";
import { makeGeometry } from "@/lib/tri/geometry";
import { ParticleFilter } from "@/lib/tri/pf";
import { TriScene, type SceneOptions } from "@/lib/tri/scene";
import { TriHub, loadCustomBrokers, type LinkState, type TriStatus } from "@/lib/tri/hub";
import { NODE_TITLE, TRI_BROKERS, TRI_ROOT } from "@/lib/tri/config";
import type { TriFrame } from "@/lib/tri/protocol";
import { SimPerson, linkW, rng, synthCsi } from "@/lib/tri/sim";

type Mode = "idle" | "live" | "demo";
interface LogItem {
  t: string;
  level: "info" | "warn" | "error";
  msg: string;
}

const LS = { root: "bzm-tri-root", side: "bzm-tri-side", W: "bzm-tri-W", D: "bzm-tri-D", sens: "bzm-tri-sens", brokers: "bzm-tri-brokers" };
const fmtTime = () => new Date().toLocaleTimeString("zh-CN", { hour12: false });

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function lsGet(k: string, d: number, lo: number, hi: number) {
  try {
    const v = parseFloat(localStorage.getItem(k) || "");
    if (v >= lo && v <= hi) return v;
  } catch {
    /* ignore */
  }
  return d;
}

function Btn(props: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "cyan" | "green" | "amber" | "slate" | "rose" }) {
  const { tone = "slate", className = "", ...rest } = props;
  const tones: Record<string, string> = {
    cyan: "bg-cyan-400 text-slate-900 hover:bg-cyan-300",
    green: "bg-emerald-500 text-slate-950 hover:bg-emerald-400",
    amber: "bg-amber-400 text-slate-900 hover:bg-amber-300",
    rose: "bg-rose-500 text-white hover:bg-rose-400",
    slate: "bg-slate-800/90 text-slate-100 hover:bg-slate-700 border border-slate-700",
  };
  return <button {...rest} className={`rounded-lg px-3 py-2 text-sm font-bold whitespace-nowrap transition active:scale-95 ${tones[tone]} ${className}`} />;
}

function Card({ title, children, right }: { title: React.ReactNode; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-800/80 bg-[#071120]/85 p-3 backdrop-blur">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-bold tracking-wide text-slate-200">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

function Bar({ v, max, color }: { v: number; max: number; color: string }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded bg-slate-800">
      <div className="h-full rounded transition-[width] duration-150" style={{ width: `${Math.max(0, Math.min(1, v / max)) * 100}%`, background: color }} />
    </div>
  );
}

const dot = (s: LinkState | undefined) => (s === "online" ? "bg-emerald-400" : s === "connecting" ? "bg-amber-400 animate-pulse" : s === "error" ? "bg-rose-500" : "bg-slate-600");

export default function TriApp() {
  const [analyzers] = useState(() => ({ B: new LinkAnalyzer(2), C: new LinkAnalyzer(3) }));
  const [detector] = useState(() => new FusedDetector());
  const [pf] = useState(() => new ParticleFilter(makeGeometry(0.3), 2600, 20240607));
  const [mode, setMode] = useState<Mode>("idle");
  const [root, setRoot] = useState(TRI_ROOT);
  const [rootDraft, setRootDraft] = useState(TRI_ROOT);
  const [side, setSide] = useState(0.3);
  const [roomW, setRoomW] = useState(6);
  const [roomD, setRoomD] = useState(6);
  const [sens, setSens] = useState(1);
  const [links, setLinks] = useState<Record<string, LinkState>>({});
  const [nodes, setNodes] = useState<Record<number, TriStatus | undefined>>({});
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [showConnect, setShowConnect] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [panel, setPanel] = useState(true);
  const [opts, setOpts] = useState<SceneOptions>({ cloud: true, terrain: true, trail: true, room: true, autoRotate: false });
  const [fps, setFps] = useState(0);
  const [toast, setToast] = useState("");
  const [customUrl, setCustomUrl] = useState("");
  const [, setTick] = useState(0);

  const hubRef = useRef<TriHub | null>(null);
  const sceneRef = useRef<TriScene | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const timers = useRef<ReturnType<typeof setInterval>[]>([]);
  const nodesRef = useRef<Record<number, TriStatus | undefined>>({});
  const fusedRef = useRef<Fused>({ state: "offline", S: 0, conf: 0, quality: 0, reason: "" });
  const lastFrameAt = useRef<Record<number, number>>({ 2: 0, 3: 0 });
  const frameCount = useRef<Record<number, number>>({ 2: 0, 3: 0 });
  const modeRef = useRef<Mode>("idle");
  const lastWin = useRef({ B: 0, C: 0 });
  const wasOnline = useRef<Record<number, boolean>>({});
  const firstData = useRef(false);
  const lastStep = useRef(performance.now());
  const url = useMemo(() => window.location.href.split("#")[0], []);

  const addLog = useCallback((level: LogItem["level"], msg: string) => {
    setLogs((l) => [{ t: fmtTime(), level, msg }, ...l].slice(0, 300));
    if (level !== "info") setUnread((u) => u + 1);
  }, []);
  const say = useCallback((t: string) => {
    setToast(t);
    setTimeout(() => setToast(""), 1800);
  }, []);

  const feed = useCallback(
    (frames: TriFrame[], now: number) => {
      for (const f of frames) {
        const a = f.node === 2 ? analyzers.B : f.node === 3 ? analyzers.C : null;
        if (!a) continue;
        a.pushFrame(f, now);
        lastFrameAt.current[f.node] = now;
        frameCount.current[f.node]++;
      }
    },
    [analyzers],
  );

  const stopAll = useCallback(() => {
    hubRef.current?.disconnect();
    hubRef.current = null;
    timers.current.forEach(clearInterval);
    timers.current = [];
  }, []);

  const startLive = useCallback(
    (r: string) => {
      stopAll();
      firstData.current = false;
      const hub = new TriHub(r, {
        onFrames: (frames, via) => {
          feed(frames, performance.now());
          if (!firstData.current) {
            firstData.current = true;
            addLog("info", `收到 ESP32-${frames[0].node === 2 ? "B" : "C"} 的 CSI 数据（经 ${via}）`);
          }
        },
        onStatus: (s) => {
          nodesRef.current = { ...nodesRef.current, [s.id]: s };
          setNodes(nodesRef.current);
        },
        onLink: (name, state, detail) => {
          setLinks((l) => ({ ...l, [name]: state }));
          if (state === "error") addLog("warn", `MQTT ${name} 错误：${detail ?? ""}`);
        },
        onLog: addLog,
      });
      hubRef.current = hub;
      modeRef.current = "live";
      setMode("live");
      hub.connect().catch((e) => addLog("error", `MQTT 初始化失败：${String(e)}`));
    },
    [addLog, feed, stopAll],
  );

  // ---- SIMULATION：合成 CSI 走与真实数据完全相同的流水线（界面上始终显示 SIMULATION）----
  const startDemo = useCallback(() => {
    stopAll();
    analyzers.B.reset();
    analyzers.C.reset();
    detector.reset();
    const g = makeGeometry(side);
    const person = new SimPerson(roomW, roomD);
    const r = rng(777);
    const t0 = performance.now();
    let cnt = 0;
    const mk = (node: number, csi: Int8Array): TriFrame => {
      const re = new Float32Array(64);
      const im = new Float32Array(64);
      for (let s = 0; s < 64; s++) {
        im[s] = csi[2 * s];
        re[s] = csi[2 * s + 1];
      }
      return { node, boot: 1, paired: true, ch: 6, rssi: -45, noise: -95, seqA: cnt & 0xffff, rxCnt: cnt & 0xffff, tms: 0, droppedTotal: 0, re, im };
    };
    let last = t0;
    timers.current.push(
      setInterval(() => {
        const now = performance.now();
        const n = Math.min(12, Math.max(1, Math.round((now - last) / 10)));
        last = now;
        const t = (now - t0) / 1000;
        const s = person.at(t);
        for (let i = 0; i < n; i++) {
          cnt++;
          const tt = t - (n - 1 - i) * 0.01;
          const fr = [2, 3].map((node) => {
            const w = linkW(g, node === 2 ? "B" : "C", s.x, s.z);
            return mk(node, synthCsi({ rand: r, t: tt, moving: s.moving, pathBase: 0, node, moveAmp: Math.min(0.8, 0.02 + 0.9 * w) }));
          });
          feed(fr, now);
        }
      }, 40),
    );
    const fake = (id: number): TriStatus => ({ id, online: true, fw: "SIMULATION", role: "ABC"[id - 1], rssi: -48, ch: 6, csiOk: true, seenAt: performance.now(), via: "SIMULATION", up: Math.round((performance.now() - t0) / 1000), state: "RUNNING" });
    const pushFake = () => {
      nodesRef.current = { 1: fake(1), 2: fake(2), 3: fake(3) };
      setNodes(nodesRef.current);
    };
    pushFake();
    timers.current.push(setInterval(pushFake, 2000));
    modeRef.current = "demo";
    setMode("demo");
    addLog("info", "SIMULATION 已启动：合成 CSI（空房 8s → 行走 22s → 离开 10s 循环）走与真实数据相同的特征/检测/粒子滤波流水线。这不是真实成像。");
  }, [addLog, analyzers, detector, feed, roomD, roomW, side, stopAll]);

  const applyLayout = useCallback(
    (s: number, W: number, D: number) => {
      pf.setRoom(W, D);
      sceneRef.current?.setLayout(makeGeometry(s), W, D);
    },
    [pf],
  );

  // 挂载 3D 场景
  useEffect(() => {
    if (!boxRef.current) return;
    const sc = new TriScene(boxRef.current, pf);
    sceneRef.current = sc;
    sc.setLayout(makeGeometry(side), roomW, roomD);
    const id = setInterval(() => setFps(sc.fps), 500);
    return () => {
      clearInterval(id);
      sc.dispose();
      sceneRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pf]);

  useEffect(() => {
    if (sceneRef.current) sceneRef.current.opts = opts;
  }, [opts]);
  useEffect(() => {
    detector.sens = sens;
  }, [detector, sens]);

  // 启动：恢复设置 → 自动连接
  useEffect(() => {
    let r = TRI_ROOT;
    try {
      r = localStorage.getItem(LS.root) || TRI_ROOT;
    } catch {
      /* ignore */
    }
    const s = lsGet(LS.side, 0.3, 0.1, 8);
    const W = lsGet(LS.W, 6, 2, 20);
    const D = lsGet(LS.D, 6, 2, 20);
    const se = lsGet(LS.sens, 1, 0.5, 3);
    setSide(s);
    setRoomW(W);
    setRoomD(D);
    setSens(se);
    detector.sens = se;
    pf.geom = makeGeometry(s);
    applyLayout(s, W, D);
    setRoot(r);
    setRootDraft(r);
    startLive(r);
    // 检测 + 粒子滤波循环 20Hz（与渲染解耦；渲染端用平滑/外推保证 60fps 丝滑）
    const t1 = setInterval(() => {
      const now = performance.now();
      const dt = Math.min(0.15, Math.max(0.01, (now - lastStep.current) / 1000));
      lastStep.current = now;
      const mb = analyzers.B.tick(now);
      const mc = analyzers.C.tick(now);
      const f = detector.update(mb, mc, now);
      fusedRef.current = f;
      const okB = mb.valid && now - mb.lastAt < 1500 && mb.rate >= 5;
      const okC = mc.valid && now - mc.lastAt < 1500 && mc.rate >= 5;
      const fresh = (okB && mb.win !== lastWin.current.B) || (okC && mc.win !== lastWin.current.C);
      lastWin.current = { B: mb.win, C: mc.win };
      pf.step(dt, fresh ? { zB: okB ? mb.z : null, zC: okC ? mc.z : null } : { zB: null, zC: null }, f.state === "motion");
      const sc = sceneRef.current;
      if (sc) {
        sc.state = { active: f.state === "motion", conf: f.conf, actB: mb.act, actC: mc.act, simulation: modeRef.current === "demo", noData: f.state === "offline" || f.state === "calibrating" };
      }
    }, 50);
    // UI 刷新 5Hz
    const t2 = setInterval(() => {
      const now = performance.now();
      for (const i of [1, 2, 3]) {
        const st = nodesRef.current[i];
        const on = (!!st && st.online && now - st.seenAt < 15000) || (i > 1 && now - (lastFrameAt.current[i] || 0) < 5000);
        if (wasOnline.current[i] !== undefined && on !== wasOnline.current[i]) addLog(on ? "info" : "warn", `ESP32-${"ABC"[i - 1]} ${on ? "上线" : "离线"}`);
        wasOnline.current[i] = on;
      }
      setTick((x) => x + 1);
    }, 200);
    return () => {
      clearInterval(t1);
      clearInterval(t2);
      stopAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* ignore */
    }
  };

  const f = fusedRef.current;
  const mb = analyzers.B.m;
  const mc = analyzers.C.m;
  const now = performance.now();
  const nodeOn = (i: number) => {
    const st = nodes[i];
    return (!!st && st.online && now - st.seenAt < 15000) || (i > 1 && now - (lastFrameAt.current[i] || 0) < 5000);
  };
  const linkOnlineCount = Object.values(links).filter((s) => s === "online").length;
  const stateText: Record<string, [string, string]> = {
    offline: ["离线 · 无数据", "text-slate-400"],
    calibrating: ["自适应校准中", "text-amber-300"],
    empty: ["未检测到运动", "text-emerald-300"],
    motion: ["检测到运动目标", "text-cyan-300"],
  };
  const [stTxt, stCls] = stateText[f.state];
  const est = pf.est;
  const compact = side < 0.8;
  const paintEst = f.state === "motion";

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[#02060d] text-slate-200">
      <div ref={boxRef} className="absolute inset-0" />

      {/* 左上角标题 */}
      <div className="pointer-events-none absolute top-3 left-3 z-10">
        <div className="text-sm font-bold text-cyan-300 drop-shadow">三 ESP32-S3 · WiFi CSI 三维感知模拟器</div>
        <div className="text-[11px] text-slate-400">A 发射 → B / C 接收 · MQTT 实时 · 概率云（非摄像头式成像）</div>
      </div>

      {/* 右上角按键 */}
      <div className="absolute top-3 right-3 z-20 flex flex-wrap items-center justify-end gap-2">
        <span className="rounded-md bg-black/50 px-2 py-1 text-[11px] text-slate-400">{fps} FPS</span>
        <Btn tone="cyan" onClick={() => setShowConnect(true)}>
          🔌 连接 ESP32
          <span className={`ml-2 inline-block h-2 w-2 rounded-full ${linkOnlineCount > 0 ? "bg-emerald-600" : "bg-slate-500"}`} />
        </Btn>
        <Btn
          onClick={() => {
            setShowLog(true);
            setUnread(0);
          }}
        >
          🩺 检测日志{unread > 0 && <span className="ml-1 rounded-full bg-rose-500 px-1.5 text-[10px] text-white">{unread}</span>}
        </Btn>
        <Btn tone="green" onClick={() => (window.location.hash = "#/code")}>
          📋 复制代码
        </Btn>
      </div>

      {/* SIMULATION 横幅 */}
      {mode === "demo" && (
        <div className="pointer-events-none absolute top-16 left-1/2 z-10 -translate-x-1/2 rounded-full border border-amber-400/60 bg-amber-500/20 px-5 py-1.5 text-sm font-extrabold tracking-widest text-amber-300 backdrop-blur">
          SIMULATION · 合成数据 · 不是真实成像
        </div>
      )}

      {/* 真实模式无数据提示（不播放伪装的默认动画） */}
      {mode === "live" && (f.state === "offline" || f.state === "calibrating") && (
        <div className="pointer-events-none absolute top-1/2 left-1/2 z-10 w-[min(92vw,460px)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-slate-700 bg-black/60 p-4 text-center backdrop-blur">
          <div className={`text-base font-bold ${stCls}`}>{f.state === "offline" ? "等待 ESP32-B / ESP32-C 的 CSI 数据…" : "自适应校准中，请保持环境安静"}</div>
          <div className="mt-1 text-xs text-slate-400">{f.reason}</div>
          {f.state === "offline" && <div className="mt-2 text-[11px] text-slate-500">检查：① 三块板同一 2.4GHz WiFi ② config.h 的 MQTT_ROOT 与「🔌 连接 ESP32」里一致 ③ A 已上电（B/C 只收 A 的探测帧）</div>}
        </div>
      )}

      {/* 侧边栏开关 */}
      <button className="absolute top-14 left-3 z-20 rounded-md bg-slate-900/80 px-2 py-1 text-xs font-bold text-slate-200 backdrop-blur hover:bg-slate-800" onClick={() => setPanel(!panel)}>
        {panel ? "◀ 收起面板" : "▶ 展开面板"}
      </button>

      {panel && (
        <div className="absolute top-24 bottom-3 left-3 z-10 w-[min(92vw,330px)] space-y-2 overflow-y-auto pr-1">
          <Card title="📡 设备（同一 WiFi · MQTT）">
            <div className="space-y-1.5 text-xs">
              {[1, 2, 3].map((i) => {
                const st = nodes[i];
                const on = nodeOn(i);
                const m = i === 2 ? mb : i === 3 ? mc : null;
                return (
                  <div key={i} className="rounded-lg bg-slate-900/70 p-2">
                    <div className="flex items-center gap-2">
                      <span className={`h-2.5 w-2.5 rounded-full ${on ? "bg-emerald-400" : "bg-slate-600"}`} />
                      <span className="font-bold text-slate-100">{NODE_TITLE[i]}</span>
                      <span className="ml-auto text-slate-500">{on ? "在线" : "离线"}</span>
                    </div>
                    {(st || m) && (
                      <div className="mt-1 grid grid-cols-3 gap-x-2 text-[11px] text-slate-400">
                        <span>RSSI {st?.rssi ?? m?.rssi ?? "—"}</span>
                        <span>信道 {st?.ch ?? "—"}</span>
                        <span>固件 {st?.fw ?? "—"}</span>
                        {m && (
                          <>
                            <span>{m.rate.toFixed(0)} 包/s</span>
                            <span>配对 {(m.pairedPct * 100).toFixed(0)}%</span>
                            <span>缺失 {(m.lossPct * 100).toFixed(1)}%</span>
                          </>
                        )}
                        {i === 1 && st && (
                          <>
                            <span>发射 {st.nowTx ?? 0}</span>
                            <span>失败 {st.nowTxFail ?? 0}</span>
                            <span>seq {st.seqA ?? 0}</span>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>

          <Card title="🩺 检测（B / C 独立分析 → 非相干特征融合）" right={<span className="text-[10px] text-slate-500">置信度 {(f.conf * 100).toFixed(0)}%</span>}>
            <div className={`text-base font-extrabold ${stCls}`}>{stTxt}</div>
            <div className="mb-2 text-[11px] text-slate-500">{f.reason}</div>
            <div className="space-y-1.5 text-[11px] text-slate-400">
              <div>
                融合分数 S = {f.S.toFixed(1)}（阈值 {(3.2 / sens).toFixed(1)}）
                <Bar v={f.S} max={12} color="linear-gradient(90deg,#22d3ee,#a78bfa)" />
              </div>
              <div>
                A→B 运动 z = {mb.valid ? mb.z.toFixed(1) : "—"}
                <Bar v={mb.valid ? mb.act : 0} max={12} color="#14b8a6" />
              </div>
              <div>
                A→C 运动 z = {mc.valid ? mc.z.toFixed(1) : "—"}
                <Bar v={mc.valid ? mc.act : 0} max={12} color="#14b8a6" />
              </div>
              <div>数据质量 {(f.quality * 100).toFixed(0)}%</div>
            </div>
          </Card>

          <Card title="📍 位置估计（概率云）">
            {paintEst ? (
              <div className="space-y-1 text-xs text-slate-300">
                <div>
                  x = {est.x.toFixed(2)} m，z = {est.z.toFixed(2)} m（相对阵列质心）
                </div>
                <div>
                  不确定度 ± {est.spread.toFixed(2)} m · 有效粒子 {est.ess.toFixed(0)}
                </div>
                <div className="text-[11px] text-amber-300/90">这是估计（模型推断），不是测量。高度方向不可观测，云的高度只是先验。</div>
              </div>
            ) : (
              <div className="text-xs text-slate-500">无运动目标时不显示位置（不会用默认动画冒充）。</div>
            )}
            {compact && <div className="mt-2 rounded-lg border border-amber-500/40 bg-amber-950/30 p-2 text-[11px] text-amber-200">阵列边长 {side.toFixed(2)}m 很小：只能判断「有无运动 / 强弱 / 粗略方位」。要得到更像样的位置云，请把 A/B/C 拉开到 ≥2m，并把下方「阵列边长」改成实际值。</div>}
          </Card>

          <Card title="⚙️ 设置（几何必须按实测填写）">
            <div className="space-y-2 text-xs text-slate-300">
              <label className="block">
                阵列边长（天线中心距）：{side.toFixed(2)} m
                <input
                  type="range"
                  min={0.1}
                  max={6}
                  step={0.05}
                  value={side}
                  className="w-full"
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    setSide(v);
                    save(LS.side, String(v));
                    applyLayout(v, roomW, roomD);
                  }}
                />
              </label>
              <label className="block">
                房间宽 X：{roomW} m
                <input
                  type="range"
                  min={2}
                  max={14}
                  step={0.5}
                  value={roomW}
                  className="w-full"
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    setRoomW(v);
                    save(LS.W, String(v));
                    applyLayout(side, v, roomD);
                  }}
                />
              </label>
              <label className="block">
                房间深 Z：{roomD} m
                <input
                  type="range"
                  min={2}
                  max={14}
                  step={0.5}
                  value={roomD}
                  className="w-full"
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    setRoomD(v);
                    save(LS.D, String(v));
                    applyLayout(side, roomW, v);
                  }}
                />
              </label>
              <label className="block">
                检测灵敏度：{sens.toFixed(1)}
                <input
                  type="range"
                  min={0.5}
                  max={3}
                  step={0.1}
                  value={sens}
                  className="w-full"
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    setSens(v);
                    save(LS.sens, String(v));
                  }}
                />
              </label>
              <div className="grid grid-cols-2 gap-1.5">
                {(
                  [
                    ["cloud", "粒子云"],
                    ["terrain", "占据地形"],
                    ["trail", "轨迹"],
                    ["room", "房间标尺"],
                    ["autoRotate", "自动旋转"],
                  ] as const
                ).map(([k, n]) => (
                  <label key={k} className="flex items-center gap-1.5">
                    <input type="checkbox" checked={opts[k]} onChange={(e) => setOpts({ ...opts, [k]: e.target.checked })} /> {n}
                  </label>
                ))}
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Btn className="!px-2 !py-1 text-xs" onClick={() => sceneRef.current?.resetView()}>
                  复位视角
                </Btn>
                <Btn className="!px-2 !py-1 text-xs" onClick={() => sceneRef.current?.topView()}>
                  俯视
                </Btn>
                <Btn
                  className="!px-2 !py-1 text-xs"
                  onClick={() => {
                    analyzers.B.reset();
                    analyzers.C.reset();
                    detector.reset();
                    say("已重新校准，请保持安静 8 秒");
                  }}
                >
                  重新校准
                </Btn>
              </div>
              <div className="text-[10px] text-slate-500">鼠标：左键旋转 · 右键平移 · 滚轮缩放 · 触屏双指缩放</div>
            </div>
          </Card>

          <Card title="🌐 网址 / 代码 / 演示">
            <div className="space-y-2 text-xs">
              <div className="flex items-center gap-1.5">
                <code className="min-w-0 flex-1 truncate rounded bg-slate-900 px-2 py-1 text-[11px] text-cyan-200" title={url}>
                  {url}
                </code>
                <Btn className="!px-2 !py-1 text-xs" onClick={async () => say((await copyText(url)) ? "已复制网址" : "复制失败")}>
                  复制
                </Btn>
              </div>
              <Btn tone="green" className="w-full" onClick={() => (window.location.hash = "#/code")}>
                进入复制代码界面
              </Btn>
              {mode === "demo" ? (
                <Btn tone="amber" className="w-full" onClick={() => startLive(root)}>
                  ■ 停止 SIMULATION，回到真实设备
                </Btn>
              ) : (
                <Btn className="w-full" onClick={startDemo}>
                  ▶ 启动 SIMULATION 演示（合成数据）
                </Btn>
              )}
              <a className="block text-center text-[11px] text-slate-500 underline" href="#/legacy">
                打开旧版双节点模拟器（保留）
              </a>
            </div>
          </Card>
        </div>
      )}

      {/* 连接窗口 */}
      {showConnect && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/60 p-3" onClick={() => setShowConnect(false)}>
          <div className="max-h-[92vh] w-[min(96vw,620px)] overflow-y-auto rounded-2xl border border-slate-700 bg-[#0b1322] p-4" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-bold text-cyan-300">🔌 连接 ESP32（MQTT over WSS）</h2>
              <Btn className="!px-2 !py-1" onClick={() => setShowConnect(false)}>
                ✕
              </Btn>
            </div>
            <p className="mb-3 text-xs leading-relaxed text-slate-400">三块 ESP32 上电并连上同一个 2.4GHz WiFi 后，会自动把状态/CSI 发布到公共 MQTT 服务器。本页面同时连接下面全部服务器并合并数据，任意一个断线都不会中断。公共服务器仅用于连通与演示；长期/隐私场景请改用自己的 Broker（可在下方追加 WSS 地址）。</p>
            <label className="mb-1 block text-xs text-slate-400">主题根（必须与固件 config.h 的 MQTT_ROOT 一致）</label>
            <div className="mb-3 flex gap-2">
              <input value={rootDraft} onChange={(e) => setRootDraft(e.target.value.trim())} className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-[#0f1a2c] px-3 py-2 font-mono text-xs outline-none" />
              <Btn
                tone="cyan"
                onClick={() => {
                  const r = rootDraft || TRI_ROOT;
                  setRoot(r);
                  save(LS.root, r);
                  startLive(r);
                  say("已按新主题根重连");
                }}
              >
                连接 / 重连
              </Btn>
              <Btn
                onClick={() => {
                  stopAll();
                  modeRef.current = "idle";
                  setMode("idle");
                  say("已断开");
                }}
              >
                断开
              </Btn>
            </div>
            <div className="mb-3 space-y-1">
              {[...TRI_BROKERS, ...loadCustomBrokers()].map((b) => (
                <div key={b.name + b.url} className="flex items-center gap-2 rounded-lg bg-slate-900/70 px-3 py-1.5 text-xs">
                  <span className={`h-2.5 w-2.5 rounded-full ${dot(links[b.name])}`} />
                  <span className="w-20 font-bold">{b.name}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-500">{b.url}</span>
                  <span className="text-slate-400">{links[b.name] ?? "idle"}</span>
                </div>
              ))}
              <div className="flex gap-2 pt-1">
                <input value={customUrl} onChange={(e) => setCustomUrl(e.target.value.trim())} placeholder="自定义 Broker：wss://你的服务器:8084/mqtt" className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-[#0f1a2c] px-3 py-1.5 text-xs outline-none" />
                <Btn
                  className="!py-1.5 text-xs"
                  onClick={() => {
                    if (!/^wss?:\/\//.test(customUrl)) return say("地址必须以 wss:// 或 ws:// 开头");
                    const arr = [...loadCustomBrokers(), { name: `自定义${loadCustomBrokers().length + 1}`, url: customUrl, tcp: "" }];
                    save(LS.brokers, JSON.stringify(arr));
                    setCustomUrl("");
                    startLive(root);
                    say("已添加并重连");
                  }}
                >
                  追加
                </Btn>
              </div>
            </div>
            <div className="mb-3 space-y-1">
              {[1, 2, 3].map((i) => {
                const st = nodes[i];
                const on = nodeOn(i);
                return (
                  <div key={i} className="flex items-center gap-2 rounded-lg bg-slate-900/70 px-3 py-1.5 text-xs">
                    <span className={`h-2.5 w-2.5 rounded-full ${on ? "bg-emerald-400" : "bg-slate-600"}`} />
                    <span className="font-bold">{NODE_TITLE[i]}</span>
                    <span className="ml-auto text-slate-400">{on ? `在线 · ${st?.state ?? ""} · 经 ${st?.via ?? "—"} · 运行 ${st?.up ?? 0}s` : "离线"}</span>
                  </div>
                );
              })}
            </div>
            <div className="flex flex-wrap gap-2">
              <Btn onClick={() => hubRef.current?.sendCmd("hello")}>询问状态</Btn>
              <Btn tone="rose" onClick={() => hubRef.current?.sendCmd("reboot") ?? say("未连接")}>
                重启三块 ESP32
              </Btn>
              <Btn tone="green" onClick={() => (window.location.hash = "#/code")}>
                进入复制代码界面
              </Btn>
            </div>
          </div>
        </div>
      )}

      {/* 日志窗口 */}
      {showLog && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/60 p-3" onClick={() => setShowLog(false)}>
          <div className="max-h-[85vh] w-[min(96vw,640px)] overflow-hidden rounded-2xl border border-slate-700 bg-[#0b1322] p-4" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-base font-bold text-cyan-300">🩺 检测日志</h2>
              <div className="flex gap-2">
                <Btn className="!px-2 !py-1 text-xs" onClick={async () => say((await copyText(logs.map((l) => `${l.t} [${l.level}] ${l.msg}`).join("\n"))) ? "已复制日志" : "复制失败")}>
                  复制日志
                </Btn>
                <Btn className="!px-2 !py-1" onClick={() => setShowLog(false)}>
                  ✕
                </Btn>
              </div>
            </div>
            <div className="max-h-[70vh] space-y-0.5 overflow-y-auto font-mono text-[11px]">
              {logs.length === 0 && <div className="text-slate-500">暂无日志</div>}
              {logs.map((l, i) => (
                <div key={i} className={l.level === "error" ? "text-rose-300" : l.level === "warn" ? "text-amber-300" : "text-slate-300"}>
                  {l.t} {l.msg}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {toast && <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-emerald-500 px-5 py-2 text-sm font-bold text-slate-950 shadow-xl">{toast}</div>}
    </div>
  );
}
