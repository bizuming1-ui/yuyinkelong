/* eslint-disable react-hooks/set-state-in-effect */
"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Scene3D, { type SceneOptions } from "./Scene3D";
import { BANDWIDTH_MHZ, NB, NCH, NDISP, RESOLUTION_M, RadarEngine } from "@/lib/dsp";
import { BROKERS, DEFAULT_ROOT } from "@/lib/config";
import { MqttHub, type LinkState, type NodeStatus } from "@/lib/mqtt-hub";
import { encodeBatch, parseBatch } from "@/lib/protocol";
import { SynthScene } from "@/lib/synth";

type Mode = "idle" | "live" | "demo";
interface LogItem {
  t: string;
  level: "info" | "warn" | "error";
  msg: string;
}

const LS_ROOT = "bzm-root";
const LS_BASE = "bzm-baseline";

function fmtTime() {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

export default function RadarApp() {
  const [engine] = useState(() => new RadarEngine());
  const [mode, setMode] = useState<Mode>("idle");
  const [root, setRoot] = useState(DEFAULT_ROOT);
  const [baseline, setBaseline] = useState(3);
  const [links, setLinks] = useState<Record<string, LinkState>>({});
  const [nodes, setNodes] = useState<Record<number, NodeStatus | undefined>>({});
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [showConnect, setShowConnect] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [opts, setOpts] = useState<SceneOptions>({ terrain: true, ellipses: true, peakEllipses: true, autoRotate: false });
  const [resetSignal, setResetSignal] = useState(0);
  const [fps, setFps] = useState(0);
  const [url, setUrl] = useState("");
  const [copied, setCopied] = useState("");
  const [, setNowTs] = useState(0);
  const [online, setOnline] = useState<[boolean, boolean]>([false, false]);
  const lastFrameAt = useRef<[number, number]>([0, 0]);
  const [nodeFps, setNodeFps] = useState<[number, number]>([0, 0]);

  const hubRef = useRef<MqttHub | null>(null);
  const timers = useRef<ReturnType<typeof setInterval>[]>([]);
  const baseRef = useRef(3);
  const nodesRef = useRef<Record<number, NodeStatus | undefined>>({});
  const wasOnline = useRef<[boolean, boolean]>([false, false]);
  const lastFrames = useRef<[number, number]>([0, 0]);
  const sceneHost = useRef<HTMLDivElement>(null);
  const profileCv = useRef<HTMLCanvasElement>(null);
  const specCv = useRef<HTMLCanvasElement>(null);
  const firstData = useRef(false);

  const addLog = useCallback((level: LogItem["level"], msg: string) => {
    setLogs((l) => [{ t: fmtTime(), level, msg }, ...l].slice(0, 300));
    if (level !== "info") setUnread((u) => u + 1);
  }, []);

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
          const now = performance.now();
          for (const f of frames) {
            engine.pushFrame(f, now);
            lastFrameAt.current[f.node - 1] = now;
          }
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
    [addLog, engine, stopAll],
  );

  const startDemo = useCallback(() => {
    stopAll();
    engine.resetAll();
    const sc = new SynthScene(baseRef.current, 6, 11);
    const t0 = performance.now();
    let sid = 0;
    const feed = (node: number, recs: ReturnType<SynthScene["rec"]>[]) => {
      const now = performance.now();
      for (let i = 0; i < recs.length; i += 6) {
        for (const f of parseBatch(encodeBatch(node, recs.slice(i, i + 6)))) engine.pushFrame(f, now);
      }
    };
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
        sc.baseline = baseRef.current;
        const t = (performance.now() - t0) / 1000;
        const tms = Math.round(performance.now());
        for (const node of [1, 2]) {
          const recs = [];
          for (let i = 0; i < 10; i++) recs.push(sc.rec(node, 6, 0, t + i * 0.01, tms + i * 10));
          feed(node, recs);
        }
      }, 100),
    );
    const doSweep = () => {
      sc.baseline = baseRef.current;
      sid = (sid % 254) + 1;
      const t = (performance.now() - t0) / 1000;
      const all = sc.sweep(sid, t, Math.round(performance.now()));
      for (const node of [1, 2]) feed(node, all.filter((x) => x.node === node).map((x) => x.rec));
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
    addLog("info", "已启动演示数据（合成 CSI：直达波 + 3 个反射体 + 1 个运动目标）");
  }, [addLog, engine, stopAll]);

  // 启动：恢复设置 → 自动连接 MQTT
  useEffect(() => {
    setUrl(window.location.href);
    let r = DEFAULT_ROOT;
    try {
      r = localStorage.getItem(LS_ROOT) || DEFAULT_ROOT;
      const b = parseFloat(localStorage.getItem(LS_BASE) || "");
      if (b > 0.1 && b < 20) {
        setBaseline(b);
        baseRef.current = b;
        engine.setBaseline(b);
      }
    } catch {
      /* 隐私模式 */
    }
    setRoot(r);
    startLive(r);
    const t1 = setInterval(() => engine.tick(performance.now()), 40);
    return () => {
      clearInterval(t1);
      stopAll();
    };
  }, [engine, startLive, stopAll]);

  // UI 刷新 4Hz：节点在线判定、帧率、日志事件
  useEffect(() => {
    const id = setInterval(() => {
      const now = performance.now();
      const fr = engine.stats.frames;
      const nf: [number, number] = [fr[0] - lastFrames.current[0], fr[1] - lastFrames.current[1]];
      lastFrames.current = [fr[0], fr[1]];
      setNodeFps((p) => [p[0] * 0.5 + nf[0] * 4 * 0.5, p[1] * 0.5 + nf[1] * 4 * 0.5]);
      for (const i of [1, 2]) {
        const s = nodesRef.current[i];
        // 在线 = 心跳新鲜 或 5 秒内收到过它的 CSI 数据（即使心跳包被服务器丢了也不会误判离线）
        const on = (!!s && s.online && now - s.seenAt < 15000) || now - lastFrameAt.current[i - 1] < 5000;
        if (on !== wasOnline.current[i - 1]) {
          wasOnline.current[i - 1] = on;
          addLog(on ? "info" : "warn", `ESP32-${i} ${on ? "上线" : "离线"}`);
        }
      }
      setOnline((o) => (o[0] === wasOnline.current[0] && o[1] === wasOnline.current[1] ? o : [wasOnline.current[0], wasOnline.current[1]]));
      setNowTs(now);
    }, 250);
    return () => clearInterval(id);
  }, [engine, addLog]);

  // 图表绘制 ~8Hz
  useEffect(() => {
    const id = setInterval(() => {
      drawProfile(profileCv.current, engine);
      drawSpectrum(specCv.current, engine);
    }, 120);
    return () => clearInterval(id);
  }, [engine]);

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

  const copy = async (text: string, tag: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(tag);
    setTimeout(() => setCopied(""), 1500);
  };

    const st = engine.stats;
  const se = engine.sense;
  const mainPeak = engine.peaks.find((p) => !p.los);
  const anyLinkOnline = Object.values(links).some((s) => s === "online");
  const connected = mode === "demo" || (mode === "live" && anyLinkOnline);

  const banner =
    mode === "demo"
      ? "🧪 演示模式：下面是合成数据，不是真实 ESP32。点右上角「连接」切回真实数据。"
      : mode === "live"
        ? anyLinkOnline
          ? online[0] && online[1]
            ? "✅ ESP32-1 与 ESP32-2 都在线，数据经 MQTT 无线传来（不用接 USB）。"
            : `🟡 MQTT 已连接，等待 ESP32：${online[0] ? "" : "ESP32-1 "}${online[1] ? "" : "ESP32-2 "}上线（给板子供电并确认 WiFi 与 config.h 的 MQTT_ROOT 一致）`
          : "🔄 正在连接 MQTT 服务器…（网络不通时会自动重试，不会卡死）"
        : "⚪ 未连接";

  const sensingState = !se.calibrated
    ? `校准中 ${se.calib}/${se.calibTotal}（请保持安静）`
    : se.motion > 0.25
      ? "检测到运动"
      : se.breathBpm > 0
        ? "静止（检测到呼吸）"
        : "静止";

  return (
    <div className="flex h-screen min-h-0 flex-col bg-[#050a14] text-slate-200">
      {/* 顶栏 */}
      <header className="flex flex-wrap items-center gap-2 border-b border-slate-800 bg-[#0b1220] px-3 py-2">
        <div className="mr-2 flex items-center gap-2 text-sm font-semibold text-cyan-300">
          <span className="text-lg">📡</span>
          <span className="hidden sm:inline">双 ESP32-S3 WiFi CSI 3D 感知模拟器</span>
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <input
            readOnly
            value={url}
            onFocus={(e) => e.currentTarget.select()}
            className="min-w-0 flex-1 rounded-full border border-slate-700 bg-[#0f1a2c] px-3 py-1.5 font-mono text-xs text-slate-300 outline-none"
          />
          <button onClick={() => copy(url, "url")} className="btn-ghost whitespace-nowrap">
            {copied === "url" ? "✓ 已复制" : "复制网址"}
          </button>
          <button onClick={() => window.open(url, "_blank")} className="btn-ghost whitespace-nowrap">
            新标签打开
          </button>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setShowConnect(true)}
            className={`rounded-lg px-4 py-2 text-sm font-bold text-slate-900 shadow ${connected ? "bg-emerald-400" : "bg-cyan-400"} hover:brightness-110`}
          >
            🔌 {mode === "demo" ? "连接 ESP32" : connected ? "已连接 ESP32" : "连接 ESP32"}
          </button>
          <button
            onClick={() => {
              setShowLog(true);
              setUnread(0);
            }}
            className="relative rounded-lg border border-slate-700 bg-[#0f1a2c] px-4 py-2 text-sm font-semibold hover:bg-[#15233a]"
          >
            🩺 检测日志
            {unread > 0 && (
              <span className="absolute -right-2 -top-2 grid h-5 min-w-5 place-items-center rounded-full bg-orange-500 px-1 text-[11px] font-bold text-white">
                {unread > 99 ? "99+" : unread}
              </span>
            )}
          </button>
          <Link href="/code" className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-bold text-slate-900 hover:brightness-110">
            📋 复制代码
          </Link>
        </div>
      </header>
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-800 bg-[#0a101d] px-4 py-2 text-sm">
        <span className="min-w-0 flex-1">{banner}</span>
        <Link href="/code" className="rounded-lg bg-cyan-400 px-4 py-2 text-sm font-bold text-slate-900 hover:brightness-110">
          📋 进入复制代码界面
        </Link>
      </div>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* 左侧面板 */}
        <aside className="order-2 w-full shrink-0 space-y-3 overflow-y-auto border-slate-800 bg-[#070d18] p-3 lg:order-1 lg:w-[380px] lg:border-r">
          <section className="card">
            <div className="grid grid-cols-3 gap-y-3">
              <Stat v={`${st.chUsed}/${NCH}`} l="拼接信道" />
              <Stat v={BANDWIDTH_MHZ.toFixed(1)} l="带宽 MHz" />
              <Stat v={RESOLUTION_M.toFixed(2)} l="分辨率 m" />
              <Stat v={String(st.pairs)} l="配对数" />
              <Stat v={`${st.lostPct.toFixed(1)}%`} l="同步丢失" />
              <Stat v={String(st.sweeps)} l="剖面序号" />
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {Array.from({ length: NCH }, (_, i) => (
                <span
                  key={i}
                  className={`grid h-7 w-8 place-items-center rounded text-xs font-bold ${st.chOk[i] ? "bg-emerald-500 text-slate-900" : "bg-slate-700 text-slate-400"}`}
                >
                  {i + 1}
                </span>
              ))}
            </div>
          </section>

          <section className="card">
            <h3 className="mb-2 text-sm font-bold text-white">📶 双节点（MQTT 无线）</h3>
            {[1, 2].map((i) => {
              const s = nodes[i];
              const on = online[i - 1];
              return (
                <div key={i} className="mb-1.5 flex items-center gap-2 text-xs">
                  <span className={`h-2.5 w-2.5 rounded-full ${on ? "bg-emerald-400" : "bg-slate-600"}`} />
                  <span className="font-semibold" style={{ color: i === 1 ? "#67e8f9" : "#f9a8d4" }}>
                    ESP32-{i}
                  </span>
                  <span className="text-slate-400">
                    {on
                      ? `${s?.rssi ?? "?"}dBm · 信道${s?.ch ?? "?"} · ${nodeFps[i - 1].toFixed(0)} 帧/s · 经 ${s?.via ?? "?"}`
                      : "离线 / 等待上线"}
                  </span>
                </div>
              );
            })}
            <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
              路径：ESP32 → WiFi → MQTT 公共服务器 → 本页 WebSocket。同时连接 {BROKERS.length} 个服务器，任一断线不中断。
            </p>
          </section>

          <section className="card">
            <h3 className="mb-2 text-sm font-bold text-white">🫁 感知（来自 CSI）</h3>
            <div className="space-y-1 text-[13px] leading-relaxed">
              <div>
                状态：<b>{sensingState}</b>
              </div>
              <div>
                运动强度 {(se.motion * 100).toFixed(0)}% · z={se.motionZ.toFixed(1)}
              </div>
              <div>呼吸：{se.breathBpm > 0 ? `${se.breathBpm.toFixed(0)} 次/分（置信 ${(se.breathConf * 100).toFixed(0)}%）` : "未检出"}</div>
              <div>活动路径长度：{mainPeak ? `${mainPeak.L.toFixed(1)} m${mainPeak.dyn > 0.25 ? "（运动）" : "（静态反射）"}` : "— m"}</div>
              <div className="text-slate-400">连续帧率：{se.fastFps.toFixed(0)} Hz</div>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-slate-500">
              椭圆含义：目标位于以 ESP32-1、ESP32-2 为焦点、路径长度为 L 的椭圆上；2 个节点只能给出 L，无法确定角度。
            </p>
            <div className="mt-3 flex gap-2">
              <button className="btn-ghost" onClick={() => engine.resetCalibration()}>
                🎯 重新校准
              </button>
              {mode === "demo" ? (
                <button className="btn-ghost" onClick={() => startLive(root)}>
                  ⏹ 停止演示
                </button>
              ) : (
                <button className="btn-ghost" onClick={startDemo}>
                  ▶ 启动演示数据
                </button>
              )}
            </div>
          </section>

          <section className="card">
            <div className="flex items-center gap-3 text-sm">
              <span className="shrink-0">两节点间距</span>
              <input
                type="range"
                min={0.3}
                max={12}
                step={0.05}
                value={baseline}
                onChange={(e) => changeBaseline(parseFloat(e.target.value))}
                className="flex-1 accent-cyan-400"
              />
              <b className="w-14 text-right">{baseline.toFixed(2)}m</b>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">量一下两块 ESP32 的实际距离填在这里：最强径（直达波）会锚定在这个距离。</p>
            <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
              <Check label="距离-时间地形" v={opts.terrain} on={(v) => setOpts({ ...opts, terrain: v })} />
              <Check label="路径椭圆" v={opts.ellipses} on={(v) => setOpts({ ...opts, ellipses: v })} />
              <Check label="目标椭圆高亮" v={opts.peakEllipses} on={(v) => setOpts({ ...opts, peakEllipses: v })} />
              <Check label="自动旋转" v={opts.autoRotate} on={(v) => setOpts({ ...opts, autoRotate: v })} />
            </div>
            <div className="mt-3 flex gap-2">
              <button className="btn-ghost" onClick={() => setResetSignal((n) => n + 1)}>
                复位视角
              </button>
              <button
                className="btn-ghost"
                onClick={() => {
                  const el = sceneHost.current;
                  if (!el) return;
                  if (document.fullscreenElement) document.exitFullscreen();
                  else el.requestFullscreen?.();
                }}
              >
                全屏
              </button>
            </div>
            <p className="mt-2 text-xs text-slate-500">左键旋转 · 右键平移 · 滚轮缩放 · {fps} fps</p>
          </section>
        </aside>

        {/* 3D 区域 */}
        <main ref={sceneHost} className="relative order-1 min-h-[55vh] flex-1 overflow-hidden bg-[#050a14] lg:order-2 lg:min-h-0">
          <Scene3D engine={engine} baseline={baseline} options={opts} resetSignal={resetSignal} onFps={setFps} />
          {st.sweeps === 0 && (
            <div className="pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 rounded-full bg-slate-900/80 px-4 py-1.5 text-xs text-slate-300">
              {mode === "demo" ? "正在生成第一轮剖面…" : "等待第一轮 13 信道扫频数据（约 3~6 秒）· 想先看效果点左侧「启动演示数据」"}
            </div>
          )}
          <div className="pointer-events-none absolute bottom-3 right-3 w-[min(560px,92%)] space-y-2 rounded-xl border border-slate-800 bg-[#070d18]/85 p-3 backdrop-blur">
            <div className="flex justify-between text-xs text-slate-300">
              <span>路径长度剖面（青=剖面，粉=动态变化）</span>
              <span>L / m</span>
            </div>
            <canvas ref={profileCv} width={1120} height={200} className="h-[100px] w-full" />
            <div className="text-xs text-slate-300">
              拼接后的频谱幅度（{NB} 个频点 · 颜色=信道）
            </div>
            <canvas ref={specCv} width={1120} height={120} className="h-[56px] w-full" />
          </div>
        </main>
      </div>

      {/* 连接窗口 */}
      {showConnect && (
        <Modal title="🔌 连接 ESP32（MQTT 无线，不需要 USB）" onClose={() => setShowConnect(false)}>
          <div className="space-y-3 text-sm">
            <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-3">
              <div className="mb-1 text-xs text-slate-400">MQTT 主题根（必须与 firmware 的 config.h → MQTT_ROOT 完全一致）</div>
              <div className="flex gap-2">
                <input
                  value={root}
                  onChange={(e) => setRoot(e.target.value.trim())}
                  className="min-w-0 flex-1 rounded border border-slate-700 bg-[#0f1a2c] px-2 py-1.5 font-mono text-xs"
                />
                <button
                  className="btn-ghost"
                  onClick={() => {
                    try {
                      localStorage.setItem(LS_ROOT, root);
                    } catch {
                      /* ignore */
                    }
                    engine.resetAll();
                    startLive(root);
                  }}
                >
                  保存并连接
                </button>
              </div>
            </div>
            <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-3">
              <div className="mb-2 text-xs text-slate-400">MQTT 服务器（同时连接，ESP32 落在哪个都能收到）</div>
              {BROKERS.map((b) => (
                <div key={b.name} className="flex items-center gap-2 py-0.5 text-xs">
                  <span
                    className={`h-2.5 w-2.5 rounded-full ${links[b.name] === "online" ? "bg-emerald-400" : links[b.name] === "connecting" ? "bg-yellow-400" : "bg-slate-600"}`}
                  />
                  <span className="w-20 font-semibold">{b.name}</span>
                  <span className="text-slate-400">{links[b.name] ?? "idle"}</span>
                  <span className="ml-auto font-mono text-slate-500">{b.tcp}</span>
                </div>
              ))}
            </div>
            {[1, 2].map((i) => {
              const s = nodes[i];
              const on = online[i - 1];
              return (
                <div key={i} className="rounded-lg border border-slate-700 bg-slate-900/60 p-3">
                  <div className="flex items-center gap-2">
                    <span className={`h-2.5 w-2.5 rounded-full ${on ? "bg-emerald-400" : "bg-slate-600"}`} />
                    <b>ESP32-{i}</b>
                    <span className="text-xs text-slate-400">{on ? "在线" : "离线"}</span>
                  </div>
                  {s && on && (
                    <div className="mt-1 grid grid-cols-2 gap-x-4 text-xs text-slate-400">
                      <span>固件 {s.fw}</span>
                      <span>运行 {s.up}s</span>
                      <span>IP {s.ip}</span>
                      <span>RSSI {s.rssi}dBm / 信道 {s.ch}</span>
                      <span>堆 {s.heap ? Math.round(s.heap / 1024) : "?"}KB · PSRAM {s.psram ? (s.psram / 1048576).toFixed(1) : "?"}MB</span>
                      <span>对端 {s.peer ? "已握手" : "未发现"} · 扫频 {s.sweeps ?? 0}</span>
                      <span>CSI {s.csi ?? 0} · 缓冲丢包 {s.drop ?? 0}</span>
                      <span>发布失败 {s.pubFail ?? 0} · 服务器 {s.via}</span>
                    </div>
                  )}
                </div>
              );
            })}
            <div className="flex flex-wrap gap-2">
              {mode === "live" ? (
                <button className="btn-ghost" onClick={() => { stopAll(); setMode("idle"); setLinks({}); }}>
                  断开
                </button>
              ) : (
                <button className="btn-primary" onClick={() => startLive(root)}>
                  连接 ESP32
                </button>
              )}
              <button className="btn-ghost" onClick={() => hubRef.current?.sendCmd("sweep")}>
                立即扫频
              </button>
              <button className="btn-ghost" onClick={() => hubRef.current?.sendCmd("ping")}>
                刷新状态
              </button>
              <button className="btn-ghost" onClick={() => hubRef.current?.sendCmd("reboot")}>
                重启两块板子
              </button>
              <button className="btn-ghost" onClick={startDemo}>
                演示数据
              </button>
            </div>
            <p className="text-xs leading-relaxed text-slate-500">
              两块 ESP32 只需要供电 + 同一个 2.4GHz WiFi，不用插电脑。烧录时才需要 USB。页面在手机/别的电脑上打开也能看到同样的数据。
            </p>
          </div>
        </Modal>
      )}

      {/* 检测日志 */}
      {showLog && (
        <Modal title="🩺 检测日志" onClose={() => setShowLog(false)}>
          <div className="mb-2 flex gap-2">
            <button className="btn-ghost" onClick={() => setLogs([])}>
              清空
            </button>
            <button className="btn-ghost" onClick={() => copy(logs.map((l) => `${l.t} [${l.level}] ${l.msg}`).join("\n"), "log")}>
              {copied === "log" ? "✓ 已复制" : "复制日志"}
            </button>
          </div>
          <div className="max-h-[60vh] overflow-y-auto rounded border border-slate-800 bg-black/40 p-2 font-mono text-xs">
            {logs.length === 0 && <div className="text-slate-500">暂无日志</div>}
            {logs.map((l, i) => (
              <div key={i} className={l.level === "error" ? "text-red-400" : l.level === "warn" ? "text-orange-300" : "text-slate-300"}>
                {l.t} {l.msg}
              </div>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}

function Stat({ v, l }: { v: string; l: string }) {
  return (
    <div>
      <div className="text-2xl font-bold text-cyan-300">{v}</div>
      <div className="text-xs text-slate-400">{l}</div>
    </div>
  );
}

function Check({ label, v, on }: { label: string; v: boolean; on: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2">
      <input type="checkbox" checked={v} onChange={(e) => on(e.target.checked)} className="h-4 w-4 accent-cyan-400" />
      {label}
    </label>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-3" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-slate-700 bg-[#0b1220] p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-bold text-white">{title}</h2>
          <button onClick={onClose} className="rounded px-2 py-1 text-slate-400 hover:bg-slate-800">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function prep(cv: HTMLCanvasElement | null) {
  if (!cv) return null;
  const g = cv.getContext("2d");
  if (!g) return null;
  g.clearRect(0, 0, cv.width, cv.height);
  return g;
}

function drawProfile(cv: HTMLCanvasElement | null, engine: RadarEngine) {
  const g = prep(cv);
  if (!g || !cv) return;
  const W = cv.width;
  const H = cv.height;
  const padB = 24;
  const hh = H - padB;
  g.strokeStyle = "rgba(100,160,200,0.25)";
  g.fillStyle = "rgba(180,210,235,0.9)";
  g.font = "20px system-ui";
  for (let L = 0; L <= 25; L += 5) {
    const x = (L / 30) * W;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, hh);
    g.stroke();
    g.fillText(String(L), x + 4, H - 5);
  }
  const line = (arr: Float32Array, color: string, fill: string | null) => {
    g.beginPath();
    for (let j = 0; j < NDISP; j++) {
      const x = (j / (NDISP - 1)) * W;
      const y = hh - arr[j] * (hh - 6) - 2;
      if (j === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.strokeStyle = color;
    g.lineWidth = 3;
    g.stroke();
    if (fill) {
      g.lineTo(W, hh);
      g.lineTo(0, hh);
      g.closePath();
      g.fillStyle = fill;
      g.fill();
    }
  };
  line(engine.profile, "#22d3ee", "rgba(34,211,238,0.18)");
  line(engine.dyn, "#f472b6", null);
  for (const p of engine.peaks) {
    const x = (p.L / 30) * W;
    g.strokeStyle = p.los ? "rgba(34,211,238,0.9)" : p.dyn > 0.25 ? "rgba(255,79,216,0.9)" : "rgba(255,176,32,0.9)";
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, hh);
    g.stroke();
  }
}

function drawSpectrum(cv: HTMLCanvasElement | null, engine: RadarEngine) {
  const g = prep(cv);
  if (!g || !cv) return;
  const W = cv.width;
  const H = cv.height;
  let mx = 1e-9;
  for (let m = 0; m < NB; m++) mx = Math.max(mx, engine.spectrum[m]);
  const bw = W / NB;
  for (let m = 0; m < NB; m++) {
    const v = engine.spectrum[m] / mx;
    g.fillStyle = `hsl(${engine.spectrumCh[m] * 27 + 160},75%,55%)`;
    g.fillRect(m * bw, H - v * H, Math.max(1, bw - 0.5), v * H);
  }
}
