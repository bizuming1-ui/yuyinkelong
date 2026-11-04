"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Radar3D, { type Radar3DHandle, type SceneOpts, type SceneStatus } from "./Radar3D";
import DiagPanel, { copyText, diagCounts } from "./DiagPanel";
import { useRadar } from "@/lib/useRadar";
import { KEY_KEY, URL_KEY, parseUrls, type DetectedObject, type ObjectKind, type RadarState } from "@/lib/radar";
import type { DiagCtx, GlInfo } from "@/lib/diag";

function objIcon(kind: ObjectKind): string {
  switch (kind) {
    case "human_moving":
      return "🚶";
    case "human_breathing":
      return "🫁";
    case "static_object":
      return "📦";
    case "wifi_device":
      return "📱";
    case "router":
    default:
      return "📡";
  }
}

function objBadgeColor(kind: ObjectKind): string {
  switch (kind) {
    case "human_moving":
      return "border-orange-400/50 bg-orange-500/15 text-orange-200";
    case "human_breathing":
      return "border-emerald-400/50 bg-emerald-500/15 text-emerald-200";
    case "static_object":
      return "border-amber-400/50 bg-amber-500/15 text-amber-200";
    case "wifi_device":
      return "border-fuchsia-400/50 bg-fuchsia-500/15 text-fuchsia-200";
    case "router":
    default:
      return "border-cyan-400/50 bg-cyan-500/15 text-cyan-200";
  }
}

function Charts({ state }: { state: RadarState | null }) {
  const pr = useRef<HTMLCanvasElement>(null);
  const sp = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const draw = (cv: HTMLCanvasElement | null, fn: (g: CanvasRenderingContext2D, w: number, h: number) => void) => {
      if (!cv) return;
      const g = cv.getContext("2d");
      if (!g) return;
      const w = cv.width;
      const h = cv.height;
      g.clearRect(0, 0, w, h);
      g.fillStyle = "rgba(4,10,20,0.65)";
      g.fillRect(0, 0, w, h);
      fn(g, w, h);
    };
    const L = state?.last;
    draw(pr.current, (g, w, h) => {
      g.strokeStyle = "rgba(120,200,255,0.15)";
      for (let i = 1; i < 6; i++) {
        g.beginPath();
        g.moveTo((i * w) / 6, 0);
        g.lineTo((i * w) / 6, h);
        g.stroke();
      }
      g.fillStyle = "#7fb4d6";
      g.font = "11px sans-serif";
      for (let i = 0; i <= 6; i++) g.fillText(String(i * 5), (i * w) / 6 + 2, h - 3);
      const line = (arr: number[] | null | undefined, col: string, fill: boolean) => {
        if (!arr || !arr.length) return;
        g.beginPath();
        arr.forEach((v, i) => {
          const x = (i / (arr.length - 1)) * w;
          const y = h - 14 - (v / 255) * (h - 22);
          if (i === 0) g.moveTo(x, y);
          else g.lineTo(x, y);
        });
        g.strokeStyle = col;
        g.lineWidth = 1.6;
        g.stroke();
        if (fill) {
          g.lineTo(w, h - 14);
          g.lineTo(0, h - 14);
          g.fillStyle = col.replace("1)", "0.18)");
          g.fill();
        }
      };
      line(state?.profile, "rgba(56,232,255,1)", true);
      line(L?.music ?? null, "rgba(255,79,216,1)", false);
      // 标注检测到的物体峰值位置
      for (const obj of (L?.objects ?? []).slice(0, 6)) {
        const x = Math.min(w - 6, Math.max(6, (obj.pathLenM / 30) * w));
        g.fillStyle = obj.kind === "human_moving" ? "#fb923c" : obj.kind === "human_breathing" ? "#34d399" : "#fbbf24";
        g.beginPath();
        g.arc(x, 12, 3.5, 0, Math.PI * 2);
        g.fill();
      }
    });
    draw(sp.current, (g, w, h) => {
      const s = L?.spectrum;
      if (!s || !s.length) return;
      const n = s.length;
      for (let i = 0; i < n; i++) {
        const v = s[i] / 255;
        const ch = Math.min(13, Math.max(1, Math.round((i - 26) / 16) + 1));
        g.fillStyle = `hsla(${(ch - 1) * 24 + 170},85%,${35 + v * 30}%,${v > 0 ? 0.95 : 0.1})`;
        const bh = Math.max(1, v * (h - 6));
        g.fillRect((i / n) * w, h - bh, Math.ceil(w / n), bh);
      }
    });
  }, [state]);
  return (
    <div className="pointer-events-auto absolute bottom-3 right-3 w-[min(430px,46vw)] space-y-2 rounded-xl border border-white/10 bg-[#070f1b]/85 p-2.5 text-[11px] text-slate-300 backdrop-blur">
      <div>
        <div className="mb-1 flex justify-between">
          <span>多径剖面（青=64K-IFFT，粉=MUSIC超分辨，圆点=检出物体）</span>
          <span>L / m</span>
        </div>
        <canvas ref={pr} width={400} height={92} className="w-full rounded" />
      </div>
      <div>
        <div className="mb-1">合成宽带频谱幅度（{state?.last?.bins ?? 0} 个频点 · 颜色=等效信道）</div>
        <canvas ref={sp} width={400} height={56} className="w-full rounded" />
      </div>
    </div>
  );
}

