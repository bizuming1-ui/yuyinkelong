import { useCallback, useEffect, useRef, useState } from "react";
import Scene3D, { type SceneOptions } from "./Scene3D";
import { BANDWIDTH_MHZ, NB, NCH, NDISP, RESOLUTION_M, RadarEngine } from "@/lib/dsp";
import { Detector, LINK_IDS, LINK_NAMES } from "@/lib/detector";
import { BROKERS, DEFAULT_ROOT } from "@/lib/config";
import { MqttHub, type LinkState as MqttState, type NodeStatus } from "@/lib/mqtt-hub";
import { encodeBatch, parseBatch, type CsiFrame } from "@/lib/protocol";
import { SynthScene } from "@/lib/synth";
import { DemoHuman } from "@/lib/demo";

type Mode = "idle" | "live" | "demo";
interface LogItem {
  t: string;
  level: "info" | "warn" | "error";
  msg: string;
}

const LS_ROOT = "bzm-root";
const LS_BASE = "bzm-baseline";
const LS_SENS = "bzm-sens";

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

function drawProfile(cv: HTMLCanvasElement | null, engine: RadarEngine) {
  if (!cv) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = cv.clientWidth;
  const h = cv.clientHeight;
  if (!w || !h) return;
  if (cv.width !== Math.round(w * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  const g = cv.getContext("2d")!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const L = 30;
  const px = 30;
  const py = 8;
  const pw = w - px - 8;
  const ph = h - py - 20;
  g.strokeStyle = "rgba(120,170,220,0.2)";
  g.fillStyle = "rgba(180,210,240,0.8)";
  g.font = "10px system-ui";
  g.textAlign = "center";
  for (let m = 0; m <= L; m += 5) {
    const x = px + (m / L) * pw;
    g.beginPath();
    g.moveTo(x, py);
    g.lineTo(x, py + ph);
    g.stroke();
    g.fillText(String(m), x, h - 6);
  }
  const prof = engine.profile;
  const dyn = engine.dyn;
  for (let i = 0; i < NDISP; i++) {
    const x = px + ((i * 0.25) / L) * pw;
    const hh = dyn[i] * ph;
    g.fillStyle = "rgba(244,114,182,0.55)";
    g.fillRect(x, py + ph - hh, Math.max(1, pw / NDISP), hh);
  }
  g.beginPath();
  for (let i = 0; i < NDISP; i++) {
    const x = px + ((i * 0.25) / L) * pw;
    const y = py + ph - prof[i] * ph;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.strokeStyle = "#22d3ee";
  g.lineWidth = 1.6;
  g.stroke();
  g.lineWidth = 1;
  for (const p of engine.peaks) {
    const x = px + (p.L / L) * pw;
    g.fillStyle = p.los ? "#34d399" : p.dyn > 0.2 ? "#f472b6" : "#fbbf24";
    g.beginPath();
    g.arc(x, py + ph - p.amp * ph, 3, 0, Math.PI * 2);
    g.fill();
  }
}

function Btn(props: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "cyan" | "green" | "amber" | "slate" | "rose" }) {
  const { tone = "slate", className = "", ...rest } = props;
  const tones: Record<string, string> = {
    cyan: "bg-cyan-400 text-slate-900 hover:bg-cyan-300",
    green: "bg-emerald-500 text-slate-950 hover:bg-emerald-400",
    amber: "bg-amber-400 text-slate-900 hover:bg-amber-300",
    rose: "bg-rose-500 text-white hover:bg-rose-400",
    slate: "bg-slate-800 text-slate-100 hover:bg-slate-700 border border-slate-700",
  };
  return <button {...rest} className={`rounded-lg px-3 py-2 text-sm font-bold whitespace-nowrap transition active:scale-95 ${tones[tone]} ${className}`} />;
}

function Card({ title, children, right }: { title: React.ReactNode; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-slate-800 bg-[#0b1322] p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-bold text-slate-100">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

export default function RadarApp() {
  const [engine] = useState(() => new RadarEngine());
  const [detector] = useState(() => new Detector());
  const [mode, setMode] = useState<Mode>("idle");
  const [root, setRoot] = useState(DEFAULT_ROOT);
  const [rootDraft, setRootDraft] = useState(DEFAULT_ROOT);
  const [baseline, setBaseline] = useState(3);
  const [sens, setSens] = useState(1.5);
  const [links, setLinks] = useState<Record<string, MqttState>>({});
  const [nodes, setNodes] = useState<Record<number, NodeStatus | undefined>>({});
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [showConnect, setShowConnect] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [opts, setOpts] = useState<SceneOptions>({ terrain: true, ellipses: true, avatar: true, trail: true, autoRotate: false });
  const [resetSignal, setResetSignal] = useState(0);
  const [fps, setFps] = useState(0);
  const [url, setUrl] = useState("");
  const [toast, setToast] = useState("");
  const [, setTick] = useState(0);
  const [online, setOnline] = useState<[boolean, boolean]>([false, false]);

  const hubRef = useRef<MqttHub | null>(null);
  const timers = useRef<ReturnType<typeof setInterval>[]>([]);
  const baseRef = useRef(3);
  const nodesRef = useRef<Record<number, NodeStatus | undefined>>({});
  const wasOnline = useRef<[boolean, boolean]>([false, false]);
  const lastFrameAt = useRef<[number, number]>([0, 0]);
  const profileCv = useRef<HTMLCanvasElement>(null);
  const firstData = useRef(false);
  const apCount = useRef<[number, number]>([0, 0]);

  const addLog = useCallback((level: LogItem["level"], msg: string) => {
    setLogs((l) => [{ t: fmtTime(), level, msg }, ...l].slice(0, 300));
    if (level !== "info") setUnread((u) => u + 1);
  }, []);

  const say = useCallback((t: string) => {
    setToast(t);
    setTimeout(() => setToast(""), 1800);
  }, []);

  const feed = useCallback(
    (frames: CsiFrame[], now: number) => {
      for (const f of frames) {
        engine.pushFrame(f, now);
        detector.push(f, now);
        if (f.node === 1 || f.node === 2) {
          lastFrameAt.current[f.node - 1] = now;
          if (f.link === 1) apCount.current[f.node - 1]++;
        }
      }
    },
    [engine, detector],
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
      const hub = new MqttHub(r, {
        onFrames: (frames, via) => {
          feed(frames, performance.now());
          if (!firstData.current) {
            firstData.current = true;
            addLog("info", `收到 ESP32-${frames[0].node} 的 CSI 数据（经 ${via}）`);
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
      setMode("live");
      hub.connect().catch((e) => addLog("error", `MQTT 初始化失败：${String(e)}`));
    },
    [addLog, feed, stopAll],
  );

  const startDemo = useCallback(() => {
    stopAll();
    engine.resetAll();
    detector.resetBaseline();
    const human = new DemoHuman();
    human.base = baseRef.current;
    const sc = new SynthScene(baseRef.current, 6, 11);
    const t0 = performance.now();
    let sid = 0;
    let n = 0;
    const fake = (id: number): NodeStatus => ({
      id,
      online: true,
      fw: "演示",
      rssi: -48,
      ch: 6,
      csiOk: true,
      peer: true,
      seenAt: performance.now(),
      via: "演示",
      up: Math.round((performance.now() - t0) / 1000),
    });
    timers.current.push(
      setInterval(() => {
        const now = performance.now();
        const t = (now - t0) / 1000;
        human.base = baseRef.current;
        n++;
        feed(human.tick(t, n % 2 === 0), now);
      }, 20),
    );
    const doSweep = () => {
      sc.baseline = baseRef.current;
      sid = (sid % 254) + 1;
      const now = performance.now();
      const t = (now - t0) / 1000;
      sc.person.on = human.walking(t);
      sc.person.L = 12 + 6 * (0.5 + 0.5 * human.pos(t));
      const all = sc.sweep(sid, t, Math.round(now));
      for (const node of [1, 2]) {
        const recs = all.filter((x) => x.node === node).map((x) => x.rec);
        for (let i = 0; i < recs.length; i += 6) feed(parseBatch(encodeBatch(node, recs.slice(i, i + 6))), now);
      }
    };
    doSweep();
    timers.current.push(setInterval(doSweep, 2500));
    timers.current.push(
      setInterval(() => {
        nodesRef.current = { 1: fake(1), 2: fake(2) };
        setNodes(nodesRef.current);
      }, 2000),
    );
    nodesRef.current = { 1: fake(1), 2: fake(2) };
    setNodes(nodesRef.current);
    setMode("demo");
    addLog("info", "已启动演示数据：合成 CSI（先安静 10 秒 → 走动 12 秒 → 静止 12 秒 循环），与真实数据走同一条检测流水线");
  }, [addLog, detector, engine, feed, stopAll]);

  // 启动：恢复设置 → 自动连接
  useEffect(() => {
    setUrl(window.location.href.split("#")[0]);
    let r = DEFAULT_ROOT;
    try {
      r = localStorage.getItem(LS_ROOT) || DEFAULT_ROOT;
      const b = parseFloat(localStorage.getItem(LS_BASE) || "");
      if (b > 0.1 && b < 20) {
        setBaseline(b);
        baseRef.current = b;
        engine.setBaseline(b);
      }
      const sv = parseFloat(localStorage.getItem(LS_SENS) || "");
      if (sv >= 0.5 && sv <= 4) {
        setSens(sv);
        detector.sensitivity = sv;
      }
    } catch {
      /* 隐私模式 */
    }
    setRoot(r);
    setRootDraft(r);
    startLive(r);
    // 检测循环 25Hz（与渲染解耦）
    const t1 = setInterval(() => {
      const now = performance.now();
      engine.tick(now);
      detector.breathBpm = engine.sense.breathConf > 0.35 ? engine.sense.breathBpm : 0;
      detector.update(now);
    }, 40);
    return () => {
      clearInterval(t1);
      stopAll();
    };
  }, [engine, detector, startLive, stopAll]);

  // UI 刷新 5Hz
  useEffect(() => {
    const id = setInterval(() => {
      const now = performance.now();
      for (const i of [1, 2]) {
        const s = nodesRef.current[i];
        const on = (!!s && s.online && now - s.seenAt < 15000) || now - lastFrameAt.current[i - 1] < 5000;
        if (on !== wasOnline.current[i - 1]) {
          wasOnline.current[i - 1] = on;
          addLog(on ? "info" : "warn", `ESP32-${i} ${on ? "上线" : "离线"}`);
        }
      }
      setOnline((o) => (o[0] === wasOnline.current[0] && o[1] === wasOnline.current[1] ? o : [wasOnline.current[0], wasOnline.current[1]]));
      setTick((x) => x + 1);
    }, 200);
    return () => clearInterval(id);
  }, [addLog]);

  useEffect(() => {
    const id = setInterval(() => drawProfile(profileCv.current, engine), 120);
    return () => clearInterval(id);
  }, [engine]);

  // 检测状态变化 → 日志
  useEffect(() => {
    detector.onChange = (m) => addLog("info", m ? "🚶 检测到有人在移动" : "🧍 运动停止");
    return () => {
      detector.onChange = undefined;
    };
  }, [detector, addLog]);

  const changeBaseline = (v: number) => {
    setBaseline(v);
    baseRef.current = v;
    engine.setBaseline(v);
    try {
      localStorage.setItem(LS_BASE, String(v));
    } catch {
      /* ignore */
    }
  };
  const changeSens = (v: number) => {
    setSens(v);
    detector.sensitivity = v;
    try {
      localStorage.setItem(LS_SENS, String(v));
    } catch {
      /* ignore */
    }
  };

  const doCopy = async (text: string, msg: string) => {
    say((await copyText(text)) ? msg : "复制失败，请手动选择复制");
  };

  const ds = detector.state;
  const st = engine.stats;
  const anyLinkOnline = Object.values(links).some((s) => s === "online");
  const connected = mode === "demo" || (mode === "live" && anyLinkOnline);
  const connecting = mode === "live" && !anyLinkOnline;
  const bothOnline = online[0] && online[1];

  const banner =
    mode === "demo"
      ? "🧪 演示模式：下面是合成数据（有人走动 ↔ 静止循环），不是真实 ESP32。点右上角「连接 ESP32」切回真实数据。"
      : mode === "live"
        ? anyLinkOnline
          ? bothOnline
            ? "✅ ESP32-1 与 ESP32-2 都在线，数据经 MQTT 无线传来（不用接 USB）。"
            : `🟡 MQTT 已连接，等待 ESP32：${online[0] ? "" : "ESP32-1 "}${online[1] ? "" : "ESP32-2 "}上线（给板子供电，并确认 WiFi 与 config.h 的 MQTT_ROOT 一致）`
          : "🔄 正在连接 MQTT 服务器…（网络不通时会自动重试，不会卡死）"
        : "⚪ 未连接";

  let big = "等待数据";
  let bigCls = "text-slate-400";
  let bigIcon = "⏳";
  if (ds.totalFps > 0 || ds.ready) {
    if (!ds.ready || (ds.warmupPct < 1 && !ds.moving)) {
      big = `正在学习环境 ${Math.round(ds.warmupPct * 100)}%（请安静 10 秒）`;
      bigCls = "text-amber-300";
      bigIcon = "🧠";
    } else if (ds.moving) {
      big = "有人在移动";
      bigCls = "text-rose-300";
      bigIcon = "🚶";
    } else if (ds.reason === "breath") {
      big = `有人（静止 · 呼吸 ${detector.breathBpm.toFixed(0)}/分）`;
      bigCls = "text-amber-300";
      bigIcon = "🫁";
    } else if (ds.reason === "recent") {
      big = "有人（刚刚移动，现静止）";
      bigCls = "text-amber-300";
      bigIcon = "🧍";
    } else {
      big = "无人 / 环境静止";
      bigCls = "text-emerald-300";
      bigIcon = "✅";
    }
  }

  return (
    <div className="flex h-screen min-h-0 flex-col bg-[#050a14] text-slate-200">
      {/* 顶栏 */}
      <header className="flex flex-wrap items-center gap-2 border-b border-slate-800 bg-[#0b1220] px-3 py-2">
        <div className="mr-1 flex items-center gap-2 text-sm font-bold text-cyan-300">
          <span className="text-lg">📡</span>
          <span className="hidden md:inline">双 ESP32-S3 WiFi CSI 3D 感知模拟器</span>
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <input readOnly value={url} onFocus={(e) => e.currentTarget.select()} className="min-w-0 flex-1 rounded-full border border-slate-700 bg-[#0f1a2c] px-3 py-1.5 font-mono text-xs text-slate-300 outline-none" />
          <Btn onClick={() => doCopy(url, "网址已复制")} className="hidden sm:block">
            复制网址
          </Btn>
          <Btn onClick={() => window.open(url, "_blank")} className="hidden sm:block">
            新标签打开
          </Btn>
        </div>
        <div className="flex items-center gap-2">
          <Btn tone={connected ? "green" : connecting ? "amber" : "cyan"} onClick={() => setShowConnect(true)} title="连接 / 断开 ESP32、查看服务器状态">
            {connected ? "✅ 已连接 ESP32" : connecting ? "⏳ 连接中…" : "🔌 连接 ESP32"}
          </Btn>
          <div className="relative">
            <Btn
              onClick={() => {
                setShowLog(true);
                setUnread(0);
              }}
            >
              🩺 检测日志
            </Btn>
            {unread > 0 && <span className="absolute -top-2 -right-2 rounded-full bg-orange-500 px-1.5 text-[11px] font-bold text-white">{Math.min(unread, 99)}</span>}
          </div>
          <Btn tone="green" onClick={() => (window.location.hash = "#/code")}>
            📋 复制代码
          </Btn>
        </div>
      </header>

      <div className="flex items-center justify-between gap-3 border-b border-slate-800 bg-[#070d19] px-4 py-2 text-sm">
        <div className="min-w-0 flex-1 truncate">{banner}</div>
        <Btn tone="cyan" onClick={() => (window.location.hash = "#/code")}>
          📋 进入复制代码界面
        </Btn>
      </div>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* 左侧面板 */}
        <aside className="w-full shrink-0 space-y-3 overflow-y-auto border-r border-slate-800 bg-[#060c18] p-3 lg:w-[370px]" style={{ maxHeight: "100%" }}>
          <section className={`rounded-2xl border p-4 ${ds.moving ? "border-rose-500/60 bg-rose-950/30" : ds.presence ? "border-amber-500/50 bg-amber-950/20" : "border-slate-800 bg-[#0b1322]"}`}>
            <div className={`flex items-center gap-3 text-xl font-extrabold ${bigCls}`}>
              <span className="text-3xl">{bigIcon}</span>
              <span>{big}</span>
            </div>
            <div className="mt-3 h-3 overflow-hidden rounded-full bg-slate-800">
              <div className="h-full rounded-full bg-gradient-to-r from-cyan-400 via-amber-400 to-rose-500 transition-[width] duration-100" style={{ width: `${Math.round(ds.motion * 100)}%` }} />
            </div>
            <div className="mt-1 flex justify-between text-xs text-slate-400">
              <span>运动强度 {Math.round(ds.motion * 100)}%</span>
              <span>
                得分 {ds.score.toFixed(1)}（触发阈值 {detector.thresholds().on.toFixed(1)}）
              </span>
            </div>
            <div className="mt-3 text-xs text-slate-400">
              数据速率 <b className="text-cyan-300">{ds.totalFps.toFixed(0)}</b> 帧/秒 · 最灵敏链路 <b className="text-cyan-300">{ds.best ? LINK_NAMES[ds.best] : "—"}</b>
            </div>
            <label className="mt-3 block text-xs text-slate-300">
              灵敏度 <b className="text-cyan-300">{sens.toFixed(1)}</b>（越大越灵敏；默认 1.5，仍无反应就拉到 3 以上）
              <input type="range" min={0.5} max={4} step={0.1} value={sens} onChange={(e) => changeSens(parseFloat(e.target.value))} className="mt-1 w-full accent-cyan-400" />
            </label>
            <div className="mt-3 flex flex-wrap gap-2">
              <Btn
                onClick={() => {
                  detector.resetBaseline();
                  engine.resetCalibration();
                  say("已重新学习环境（请离开 10 秒）");
                }}
              >
                🎯 重新学习环境
              </Btn>
              <Btn onClick={() => (mode === "demo" ? startLive(root) : startDemo())}>{mode === "demo" ? "⏹ 退出演示" : "▶ 启动演示数据"}</Btn>
            </div>
          </section>

          <Card title="📶 检测链路（4 条，实时）">
            <div className="space-y-2">
              {LINK_IDS.map((id, i) => {
                const l = ds.links[i];
                if (!l) return null;
                const pct = Math.round(Math.min(1, Math.max(0, l.score / 20)) * 100);
                return (
                  <div key={id}>
                    <div className="flex items-center justify-between text-xs">
                      <span className={l.active ? "text-slate-200" : "text-slate-500"}>
                        {l.active ? "●" : "○"} {LINK_NAMES[id]}
                      </span>
                      <span className="font-mono text-slate-400">
                        {l.fps.toFixed(0)}Hz · {l.rssi}dBm · z={l.score.toFixed(1)}
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded bg-slate-800">
                      <div className={`h-full ${l.score > detector.thresholds().on ? "bg-rose-400" : "bg-cyan-500"}`} style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-slate-500">「路由器」链路靠 ESP32 每秒 ping 路由器 30 次产生 CSI，路径穿过整个房间，比两块板之间的短链路灵敏得多。若这两条一直显示 ○，请重新烧录 v3 固件。</p>
          </Card>

          <Card title="📊 双节点（MQTT 无线）">
            {[1, 2].map((i) => {
              const s = nodes[i];
              const on = online[i - 1];
              return (
                <div key={i} className="flex items-center gap-2 py-0.5 text-sm">
                  <span className={`h-2.5 w-2.5 rounded-full ${on ? "bg-emerald-400" : "bg-slate-600"}`} />
                  <b className={i === 1 ? "text-cyan-300" : "text-pink-300"}>ESP32-{i}</b>
                  <span className="text-slate-400">{on ? `${s?.rssi ?? "—"}dBm · 信道${s?.ch ?? "—"} · v${s?.fw ?? "?"} · ${s?.via ?? ""}` : "离线"}</span>
                </div>
              );
            })}
            <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
              {BROKERS.map((b) => (
                <span key={b.name} className={`rounded-full border px-2 py-0.5 ${links[b.name] === "online" ? "border-emerald-500/50 text-emerald-300" : "border-slate-700 text-slate-500"}`}>
                  {b.name} {links[b.name] === "online" ? "已连" : links[b.name] === "connecting" ? "连接中" : "—"}
                </span>
              ))}
            </div>
          </Card>

          <Card title="🛰 13 信道拼接 / 路径剖面">
            <div className="grid grid-cols-3 gap-2 text-center">
              {[
                [`${st.chUsed}/${NCH}`, "拼接信道"],
                [BANDWIDTH_MHZ.toFixed(1), "带宽 MHz"],
                [RESOLUTION_M.toFixed(2), "分辨率 m"],
                [String(st.pairs), "配对数"],
                [`${(100 - st.lostPct).toFixed(1)}%`, "同步成功"],
                [String(st.sweeps), "剖面序号"],
              ].map(([v, l]) => (
                <div key={l}>
                  <div className="text-xl font-bold text-cyan-300">{v}</div>
                  <div className="text-[11px] text-slate-500">{l}</div>
                </div>
              ))}
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {Array.from({ length: NCH }, (_, i) => (
                <span key={i} className={`flex h-6 w-6 items-center justify-center rounded text-[11px] font-bold ${st.chOk[i] ? "bg-emerald-500 text-slate-900" : "bg-slate-800 text-slate-400"}`}>
                  {i + 1}
                </span>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-slate-500">
              {NB} 个频点；2 节点只能给出路径长度 L（椭圆），不能单独确定方位角。
            </p>
          </Card>

          <Card title="⚙️ 场景设置">
            <label className="block text-xs text-slate-300">
              两块 ESP32 的实际间距 <b className="text-cyan-300">{baseline.toFixed(2)} m</b>
              <input type="range" min={0.2} max={12} step={0.05} value={baseline} onChange={(e) => changeBaseline(parseFloat(e.target.value))} className="mt-1 w-full accent-cyan-400" />
            </label>
            <div className="mt-2 grid grid-cols-2 gap-1.5 text-xs">
              {(
                [
                  ["avatar", "人体线框成像"],
                  ["trail", "移动轨迹"],
                  ["ellipses", "路径椭圆"],
                  ["terrain", "距离-时间地形"],
                  ["autoRotate", "自动旋转"],
                ] as [keyof SceneOptions, string][]
              ).map(([k, n]) => (
                <label key={k} className="flex cursor-pointer items-center gap-2">
                  <input type="checkbox" checked={opts[k]} onChange={(e) => setOpts({ ...opts, [k]: e.target.checked })} className="accent-cyan-400" />
                  {n}
                </label>
              ))}
            </div>
            <Btn className="mt-3" onClick={() => setResetSignal((x) => x + 1)}>
              🎥 重置视角
            </Btn>
            <p className="mt-2 text-[11px] text-slate-500">鼠标：左键旋转 · 右键平移 · 滚轮缩放（手机：单指旋转，双指缩放）。渲染 {fps} FPS。</p>
          </Card>

          <Card title="💡 想让检测更灵敏（物理层面）">
            <ul className="list-disc space-y-1 pl-4 text-[12px] leading-relaxed text-slate-400">
              <li>两块板子请隔开 <b>2~4 米</b>，不要贴在一起（0.3m 时直达波太强，人几乎扰动不了）。</li>
              <li>人要走在<b>两块板之间或附近</b>，板子放在 1m 左右高度，天线朝向无遮挡。</li>
              <li>路由器链路对整个房间都敏感：路由器与 ESP32 之间的区域是最灵敏区域。</li>
              <li>3D 人影的位置是 2 节点的近似估计（椭圆上），不是摄像头级轮廓。</li>
            </ul>
          </Card>
        </aside>

        {/* 3D 视图 */}
        <main className="relative min-h-[360px] flex-1">
          <Scene3D engine={engine} detector={detector} baseline={baseline} options={opts} resetSignal={resetSignal} onFps={setFps} />
          <div className="pointer-events-none absolute top-3 left-1/2 -translate-x-1/2">
            <div className={`rounded-full border px-5 py-2 text-base font-extrabold shadow-lg backdrop-blur ${ds.moving ? "animate-pulse border-rose-400 bg-rose-950/70 text-rose-200" : ds.presence ? "border-amber-400 bg-amber-950/60 text-amber-200" : "border-slate-700 bg-slate-950/70 text-slate-300"}`}>
              {bigIcon} {big}
            </div>
          </div>
          <div className="pointer-events-none absolute bottom-3 left-3 rounded-lg bg-slate-950/70 px-3 py-2 text-[11px] text-slate-300 backdrop-blur">
            <div>
              <span className="text-cyan-300">●</span> ESP32-1　<span className="text-pink-300">●</span> ESP32-2　<span className="text-amber-300">━</span> 当前路径椭圆　线框人 = 检测到的人体
            </div>
          </div>
          <div className="absolute right-3 bottom-3 hidden h-[190px] w-[min(46%,560px)] rounded-xl border border-slate-800 bg-[#050a14]/85 p-2 backdrop-blur md:block">
            <div className="flex justify-between text-[11px] text-slate-400">
              <span>路径长度剖面（青=剖面，粉=动态变化）</span>
              <span>L / m</span>
            </div>
            <canvas ref={profileCv} className="h-[150px] w-full" />
          </div>
        </main>
      </div>

      {/* 连接弹窗 */}
      {showConnect && (
        <Modal title="🔌 连接 ESP32" onClose={() => setShowConnect(false)}>
          <p className="text-sm text-slate-300">页面打开时会自动连接。数据路径：ESP32 → WiFi → MQTT 公共服务器 → 浏览器（WSS）。浏览器同时连 3 个服务器，任一断线不影响其它。</p>
          <label className="mt-3 block text-xs text-slate-400">
            MQTT 主题根（必须与 config.h 的 MQTT_ROOT 完全一致）
            <input value={rootDraft} onChange={(e) => setRootDraft(e.target.value.trim())} className="mt-1 w-full rounded-lg border border-slate-700 bg-[#0f1a2c] px-3 py-2 font-mono text-sm text-slate-100 outline-none" />
          </label>
          <div className="mt-3 space-y-1 text-sm">
            {BROKERS.map((b) => (
              <div key={b.name} className="flex justify-between rounded-lg bg-slate-900 px-3 py-1.5">
                <span>{b.name}</span>
                <span className={links[b.name] === "online" ? "text-emerald-300" : "text-slate-500"}>{links[b.name] === "online" ? "已连接" : links[b.name] === "connecting" ? "连接中…" : links[b.name] === "error" ? "错误（自动重试）" : "未连接"}</span>
              </div>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Btn
              tone="cyan"
              onClick={() => {
                setRoot(rootDraft);
                try {
                  localStorage.setItem(LS_ROOT, rootDraft);
                } catch {
                  /* ignore */
                }
                startLive(rootDraft);
                setShowConnect(false);
                say("正在连接…");
              }}
            >
              {mode === "live" ? "🔄 重新连接" : "🔌 连接 ESP32"}
            </Btn>
            <Btn
              onClick={() => {
                hubRef.current?.sendCmd("ping");
                say("已向两块 ESP32 发送 ping");
              }}
            >
              📡 Ping 两块板子
            </Btn>
            <Btn
              onClick={() => {
                hubRef.current?.sendCmd("sweep");
                say("已请求立即扫频");
              }}
            >
              🌐 立即扫频
            </Btn>
            <Btn
              onClick={() => {
                stopAll();
                setMode("idle");
                setLinks({});
                setShowConnect(false);
              }}
            >
              ⏏ 断开
            </Btn>
          </div>
          <p className="mt-3 text-xs text-slate-500">提示：ESP32 的 WiFi 必须是 2.4GHz；两块板子要连同一个路由器；烧录前在「复制代码界面」填好 WiFi，复制出来的 config.h 会自动带上。</p>
        </Modal>
      )}

      {showLog && (
        <Modal title="🩺 检测日志" onClose={() => setShowLog(false)}>
          <div className="max-h-[60vh] space-y-1 overflow-y-auto font-mono text-xs">
            {logs.length === 0 && <div className="text-slate-500">暂无日志</div>}
            {logs.map((l, i) => (
              <div key={i} className={l.level === "error" ? "text-rose-300" : l.level === "warn" ? "text-amber-300" : "text-slate-300"}>
                [{l.t}] {l.msg}
              </div>
            ))}
          </div>
        </Modal>
      )}

      {toast && <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-emerald-500 px-5 py-2 text-sm font-bold text-slate-950 shadow-xl">{toast}</div>}
    </div>
  );
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-xl rounded-2xl border border-slate-700 bg-[#0b1322] p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-bold text-cyan-300">{title}</h2>
          <button className="rounded-lg px-2 py-1 text-slate-400 hover:bg-slate-800" onClick={onClose}>
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
