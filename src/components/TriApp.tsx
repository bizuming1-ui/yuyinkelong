import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FusedDetector, LinkAnalyzer, type Fused } from "@/lib/tri/features";
import { makeGeometry } from "@/lib/tri/geometry";
import { ParticleFilter } from "@/lib/tri/pf";
import { Imager25D, type GridEstimate } from "@/lib/tri/imager25d";
import { TriScene, type SceneOptions } from "@/lib/tri/scene";
import { PassageEngine } from "@/lib/tri/passage";
import PassageView from "@/components/PassageView";
import { TriHub, loadCustomBrokers, type LinkState, type TriStatus } from "@/lib/tri/hub";
import { NODE_TITLE, TRI_BROKERS, TRI_ROOT } from "@/lib/tri/config";
import type { TriFrame } from "@/lib/tri/protocol";
import { PAGES_URL } from "@/lib/config";
import { SimMix, linkW, rng, synthCsi } from "@/lib/tri/sim";

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

async function downloadStandaloneSimulator(): Promise<boolean> {
  try {
    let htmlText = "";
    try {
      const res = await fetch("/standalone-simulator.html", { cache: "no-store" });
      if (res.ok) {
        const t = await res.text();
        if (t.includes("<html") && t.length > 50_000) htmlText = t;
      }
    } catch {
      /* ignore */
    }
    if (!htmlText) {
      htmlText = "<!doctype html>\n" + document.documentElement.outerHTML;
    }
    const blob = new Blob([htmlText], { type: "text/html;charset=utf-8" });
    const u = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = u;
    a.download = "esp32s3-tri-2.5d-simulator.html";
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 60_000);
    return true;
  } catch {
    return false;
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
  const [pf] = useState(() => new ParticleFilter(makeGeometry(0.25), 2600, 20240607));
  const [imager] = useState(() => new Imager25D(makeGeometry(0.25), 6, 6, 64));
  const [passage] = useState(() => new PassageEngine(makeGeometry(0.25), 6, 6));
  const [view, setView] = useState<"passage" | "tomo">(() => {
    try {
      return localStorage.getItem("bzm.tri.view") === "tomo" ? "tomo" : "passage";
    } catch {
      return "passage";
    }
  });
  const [mode, setMode] = useState<Mode>("idle");
  const [root, setRoot] = useState(TRI_ROOT);
  const [rootDraft, setRootDraft] = useState(TRI_ROOT);
  const [side, setSide] = useState(0.25);
  const [roomW, setRoomW] = useState(6);
  const [roomD, setRoomD] = useState(6);
  const [sens, setSens] = useState(1.2);
  const [links, setLinks] = useState<Record<string, LinkState>>({});
  const [nodes, setNodes] = useState<Record<number, TriStatus | undefined>>({});
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [showConnect, setShowConnect] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [panel, setPanel] = useState(true);
  const [opts, setOpts] = useState<SceneOptions>({ cloud: true, terrain: true, trail: true, room: true, autoRotate: false, surface: true, contour: true, marker: true });
  const [fps, setFps] = useState(0);
  const [toast, setToast] = useState("");
  const [customUrl, setCustomUrl] = useState("");
  const [, setTick] = useState(0);
  const [kg, setKg] = useState<{ gpu: string[]; up: number; msgs: number; ver: string } | null>(null);

  const hubRef = useRef<TriHub | null>(null);
  const sceneRef = useRef<TriScene | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const timers = useRef<ReturnType<typeof setInterval>[]>([]);
  const nodesRef = useRef<Record<number, TriStatus | undefined>>({});
  const gridRef = useRef<GridEstimate | null>(null);
  const fusedRef = useRef<Fused>({ state: "offline", S: 0, staticS: 0, hasStaticObject: false, crossCorr: 0, conf: 0, quality: 0, reason: "" });
  const lastFrameAt = useRef<Record<number, number>>({ 2: 0, 3: 0 });
  const frameCount = useRef<Record<number, number>>({ 2: 0, 3: 0 });
  const modeRef = useRef<Mode>("idle");
  const lastWin = useRef({ B: 0, C: 0 });
  const wasOnline = useRef<Record<number, boolean>>({});
  const firstData = useRef(false);
  const lastStep = useRef(performance.now());
  const url = useMemo(() => (typeof window !== "undefined" ? window.location.href.split("#")[0] : ""), []);

  const addLog = useCallback((level: LogItem["level"], msg: string) => {
    setLogs((l) => [{ t: fmtTime(), level, msg }, ...l].slice(0, 300));
    if (level !== "info") setUnread((u) => u + 1);
  }, []);
  const say = useCallback((t: string) => {
    setToast(t);
    setTimeout(() => setToast(""), 2000);
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
          if (state === "error") addLog("warn", `MQTT ${name} 波动：${detail ?? ""}（其余并联通道保持零断连）`);
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

  // ---- SIMULATION：合成 CSI 走与真实数据完全相同的流水线 ----
  const startDemo = useCallback(() => {
    stopAll();
    analyzers.B.reset();
    analyzers.C.reset();
    detector.reset();
    imager.reset();
    passage.reset();
    const g = makeGeometry(side);
    const person = new SimMix(roomW, roomD);
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
    const fake = (id: number): TriStatus => ({
      id,
      online: true,
      fw: "SIMULATION",
      role: "ABC"[id - 1],
      rssi: -46,
      ch: 6,
      csiOk: true,
      seenAt: performance.now(),
      via: "SIMULATION",
      up: Math.round((performance.now() - t0) / 1000),
      state: "RUNNING",
      nowTx: cnt,
      paired: cnt,
      unpaired: 0,
      drop: 0,
    });
    const pushFake = () => {
      nodesRef.current = { 1: fake(1), 2: fake(2), 3: fake(3) };
      setNodes(nodesRef.current);
    };
    pushFake();
    timers.current.push(setInterval(pushFake, 2000));
    modeRef.current = "demo";
    setMode("demo");
    addLog("info", "SIMULATION 演示已启动：合成 CSI 经完整特征/检测/2.5D层析/粒子滤波流水线实时运行。");
  }, [addLog, analyzers, detector, feed, imager, passage, roomD, roomW, side, stopAll]);

  const applyLayout = useCallback(
    (s: number, W: number, D: number) => {
      pf.setRoom(W, D);
      imager.setLayout(makeGeometry(s), W, D);
      passage.setLayout(makeGeometry(s), W, D);
      sceneRef.current?.setLayout(makeGeometry(s), W, D);
    },
    [pf, imager, passage],
  );

  // 挂载 3D 场景
  useEffect(() => {
    if (!boxRef.current) return;
    const sc = new TriScene(boxRef.current, pf);
    sceneRef.current = sc;
    sc.setLayout(makeGeometry(side), roomW, roomD);
    sc.attachImager(imager);
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

  // Kaggle 托管或全栈后端轮询 /api/health
  useEffect(() => {
    if (!/^https?:$/.test(window.location.protocol)) return;
    let alive = true;
    const poll = async () => {
      try {
        const ctl = new AbortController();
        const to = setTimeout(() => ctl.abort(), 4000);
        const r = await fetch("/api/health", { cache: "no-store", signal: ctl.signal });
        clearTimeout(to);
        const j = await r.json();
        if (alive && j && j.ok && j.gpu) setKg({ gpu: j.gpu?.names ?? [], up: j.uptime ?? 0, msgs: j.stats?.msgs ?? 0, ver: typeof j.version === "string" ? j.version : "" });
      } catch {
        if (alive) setKg(null);
      }
    };
    poll();
    const id = setInterval(poll, 8000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // 启动：恢复设置 → 自动连接
  useEffect(() => {
    let r = TRI_ROOT;
    try {
      r = localStorage.getItem(LS.root) || TRI_ROOT;
    } catch {
      /* ignore */
    }
    const s = lsGet(LS.side, 0.25, 0.1, 8);
    const W = lsGet(LS.W, 6, 2, 20);
    const D = lsGet(LS.D, 6, 2, 20);
    const se = lsGet(LS.sens, 1.2, 0.5, 3);
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
    // 检测 + 2.5D 层析 + 粒子滤波循环 20Hz（渲染端 60fps 插值平滑）
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
      const obs = fresh
        ? {
            zB: okB ? mb.z : null,
            zC: okC ? mc.z : null,
            staticB: okB ? mb.staticZ : null,
            staticC: okC ? mc.staticZ : null,
            crossCorr: f.crossCorr,
          }
        : { zB: null, zC: null };
      pf.step(dt, { zB: obs.zB, zC: obs.zC }, f.state === "motion" || f.hasStaticObject);
      const noData = f.state === "offline" || f.state === "calibrating";
      const onl = [okB ? mb : null, okC ? mc : null].filter((m): m is typeof mb => m !== null);
      const ge = imager.update(
        obs,
        f.state === "motion",
        {
          presenceConf: f.conf,
          dataQuality: f.quality,
          linksOnline: onl.length,
          pairedPct: onl.length ? Math.min(...onl.map((m) => m.pairedPct)) : 0,
          rate: onl.length ? Math.min(...onl.map((m) => m.rate)) : 0,
          lossPct: onl.length ? Math.max(...onl.map((m) => m.lossPct)) : 0,
        },
        dt,
        now,
        noData,
      );
      gridRef.current = ge;
      passage.update({
        zB: obs.zB ?? null,
        zC: obs.zC ?? null,
        sB: "staticB" in obs ? (obs.staticB ?? null) : null,
        sC: "staticC" in obs ? (obs.staticC ?? null) : null,
        linkB: okB,
        linkC: okC,
        staticActive: f.hasStaticObject,
        dt,
        now,
        noData,
        sens: detector.sens,
      });
      const sc = sceneRef.current;
      if (sc) {
        sc.state = {
          active: f.state === "motion" || f.hasStaticObject,
          conf: f.conf,
          actB: mb.act,
          actC: mc.act,
          simulation: modeRef.current === "demo",
          noData,
          conf25d: ge.conf25d,
        };
      }
    }, 50);
    // UI 刷新 5Hz
    const t2 = setInterval(() => {
      const now = performance.now();
      for (const i of [1, 2, 3]) {
        const st = nodesRef.current[i];
        const on = (!!st && st.online && now - st.seenAt < 15000) || (i > 1 && now - (lastFrameAt.current[i] || 0) < 5000);
        if (wasOnline.current[i] !== undefined && on !== wasOnline.current[i]) addLog(on ? "info" : "warn", `ESP32-${i === 1 ? "1(A)" : i === 2 ? "B" : "C"} ${on ? "上线" : "离线"}`);
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
    offline: ["离线 · 等待 ESP32 数据", "text-slate-400"],
    calibrating: ["自适应校准中", "text-amber-300"],
    empty: [f.hasStaticObject ? "检测到静态/驻留周边物体" : "环境平稳 · 实时监测中", f.hasStaticObject ? "text-amber-300" : "text-emerald-300"],
    motion: ["检测到周边运动目标", "text-cyan-300"],
  };
  const [stTxt, stCls] = stateText[f.state];
  const est = pf.est;
  const ge = gridRef.current;
  const compact = side < 0.8;
  const paintEst = f.state === "motion" || f.hasStaticObject;
  const detectedObjects = ge?.objects ?? [];

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[#02060d] text-slate-200 select-none">
      <div ref={boxRef} className="absolute inset-0" style={{ visibility: view === "tomo" ? "visible" : "hidden" }} />
      {view === "passage" && <PassageView engine={passage} state={f.state} simulation={mode === "demo"} links={{ B: nodeOn(2), C: nodeOn(3) }} />}

      {/* 左上角标题 */}
      <div className="pointer-events-none absolute top-3 left-3 z-10">
        <div className="text-sm font-bold text-cyan-300 drop-shadow">
          三 ESP32-S3 N16R8（三角阵列）· WiFi CSI 实时 2.5D 过路成像模拟器
        </div>
        <div className="text-[11px] text-slate-400">
          ESP32-1(A) 发射 → ESP32-B / ESP32-C 接收 · 多服务器并联 + USB 串口零断连 · 鼠标左键旋转 / 右键平移 / 滚轮缩放
        </div>
      </div>

      {/* 右上角按键（严格包含：连接ESP32、复制代码、下载模拟器、检测日志） */}
      <div className="absolute top-3 right-3 z-20 flex flex-wrap items-center justify-end gap-2">
        <span className="rounded-md bg-black/60 px-2 py-1 text-[11px] font-mono text-cyan-300 border border-slate-800">{fps} FPS · 20Hz 层析</span>
        <Btn tone="cyan" onClick={() => setShowConnect(true)}>
          🔌 连接 ESP32
          <span className={`ml-2 inline-block h-2.5 w-2.5 rounded-full ${linkOnlineCount > 0 ? "bg-emerald-600" : "bg-slate-500"}`} />
        </Btn>
        <Btn
          tone="amber"
          onClick={async () => {
            const ok = await downloadStandaloneSimulator();
            say(ok ? "已开始下载浏览器模拟器 (HTML)" : "正在跳转代码界面下载");
          }}
        >
          ⬇️ 下载模拟器
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
      {mode === "demo" && view === "tomo" && (
        <div className="pointer-events-none absolute top-16 left-1/2 z-10 -translate-x-1/2 rounded-full border border-amber-400/60 bg-amber-500/20 px-5 py-1.5 text-sm font-extrabold tracking-widest text-amber-300 backdrop-blur">
          SIMULATION · 合成 CSI 实时 2.5D 演示中（可随时切回真实 ESP32）
        </div>
      )}

      {/* 真实模式无数据提示（同时提供一键体验 SIMULATION 按钮） */}
      {mode === "live" && (f.state === "offline" || f.state === "calibrating") && (
        <div className="absolute top-1/2 left-1/2 z-10 w-[min(92vw,480px)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-slate-700/90 bg-[#060f1e]/85 p-5 text-center backdrop-blur-md shadow-2xl">
          <div className={`text-base font-bold ${stCls}`}>
            {f.state === "offline" ? "等待 ESP32-1(A) / ESP32-B / ESP32-C 的 CSI 数据…" : "自适应校准中，请保持周边环境安静"}
          </div>
          <div className="mt-1.5 text-xs text-slate-300">{f.reason}</div>
          {f.state === "offline" && (
            <div className="mt-2.5 text-[11px] leading-relaxed text-slate-400">
              检查：① 三块 ESP32-S3 连同一 2.4GHz WiFi（或点右上角「🔌 连接 ESP32」用 USB 串口直连） ② config.h 的 MQTT_ROOT 与当前主题根一致 ③ ESP32-1(A) 已上电发射探测帧
            </div>
          )}
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <Btn tone="cyan" className="text-xs" onClick={() => setShowConnect(true)}>
              🔌 打开连接与 USB 直连设置
            </Btn>
            <Btn tone="amber" className="text-xs" onClick={startDemo}>
              ▶ 立即启动 2.5D 仿真演示 (测试物体检测)
            </Btn>
            <Btn tone="green" className="text-xs" onClick={() => (window.location.hash = "#/code")}>
              📋 进入复制代码界面
            </Btn>
          </div>
        </div>
      )}

      {/* 视图切换：过路成像（默认，易读） / 概率层析（原版，功能不变） */}
      <div className="absolute top-14 left-44 z-20 flex overflow-hidden rounded-md border border-slate-700 text-xs font-bold backdrop-blur">
        {(
          [
            ["passage", "👁 过路成像（推荐）"],
            ["tomo", "🗺 概率层析（原版）"],
          ] as const
        ).map(([k, t]) => (
          <button
            key={k}
            onClick={() => {
              setView(k);
              save("bzm.tri.view", k);
            }}
            className={`px-2.5 py-1 ${view === k ? "bg-cyan-400 text-slate-900" : "bg-slate-900/80 text-slate-300 hover:bg-slate-800"}`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* 侧边栏开关 */}
      <button className="absolute top-14 left-3 z-20 rounded-md bg-slate-900/80 px-2.5 py-1 text-xs font-bold text-slate-200 border border-slate-700 backdrop-blur hover:bg-slate-800" onClick={() => setPanel(!panel)}>
        {panel ? "◀ 收起控制面板" : "▶ 展开控制面板"}
      </button>

      {panel && (
        <div className="absolute top-24 bottom-3 left-3 z-10 w-[min(92vw,350px)] space-y-2.5 overflow-y-auto pr-1">
          {/* 网址与复制代码快捷入口卡片（严格满足提示词要求） */}
          <Card title="🌐 模拟器网址 · 复制代码 · 下载">
            <div className="space-y-2 text-xs">
              <div className="text-[11px] text-slate-400">当前可直接打开的浏览器模拟器网址：</div>
              <div className="flex items-center gap-1.5">
                <code className="min-w-0 flex-1 truncate rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-[11px] text-cyan-200 select-all" title={url}>
                  {url}
                </code>
                <Btn className="!px-2.5 !py-1 text-xs" tone="cyan" onClick={async () => say((await copyText(url)) ? "已复制模拟器网址" : "复制失败")}>
                  复制网址
                </Btn>
                <a href={url} target="_blank" rel="noreferrer" className="rounded-lg border border-slate-600 bg-slate-800 px-2 py-1 text-xs font-bold text-slate-100 hover:bg-slate-700">
                  打开
                </a>
              </div>
              {kg && (
                <div className="rounded-lg border border-emerald-500/40 bg-emerald-950/30 p-2 text-[11px] text-emerald-200">
                  ☁ Kaggle {kg.ver || "v7"} 后台守护中 · 已运行 {Math.round(kg.up / 60)} 分钟 · GPU：{kg.gpu.length ? kg.gpu.join(" / ") : "CPU"} · 已采集 {kg.msgs} 包
                </div>
              )}
              <div className="rounded-lg border border-slate-700 bg-slate-950/60 p-2 text-[11px] text-slate-300">
                <div className="mb-1 text-slate-400">永久网址（GitHub Pages，推送到 GitHub 后自动构建，不依赖 Kaggle）：</div>
                <div className="flex items-center gap-1.5">
                  <code className="min-w-0 flex-1 truncate select-all text-emerald-200" title={PAGES_URL}>
                    {PAGES_URL}
                  </code>
                  <Btn className="!px-2 !py-1 text-xs" tone="cyan" onClick={async () => say((await copyText(PAGES_URL)) ? "已复制永久网址" : "复制失败")}>
                    复制
                  </Btn>
                  <a href={PAGES_URL} target="_blank" rel="noreferrer" className="rounded-lg border border-slate-600 bg-slate-800 px-2 py-1 text-xs font-bold text-slate-100 hover:bg-slate-700">
                    打开
                  </a>
                </div>
              </div>
              <Btn tone="green" className="w-full" onClick={() => (window.location.hash = "#/code")}>
                📋 进入复制代码界面（GitHub / PlatformIO / Kaggle）
              </Btn>
              <div className="grid grid-cols-2 gap-1.5">
                <Btn
                  tone="amber"
                  className="!px-2 !py-1.5 text-xs"
                  onClick={async () => {
                    const ok = await downloadStandaloneSimulator();
                    say(ok ? "已下载独立版浏览器模拟器 HTML" : "下载失败");
                  }}
                >
                  ⬇️ 下载模拟器 HTML
                </Btn>
                {mode === "demo" ? (
                  <Btn tone="rose" className="!px-2 !py-1.5 text-xs" onClick={() => startLive(root)}>
                    ■ 停止演示回实机
                  </Btn>
                ) : (
                  <Btn className="!px-2 !py-1.5 text-xs" onClick={startDemo}>
                    ▶ 启动 2.5D 演示
                  </Btn>
                )}
              </div>
            </div>
          </Card>

          {/* 新增：周边物体实时检测卡片（显示检测到的所有运动/微动/静态物体） */}
          <Card
            title="🎯 周边物体实时检测（运动 / 微动 / 静态散射体）"
            right={
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${detectedObjects.length > 0 ? "bg-cyan-500/20 text-cyan-300" : "bg-slate-800 text-slate-400"}`}>
                检出 {detectedObjects.length} 个目标
              </span>
            }
          >
            {detectedObjects.length > 0 ? (
              <div className="space-y-1.5 text-xs">
                {detectedObjects.map((obj) => (
                  <div key={obj.id} className="rounded-lg border border-cyan-500/30 bg-slate-900/80 p-2">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-cyan-200">{obj.label}</span>
                      <span className="rounded bg-cyan-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-cyan-300">
                        置信度 {(obj.conf * 100).toFixed(0)}%
                      </span>
                    </div>
                    <div className="mt-1 grid grid-cols-2 gap-x-2 text-[11px] text-slate-300">
                      <span>坐标: ({obj.x.toFixed(2)}, {obj.z.toFixed(2)}) m</span>
                      <span>距离: {obj.distance.toFixed(2)} m ({obj.angleDeg.toFixed(0)}°)</span>
                      <span>尺度: ±{obj.radius.toFixed(2)} m</span>
                      <span>2.5D强度: {(obj.heightScore * 100).toFixed(0)}%</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-xs text-slate-400">
                当前周边未检出显著散射物体（当有任何运动物体、人体呼吸微动或新放置障碍物进入三角阵列感知区时，将立即在此处及 2.5D 全息图中定位显示）。
              </div>
            )}
          </Card>

          <Card title="📡 三角阵列设备状态（同一 WiFi · MQTT + USB 双通道）">
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
                      <span className="ml-auto text-slate-400">{on ? "在线" : "离线"}</span>
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

          <Card title="🩺 检测（B / C 独立分析 → 非相干特征融合）" right={<span className="text-[10px] text-slate-400">置信度 {(f.conf * 100).toFixed(0)}%</span>}>
            <div className={`text-base font-extrabold ${stCls}`}>{stTxt}</div>
            <div className="mb-2 text-[11px] text-slate-400">{f.reason}</div>
            <div className="space-y-1.5 text-[11px] text-slate-400">
              <div>
                融合动态分数 S = {f.S.toFixed(1)}（阈值 {(3.2 / sens).toFixed(1)}）
                <Bar v={f.S} max={12} color="linear-gradient(90deg,#22d3ee,#a78bfa)" />
              </div>
              <div>
                静态散射偏离 staticS = {f.staticS.toFixed(1)} · 频域互相关 ρBC = {f.crossCorr.toFixed(2)}
                <Bar v={f.staticS} max={10} color="#f59e0b" />
              </div>
              <div>
                A→B 运动 z = {mb.valid ? mb.z.toFixed(1) : "—"}（多径色散 {(mb.delayProxy * 100).toFixed(0)}%）
                <Bar v={mb.valid ? mb.act : 0} max={12} color="#14b8a6" />
              </div>
              <div>
                A→C 运动 z = {mc.valid ? mc.z.toFixed(1) : "—"}（多径色散 {(mc.delayProxy * 100).toFixed(0)}%）
                <Bar v={mc.valid ? mc.act : 0} max={12} color="#14b8a6" />
              </div>
              <div>数据质量 {(f.quality * 100).toFixed(0)}%</div>
            </div>
          </Card>

          <Card
            title="🗺️ 2.5D 概率层析成像（Imager25D）"
            right={
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${ge && ge.available ? (ge.tier === "高" ? "bg-emerald-500/20 text-emerald-300" : ge.tier === "中" ? "bg-amber-500/20 text-amber-300" : "bg-rose-500/20 text-rose-300") : "bg-slate-700/60 text-slate-400"}`}>
                {ge && ge.available ? `置信度 ${ge.tier}` : "待机"}
              </span>
            }
          >
            {ge && ge.available ? (
              <div className="space-y-1 text-xs text-slate-300">
                <div className="grid grid-cols-2 gap-x-2 text-[11px]">
                  <span>conf25d {(ge.conf25d * 100).toFixed(0)}%</span>
                  <span>熵 {ge.entropy.toFixed(2)} nat ({(ge.entropyNorm * 100).toFixed(0)}%)</span>
                  <span>spread ± {ge.spread.toFixed(2)} m</span>
                  <span>模型自洽 {(ge.fit * 100).toFixed(0)}%</span>
                  <span className="col-span-2">
                    MAP 峰值 ({ge.peakX.toFixed(2)}, {ge.peakZ.toFixed(2)}) m · 均值 ({ge.meanX.toFixed(2)}, {ge.meanZ.toFixed(2)}) m
                  </span>
                  <span className="col-span-2">
                    σx {ge.sx.toFixed(2)} · σz {ge.sz.toFixed(2)} · ρ {ge.rho.toFixed(2)} · 新鲜度 {ge.age < 90 ? ge.age.toFixed(1) + "s" : "—"}
                  </span>
                </div>
                <Bar v={ge.conf25d} max={1} color="linear-gradient(90deg,#f43f5e,#f59e0b,#22c55e)" />
                <div className={`text-[11px] ${ge.mode === "ok" || ge.mode === "static" ? "text-emerald-300/90" : "text-amber-300"}`}>{ge.reason}</div>
              </div>
            ) : (
              <div className="text-xs text-slate-500">{ge ? ge.reason : "等待数据"}</div>
            )}
            <div className="mt-2 grid grid-cols-3 gap-1 text-[11px]">
              {(
                [
                  ["surface", "2.5D高度场"],
                  ["contour", "50/90%等高线"],
                  ["marker", "MAP 峰值"],
                ] as const
              ).map(([k, n]) => (
                <label key={k} className="flex items-center gap-1">
                  <input type="checkbox" checked={opts[k] ?? true} onChange={(e) => setOpts({ ...opts, [k]: e.target.checked })} /> {n}
                </label>
              ))}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Btn className="!px-2 !py-1 text-xs" onClick={() => sceneRef.current?.resetView()}>
                2.5D 立体视角
              </Btn>
              <Btn className="!px-2 !py-1 text-xs" onClick={() => sceneRef.current?.topView()}>
                俯视热力图
              </Btn>
              <Btn className="!px-2 !py-1 text-xs" onClick={() => sceneRef.current?.arrayCloseUpView()}>
                三角阵列特写
              </Btn>
            </div>
          </Card>

          <Card title="📍 位置估计（粒子滤波 · 概率云/后验采样）">
            {paintEst ? (
              <div className="space-y-1 text-xs text-slate-300">
                <div>
                  x = {est.x.toFixed(2)} m，z = {est.z.toFixed(2)} m（相对三角阵列质心）
                </div>
                <div>
                  不确定度 ± {est.spread.toFixed(2)} m · 有效粒子 {est.ess.toFixed(0)}
                </div>
              </div>
            ) : (
              <div className="text-xs text-slate-500">无散射目标时不显示伪造位置。</div>
            )}
            {compact && (
              <div className="mt-2 rounded-lg border border-cyan-500/30 bg-cyan-950/20 p-2 text-[11px] text-cyan-200">
                紧凑三角摆放模式（边长 {side.toFixed(2)}m）：已启用基线自适应差分放大算法，专门适配三块紧挨摆放的 ESP32-S3。
              </div>
            )}
          </Card>

          <Card title="⚙️ 设置（支持鼠标左键旋转 · 右键平移 · 滚轮缩放）">
            <div className="space-y-2 text-xs text-slate-300">
              <label className="block">
                三角阵列边长（天线中心距）：{side.toFixed(2)} m
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
                感知区域宽 X：{roomW} m
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
                感知区域深 Z：{roomD} m
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
                物体检测灵敏度：{sens.toFixed(1)}
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
                    ["trail", "运动轨迹"],
                    ["room", "空间标尺"],
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
                  tone="cyan"
                  onClick={() => {
                    analyzers.B.reset();
                    analyzers.C.reset();
                    detector.reset();
                    imager.reset();
                    say("已重置空房基准，正在重新校准");
                  }}
                >
                  重新校准基准
                </Btn>
              </div>
              <a className="block pt-1 text-center text-[11px] text-slate-500 underline" href="#/legacy">
                打开旧版双节点模拟器（完整保留）
              </a>
            </div>
          </Card>
        </div>
      )}

      {/* 连接窗口 */}
      {showConnect && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/65 p-3" onClick={() => setShowConnect(false)}>
          <div className="max-h-[92vh] w-[min(96vw,640px)] overflow-y-auto rounded-2xl border border-slate-700 bg-[#0b1322] p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-bold text-cyan-300">🔌 连接三块 ESP32-S3（MQTT 多路并联 + USB WebSerial 双重零断连）</h2>
              <Btn className="!px-2 !py-1" onClick={() => setShowConnect(false)}>
                ✕
              </Btn>
            </div>
            <p className="mb-3 text-xs leading-relaxed text-slate-300">
              三块开发板（<b>ESP32-1/A 发射端</b>、<b>ESP32-B 接收端1</b>、<b>ESP32-C 接收端2</b>）上电连入同一 2.4GHz WiFi 后，会自动通过下方多台 MQTT 服务器并联传输数据；同时支持直接点击下方「🔗 USB 串口直连 ESP32」通过数据线零延迟、零断连读取 CSI！
            </p>
            <div className="mb-3 rounded-xl border border-emerald-500/40 bg-emerald-950/20 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-xs font-bold text-emerald-300">🔗 硬件级零断连通道：USB 串口直连 (WebSerial)</div>
                  <div className="text-[11px] text-slate-400">用 USB 线将 ESP32-B 或 ESP32-C 插在电脑上，无需经过外网即可实时传输 CSI</div>
                </div>
                <Btn
                  tone="green"
                  onClick={async () => {
                    if (!hubRef.current) startLive(root);
                    const ok = await hubRef.current?.connectSerial();
                    if (ok) say("USB 串口直连成功！");
                  }}
                >
                  🔗 添加 USB 串口直连 ESP32
                </Btn>
              </div>
            </div>
            <label className="mb-1 block text-xs text-slate-400">MQTT 主题根（必须与固件 config.h 的 MQTT_ROOT 一致）</label>
            <div className="mb-3 flex gap-2">
              <input value={rootDraft} onChange={(e) => setRootDraft(e.target.value.trim())} className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-[#0f1a2c] px-3 py-2 font-mono text-xs outline-none" />
              <Btn
                tone="cyan"
                onClick={() => {
                  const r = rootDraft || TRI_ROOT;
                  setRoot(r);
                  save(LS.root, r);
                  startLive(r);
                  say("已按新主题根重连全部服务器");
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
                <input value={customUrl} onChange={(e) => setCustomUrl(e.target.value.trim())} placeholder="追加自定义 Broker：wss://你的服务器:8084/mqtt" className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-[#0f1a2c] px-3 py-1.5 text-xs outline-none" />
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
              <Btn onClick={() => hubRef.current?.sendCmd("hello")}>询问设备状态</Btn>
              <Btn tone="rose" onClick={() => hubRef.current?.sendCmd("reboot") ?? say("未连接")}>
                远程重启三块 ESP32
              </Btn>
              <Btn tone="green" onClick={() => (window.location.hash = "#/code")}>
                📋 进入复制代码界面
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