const chip = (ok: boolean | null, text: string) => (
  <span className={`rounded-full px-2 py-0.5 text-[11px] ${ok === null ? "bg-slate-600/40 text-slate-300" : ok ? "bg-emerald-500/20 text-emerald-200" : "bg-rose-500/20 text-rose-200"}`}>{text}</span>
);

export default function SimulatorShell() {
  const [origin, setOrigin] = useState("");
  const [urlInput, setUrlInput] = useState("");
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState("radar-key");
  const [demo, setDemo] = useState(false);
  const [baseline, setBaseline] = useState(1.2);
  const [opts, setOpts] = useState<SceneOpts>({ terrain: true, ellipses: true, autoRotate: false, music: true, objects3d: true });
  const [diagOpen, setDiagOpen] = useState(false);
  const [bannerOff, setBannerOff] = useState(false);
  const [selectedObjId, setSelectedObjId] = useState<string | null>(null);
  const [gl, setGl] = useState<GlInfo>({ ok: null, renderer: "", error: "" });
  const [fps, setFps] = useState(0);
  const [pixelRatio, setPixelRatio] = useState(1);
  const [toast, setToast] = useState("");
  const [hosted, setHosted] = useState(false);
  const sceneRef = useRef<Radar3DHandle>(null);
  const { stateRef, rowsRef, state, conn, events, serverDiag, post, clearEvents } = useRadar(url, demo, baseline);

  useEffect(() => {
    const curOrigin = window.location.origin;
    setOrigin(curOrigin);
    let u = localStorage.getItem(URL_KEY) || "";
    setUrlInput(u);
    setUrl(parseUrls(u).join(" "));
    if (/^https?:/.test(window.location.protocol)) {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 3500);
      fetch(curOrigin + "/api/health", { cache: "no-store", signal: ctl.signal })
        .then((r) => r.json())
        .then((j) => {
          if (j && j.kind === "csi-radar" && !u) {
            u = curOrigin;
            setHosted(true);
            setUrlInput(u);
            setUrl(u);
          }
        })
        .catch(() => undefined)
        .finally(() => clearTimeout(to));
    }
    setApiKey(localStorage.getItem(KEY_KEY) || "radar-key");
    const b = parseFloat(localStorage.getItem("radar.baseline") || "1.2");
    if (b > 0) setBaseline(b);
  }, []);

  const flash = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(""), 2400);
  };

  const connect = () => {
    const n = parseUrls(urlInput).join(" ");
    setUrlInput(n);
    localStorage.setItem(URL_KEY, n);
    setDemo(false);
    setUrl(n);
    setBannerOff(false);
    flash(n ? "正在连接 " + n : "已清除网址");
  };

  const connectLocalBuiltIn = () => {
    const localUrl = window.location.origin;
    setUrlInput(localUrl);
    localStorage.setItem(URL_KEY, localUrl);
    setDemo(false);
    setUrl(localUrl);
    setBannerOff(false);
    flash("已连接内置主机端 " + localUrl);
  };

  const onStatus = useCallback((s: SceneStatus) => {
    setGl((o) => (o.ok === s.gl && o.renderer === s.renderer && o.error === s.error ? o : { ok: s.gl, renderer: s.renderer, error: s.error }));
    setFps(s.fps);
    setPixelRatio(s.pixelRatio);
  }, []);

  const ctx: DiagCtx = useMemo(() => ({ url, demo, conn, state, gl, fps, pixelRatio, serverDiag }), [url, demo, conn, state, gl, fps, pixelRatio, serverDiag]);
  const counts = diagCounts(ctx);

  const baseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onBaseline = (v: number) => {
    setBaseline(v);
    localStorage.setItem("radar.baseline", String(v));
    if (baseTimer.current) clearTimeout(baseTimer.current);
    if (url && !demo) baseTimer.current = setTimeout(() => post("/api/config", { baselineM: v }, apiKey), 800);
  };

  const L = state?.last ?? null;
  const planN = !state || state.plan > 3 ? 13 : 3;
  const hasData = !!L;
  const isSingle = Boolean(state?.singleNode || L?.mode === "single-node" || state?.nodes.A.info?.mode === "single");
  const objects: DetectedObject[] = L?.objects ?? [];

  let banner: { title: string; body: string } | null = null;
  if (!demo && !hasData) {
    if (!url) {
      banner = {
        title: "欢迎使用 ESP32-S3 单节点全能 WiFi 成像与物体检测模拟器 (v11)",
        body: "① 在 Kaggle 运行单文件脚本后，把输出框里的网址粘贴到上方「Kaggle 网址」点「连接」；② 或点下方「▶ 启动全物体检测演示」立即体验 1 块 ESP32-S3 检测任何物体的 3D 效果。",
      };
    } else if (conn.status === "error" || conn.healthOk === false) {
      banner = {
        title: conn.reach === "blocked" ? "网络无法直连该隧道网址" : conn.reach === "dead" ? "Kaggle 隧道网址已更新" : "正在重连 Kaggle 主机…",
        body: `${conn.lastErr || conn.healthMsg}。${conn.hint || "请确认 Kaggle Cell 正在运行，或复制 Kaggle 输出框中的 pinggy / lhr.life 备用网址。"}`,
      };
    } else if (conn.status === "connecting") {
      banner = { title: "正在连接 Kaggle 零断连多隧道引擎…", body: url };
    } else if (state && !state.nodes.A.uploads && !state.nodes.B.uploads) {
      banner = {
        title: "Kaggle 已连接 ✓，等待 1 块 ESP32-S3 上传 CSI 数据",
        body: "只需烧录 1 块 ESP32-S3（进入复制代码界面 → ③ PlatformIO 代码 → Node A 工程）并供电；板子连上 2.4GHz WiFi/手机热点后约 2 秒即出图。",
      };
    } else if (state) {
      banner = {
        title: "ESP32-S3 已上线，正在合成第一帧全频段 CSI 剖面与空间物体…",
        body: `ESP32-S3 主节点 ${state.nodes.A.online ? "在线" : "离线"}，约 1~2 秒即可完成首次相位标定与空间物体建模。`,
      };
    }
  }

  return (
    <div className="fixed inset-0 flex flex-col bg-[#0b0f17] text-slate-100">
      {/* 浏览器模拟器顶栏（含本站网址复制 + Kaggle 连接 + 右上角复制代码按键） */}
      <div className="flex shrink-0 items-center gap-2 border-b border-white/10 bg-[#1c212c] px-3 py-1.5">
        <div className="hidden gap-1.5 sm:flex">
          <i className="h-3 w-3 rounded-full bg-[#ff5f57]" />
          <i className="h-3 w-3 rounded-full bg-[#febc2e]" />
          <i className="h-3 w-3 rounded-full bg-[#28c840]" />
        </div>
        <button onClick={() => window.location.reload()} title="刷新浏览器模拟器" className="rounded px-2 py-1 text-slate-300 hover:bg-white/10">
          ⟳
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-full bg-[#0e131c] px-3 py-1 text-sm">
          <span>🔒</span>
          <span className="truncate font-mono text-[13px] text-cyan-200">{origin ? `${origin}/` : "https://localhost:3000/"}</span>
          <button
            onClick={async () => flash((await copyText((origin || window.location.origin) + "/")) ? "已复制浏览器模拟器网址" : "复制失败")}
            className="ml-auto shrink-0 rounded bg-cyan-500/20 px-2.5 py-0.5 text-xs font-semibold text-cyan-200 hover:bg-cyan-500/30"
          >
            复制网址
          </button>
          <a
            href={(origin || "") + "/"}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 rounded bg-white/10 px-2.5 py-0.5 text-xs hover:bg-white/20"
          >
            打开此网址 ↗
          </a>
        </div>
        <div className="flex items-center gap-1.5">
          <input
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && connect()}
            placeholder="粘贴 Kaggle 网址（支持一次粘贴多个备用网址）"
            className="w-[270px] rounded-md border border-white/10 bg-[#0e131c] px-2.5 py-1.5 text-[13px] outline-none placeholder:text-slate-500 focus:border-cyan-400/60 max-lg:hidden"
          />
          <button onClick={connect} className="rounded-md bg-cyan-500 px-3 py-1.5 text-[13px] font-semibold text-slate-900 hover:bg-cyan-400">
            连接
          </button>
        </div>
        <button
          onClick={() => setDiagOpen((v) => !v)}
          className={`relative rounded-md border px-3 py-1.5 text-[13px] ${diagOpen ? "border-cyan-400 bg-cyan-500/20" : "border-white/15 bg-white/5 hover:bg-white/10"}`}
        >
          🩺 检测日志
          {(counts.fail > 0 || counts.warn > 0) && (
            <span className={`absolute -right-1.5 -top-1.5 rounded-full px-1.5 text-[10px] font-bold ${counts.fail ? "bg-rose-500" : "bg-amber-500 text-slate-900"}`}>
              {counts.fail || counts.warn}
            </span>
          )}
        </button>
        {/* 右上角：复制代码按键 */}
        <Link href="/code" className="rounded-md bg-emerald-400 px-3.5 py-1.5 text-[13px] font-bold text-slate-900 shadow hover:bg-emerald-300">
          📋 复制代码
        </Link>
      </div>

      {/* 第二栏：提供打开本网站的醒目网址 + 「进入复制代码界面」按键 */}
      <div className="flex shrink-0 flex-wrap items-center gap-2.5 border-b border-white/10 bg-[#121723] px-4 py-1.5 text-[12.5px] text-slate-300">
        <span className="flex items-center gap-1.5">
          <span>🌐 模拟器网址：</span>
          <code className="rounded bg-black/40 px-2 py-0.5 font-mono text-cyan-300">{origin ? `${origin}/` : "…"}</code>
          <button
            onClick={async () => flash((await copyText((origin || window.location.origin) + "/")) ? "已复制网站网址，可直接粘贴到浏览器打开" : "复制失败")}
            className="rounded border border-cyan-400/30 bg-cyan-500/10 px-2 py-0.5 text-xs text-cyan-200 hover:bg-cyan-500/20"
          >
            一键复制网址
          </button>
        </span>
        <span className="text-slate-400 max-md:hidden">
          {hosted ? "· ✅ 同源直连 Kaggle 主机（零跨域）" : "· ★ v11 支持仅用 1 个 ESP32-S3 实现完整 WiFi 成像与全物体检测（零断连）"}
        </span>
        <input
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && connect()}
          placeholder="Kaggle 网址"
          className="w-[200px] rounded-md border border-white/10 bg-[#0e131c] px-2 py-1 text-[12px] outline-none lg:hidden"
        />
        <Link
          href="/code"
          className="ml-auto rounded-lg bg-gradient-to-r from-cyan-400 to-emerald-400 px-4 py-1.5 text-[13px] font-extrabold text-slate-900 shadow-md hover:brightness-110"
        >
          📋 进入复制代码界面
        </Link>
      </div>

      {/* 3D 视口与叠加 HUD */}
      <div className="relative min-h-0 flex-1">
        <Radar3D
          ref={sceneRef}
          stateRef={stateRef}
          rowsRef={rowsRef}
          baselineM={baseline}
          opts={opts}
          selectedObjId={selectedObjId}
          onStatus={onStatus}
        />

        {gl.ok === false && (
          <div className="absolute inset-0 z-30 grid place-items-center bg-[#040a14]/90 p-6 text-center">
            <div className="max-w-md rounded-xl border border-rose-400/40 bg-[#0b1220] p-5">
              <div className="mb-2 text-lg font-bold text-rose-300">❌ 浏览器未能创建 3D (WebGL)</div>
              <div className="text-sm text-slate-300">{gl.error}</div>
              <div className="mt-3 text-xs text-slate-400">请使用 Chrome / Edge 并开启硬件加速。</div>
            </div>
          </div>
        )}

        {/* 左侧多功能感知与物体检测面板 */}
        <div className="pointer-events-none absolute left-3 top-3 flex max-h-[calc(100%-24px)] w-[min(355px,92vw)] flex-col gap-2 overflow-y-auto pr-1">
          {/* 1. 系统与节点状态卡片 */}
          <div className="pointer-events-auto rounded-xl border border-white/10 bg-[#070f1b]/88 p-3 backdrop-blur">
            <div className="flex items-center gap-2">
              <b className="text-[15px]">📡 WiFi CSI 成像雷达 v11</b>
              {demo ? (
                <span className="rounded bg-amber-400 px-1.5 py-0.5 text-[11px] font-bold text-slate-900">全物体仿真</span>
              ) : (
                chip(hasData, hasData ? "实时成像中" : conn.status === "ok" ? "等待 ESP32" : "待连接")
              )}
            </div>
            <div className="mt-1 text-[11.5px] leading-snug text-slate-400">
              1×ESP32-S3 单节点全能模式（自动兼容双节点）· 相位消噪 · 64K-IFFT + MUSIC 超分辨 · SVD 静/动分离全物体检测
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {chip(
                state ? (state.nodes.A.uploads ? state.nodes.A.online : false) : null,
                `ESP32-S3 ${state ? (state.nodes.A.uploads ? (state.nodes.A.online ? "在线" : "离线") : "待上线") : "—"}`,
              )}
              {chip(
                L ? true : null,
                isSingle ? "单节点零断连模式" : L?.mode === "two-way" ? "双节点双向标定" : "自适应感知",
              )}
              {chip(objects.length > 0 ? true : null, `检出物体 ${objects.length} 个`)}
            </div>
            <div className="mt-2 grid grid-cols-3 gap-x-2 gap-y-1 text-[11.5px]">
              <div>
                <div className="text-lg font-bold text-cyan-200">{L ? `${L.channelsOk.length}/${planN}` : "—"}</div>
                等效信道
              </div>
              <div>
                <div className="text-lg font-bold text-cyan-200">{L ? L.bwMHz : "—"}</div>
                带宽 MHz
              </div>
              <div>
                <div className="text-lg font-bold text-cyan-200">{L ? L.resM : "—"}</div>
                分辨率 m
              </div>
              <div>
                <div className="text-lg font-bold text-cyan-200">{L ? L.pairs : "—"}</div>
                相干样本
              </div>
              <div>
                <div className="text-lg font-bold text-cyan-200">{L?.macCount ?? state?.nodes.A.info?.macs ?? "—"}</div>
                辐射源数
              </div>
              <div>
                <div className="text-lg font-bold text-cyan-200">{state ? state.seq : "—"}</div>
                剖面序号
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {Array.from({ length: planN === 13 ? 13 : 3 }, (_, i) => (planN === 13 ? i + 1 : [1, 6, 11][i])).map((c) => (
                <span
                  key={c}
                  className={`grid h-5 w-5 place-items-center rounded text-[10.5px] font-semibold ${
                    L?.channelsOk.includes(c) ? "bg-emerald-400/85 text-slate-900" : "bg-slate-700/60 text-slate-400"
                  }`}
                >
                  {c}
                </span>
              ))}
            </div>
          </div>

          {/* 2. ★ 实时检测到的任何物体列表（点击可在 3D 场景高亮聚焦） */}
          <div className="pointer-events-auto rounded-xl border border-cyan-400/25 bg-[#070f1b]/90 p-3 text-[12px] backdrop-blur">
            <div className="flex items-center justify-between">
              <b className="text-[13px] text-cyan-200">🎯 实时检测到的空间物体 ({objects.length})</b>
              <span className="text-[10.5px] text-slate-400">点击目标定位 3D 视角</span>
            </div>
            {objects.length > 0 ? (
              <div className="mt-2 max-h-[210px] space-y-1.5 overflow-y-auto pr-0.5">
                {objects.map((obj) => {
                  const isSel = selectedObjId === obj.id;
                  return (
                    <button
                      key={obj.id}
                      onClick={() => {
                        setSelectedObjId(obj.id);
                        sceneRef.current?.focusObject(obj);
                      }}
                      className={` flex w-full items-start gap-2 rounded-lg border p-2 text-left transition ${
                        isSel ? "border-cyan-300 bg-cyan-500/20" : "border-white/10 bg-white/5 hover:bg-white/10"
                      }`}
                    >
                      <span className="text-base leading-none">{objIcon(obj.kind)}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate font-semibold text-slate-100">{obj.label}</span>
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-[11px] text-slate-300">
                          <span className="text-cyan-300">距离 R={obj.rangeM}m</span>
                          <span>路径 L={obj.pathLenM}m</span>
                          <span>{obj.db}dB</span>
                          <span className={`rounded border px-1 py-0 text-[10px] ${objBadgeColor(obj.kind)}`}>
                            置信 {Math.round(obj.confidence * 100)}%
                          </span>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="mt-1.5 text-slate-400">
                等待 CSI 数据流或点击下方「▶ 启动全物体检测演示」立即查看空间多物体 3D 成像。
              </div>
            )}
          </div>

          {/* 3. 人体存在 / 运动 / 呼吸微动感知卡片 */}
          <div className="pointer-events-auto rounded-xl border border-white/10 bg-[#070f1b]/88 p-3 text-[12px] backdrop-blur">
            <b className="text-[13px]">🫁 生命体征与微动感知</b>
            {L ? (
              <div className="mt-1 space-y-0.5 text-slate-300">
                <div>
                  状态：
                  <b className={L.sense.level === "moving" ? "text-orange-300" : L.sense.level === "still" ? "text-emerald-300" : "text-slate-200"}>
                    {
                      {
                        calibrating: `自适应建模中 ${L.sense.calN}/${L.sense.calNeed}（立即可检出物体）`,
                        none: "环境平稳（显示静态反射物体）",
                        still: "检出静止目标 / 呼吸微动",
                        moving: "检出动态目标 / 运动物体",
                      }[L.sense.level]
                    }
                  </b>
                </div>
                <div>
                  运动能量 {(L.sense.motion * 100).toFixed(0)}% · 显著性 z={L.sense.z}
                </div>
                <div>
                  呼吸频率：{L.sense.breathBpm ? <b className="text-emerald-300">{L.sense.breathBpm} 次/分 (BPM)</b> : "监听中"}（置信 {L.sense.breathConf}）
                </div>
                <div>
                  最强活动路径：{L.sense.activeR ?? "—"} m
                </div>
              </div>
            ) : (
              <div className="mt-1 text-slate-400">尚未连接数据源。</div>
            )}
            <div className="mt-2 flex flex-wrap gap-1.5">
              <button
                onClick={() =>
                  demo
                    ? flash("演示模式已自动完成校准")
                    : post("/api/calibrate", {}, apiKey).then((ok) => flash(ok ? "已发送重新校准指令" : "校准请求失败"))
                }
                className="rounded-md bg-white/10 px-2.5 py-1 hover:bg-white/20"
              >
                🎯 重新校准基线
              </button>
              <button
                onClick={() => {
                  setDemo((d) => !d);
                  setBannerOff(false);
                }}
                className={`rounded-md px-2.5 py-1 font-semibold ${
                  demo ? "bg-amber-400 text-slate-900" : "bg-emerald-400/20 text-emerald-200 hover:bg-emerald-400/30"
                }`}
              >
                {demo ? "■ 关闭演示" : "▶ 启动全物体检测演示"}
              </button>
              <button onClick={connectLocalBuiltIn} className="rounded-md bg-cyan-500/20 px-2.5 py-1 text-cyan-200 hover:bg-cyan-500/30">
                ⚡ 连本站内置主机
              </button>
            </div>
          </div>

          {/* 4. Kaggle T4×2 / 30GiB RAM / 57.6GiB Disk 资源与多隧道监控 */}
          {state && (
            <div className="pointer-events-auto rounded-xl border border-white/10 bg-[#070f1b]/88 p-3 text-[12px] backdrop-blur">
              <b className="text-[13px]">
                🖥️ 云端资源利用 {state.gpu.cuda ? `· ${state.gpu.cuda}×T4 GPU` : "· CPU 引擎"}
              </b>
              {state.gpu.cuda > 0 ? (
                <div className="mt-1 space-y-1 text-slate-300">
                  {state.gpu.devices.map((d, i) => (
                    <div key={i}>
                      <div className="truncate text-[11px] text-slate-400">{d}</div>
                      <div className="flex items-center gap-2">
                        <div className="h-2 flex-1 overflow-hidden rounded bg-white/10">
                          <div
                            className="h-full bg-gradient-to-r from-cyan-400 to-emerald-400"
                            style={{
                              width: `${Math.min(
                                100,
                                state.gpu.memTotalMB?.[i]
                                  ? ((state.gpu.memUsedMB?.[i] || 0) / state.gpu.memTotalMB[i]) * 100
                                  : 80,
                              )}%`,
                            }}
                          />
                        </div>
                        <span className="font-mono text-[11px]">
                          {state.gpu.memUsedMB?.[i] ?? state.gpu.vramHeldMB?.[i] ?? 0}/{state.gpu.memTotalMB?.[i] ?? 15360}MB ·{" "}
                          {state.gpu.util?.[i] ?? 0}%
                        </span>
                      </div>
                    </div>
                  ))}
                  <div className="text-[11px] text-slate-400">
                    NFFT={state.gpu.nfft} · IFFT {state.gpu.cir_ms}ms · MUSIC {state.gpu.music_ms}ms · 显存池 {JSON.stringify(state.gpu.vramHeldMB)}MB
                  </div>
                </div>
              ) : (
                <div className="mt-1 text-[11.5px] text-amber-200">
                  当前使用高速向量化引擎（Kaggle Notebook 右侧 Accelerator 选 GPU T4 x2 可激活双卡 30GiB 显存加速）
                </div>
              )}
              <div className="mt-1 text-[11px] text-slate-400">
                内存 {state.gpu.ramGB ?? "—"}/{state.gpu.ramTotalGB ?? "—"} GB
                {state.gpu.ramRingMB ? ` (环形池 ${state.gpu.ramRingMB} MB)` : ""} · 磁盘剩余 {state.gpu.diskFreeGB ?? "—"}/
                {state.gpu.diskTotalGB ?? "—"} GB
              </div>
              {state.tunnels && state.tunnels.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {state.tunnels.map((t) => (
                    <button
                      key={t.name}
                      onClick={() => {
                        setUrlInput(t.url);
                        localStorage.setItem(URL_KEY, t.url);
                        setUrl(t.url);
                        flash("已切换到隧道 " + t.name);
                      }}
                      className={`rounded px-1.5 py-0.5 text-[10.5px] ${
                        t.ok ? "bg-emerald-500/20 text-emerald-200 hover:bg-emerald-500/30" : "bg-slate-700 text-slate-400"
                      }`}
                    >
                      {t.name} {t.ms ? `${t.ms}ms` : ""}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 5. 3D 视口控制面板 */}
          <div className="pointer-events-auto rounded-xl border border-white/10 bg-[#070f1b]/88 p-3 text-[12px] backdrop-blur">
            <label className="flex items-center gap-2">
              <span className="w-28 shrink-0 text-slate-300">ESP32↔路由器间距</span>
              <input
                type="range"
                min={0.4}
                max={15}
                step={0.1}
                value={baseline}
                onChange={(e) => onBaseline(parseFloat(e.target.value))}
                className="flex-1"
              />
              <b className="w-12 text-right">{baseline.toFixed(1)}m</b>
            </label>
            <div className="mt-2 grid grid-cols-2 gap-1">
              {(
                [
                  ["objects3d", "3D 检测物体包围盒"],
                  ["terrain", "距离-时间瀑布地形"],
                  ["ellipses", "多径反射椭圆"],
                  ["music", "MUSIC 超分辨峰"],
                  ["autoRotate", "3D 自动旋转"],
                ] as const
              ).map(([k, t]) => (
                <label key={k} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={opts[k] !== false}
                    onChange={(e) => setOpts((o) => ({ ...o, [k]: e.target.checked }))}
                  />
                  {t}
                </label>
              ))}
            </div>
            <div className="mt-2 flex gap-1.5">
              <button
                onClick={() => {
                  setSelectedObjId(null);
                  sceneRef.current?.resetView();
                }}
                className="rounded-md bg-white/10 px-2.5 py-1 hover:bg-white/20"
              >
                复位视角
              </button>
              <button onClick={() => document.documentElement.requestFullscreen?.()} className="rounded-md bg-white/10 px-2.5 py-1 hover:bg-white/20">
                全屏显示
              </button>
            </div>
            <div className="mt-1.5 text-[11px] text-slate-500">左键旋转 · 右键平移 · 滚轮缩放 · {fps.toFixed(0)} fps</div>
          </div>
        </div>

        {/* 顶部状态引导横幅 */}
        {banner && !bannerOff && (
          <div className="pointer-events-auto absolute left-1/2 top-3 z-20 w-[min(580px,calc(100%-740px))] min-w-[300px] -translate-x-1/2 rounded-xl border border-cyan-400/35 bg-[#091526]/95 p-3.5 text-center shadow-xl backdrop-blur max-xl:left-[370px] max-xl:w-[calc(100%-390px)] max-xl:translate-x-0 max-md:left-3 max-md:top-auto max-md:bottom-3 max-md:w-[calc(100%-24px)]">
            <div className="flex items-start gap-2">
              <div className="flex-1 text-left">
                <div className="text-sm font-bold text-cyan-200">{banner.title}</div>
                <div className="mt-1 text-[12px] leading-snug text-slate-200">{banner.body}</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    onClick={() => {
                      setDemo(true);
                      setBannerOff(true);
                    }}
                    className="rounded-md bg-emerald-400 px-3 py-1 text-xs font-bold text-slate-900 hover:bg-emerald-300"
                  >
                    ▶ 立即启动 1×ESP32-S3 全物体检测演示
                  </button>
                  <button
                    onClick={connectLocalBuiltIn}
                    className="rounded-md bg-cyan-500/25 px-3 py-1 text-xs font-semibold text-cyan-200 hover:bg-cyan-500/35"
                  >
                    ⚡ 连接本站内置雷达主机
                  </button>
                  <Link href="/code" className="rounded-md bg-white/10 px-3 py-1 text-xs text-slate-200 hover:bg-white/20">
                    📋 去复制代码 (GitHub / Kaggle / PlatformIO)
                  </Link>
                </div>
              </div>
              <button onClick={() => setDiagOpen(true)} className="rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/20">
                检测日志
              </button>
              <button onClick={() => setBannerOff(true)} className="rounded px-1.5 py-0.5 text-slate-400 hover:bg-white/10">
                ✕
              </button>
            </div>
          </div>
        )}

        <Charts state={state} />
        {diagOpen && <DiagPanel ctx={ctx} events={events} onClear={clearEvents} onClose={() => setDiagOpen(false)} />}
        {toast && (
          <div className="pointer-events-none fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-full bg-cyan-400 px-4 py-1.5 text-sm font-semibold text-slate-950 shadow-lg">
            {toast}
          </div>
        )}
      </div>
    </div>
  );
}
