import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Radar3D, { type Radar3DHandle, type SceneOpts, type SceneStatus } from "./Radar3D";
import DiagPanel, { copyText, diagCounts } from "./DiagPanel";
import { useRadar } from "@/lib/useRadar";
import { KEY_KEY, URL_KEY, parseUrls, type RadarState } from "@/lib/radar";
import type { DiagCtx, GlInfo } from "@/lib/diag";

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
      g.fillStyle = "rgba(4,10,20,0.6)";
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
    <div className="pointer-events-auto absolute bottom-3 right-3 w-[min(420px,46vw)] space-y-2 rounded-xl border border-white/10 bg-[#070f1b]/80 p-2.5 text-[11px] text-slate-300 backdrop-blur">
      <div>
        <div className="mb-1 flex justify-between"><span>路径长度剖面（青=IFFT，粉=MUSIC）</span><span>L / m</span></div>
        <canvas ref={pr} width={400} height={92} className="w-full rounded" />
      </div>
      <div>
        <div className="mb-1">拼接后的频谱幅度（{state?.last?.bins ?? 0} 个频点 · 颜色=信道）</div>
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
  const [baseline, setBaseline] = useState(3);
  const [opts, setOpts] = useState<SceneOpts>({ terrain: true, ellipses: true, autoRotate: false, music: true });
  const [diagOpen, setDiagOpen] = useState(false);
  const [bannerOff, setBannerOff] = useState(false);
  const [gl, setGl] = useState<GlInfo>({ ok: null, renderer: "", error: "" });
  const [fps, setFps] = useState(0);
  const [pixelRatio, setPixelRatio] = useState(1);
  const [toast, setToast] = useState("");
  const sceneRef = useRef<Radar3DHandle>(null);
  const { stateRef, rowsRef, state, conn, events, serverDiag, post, clearEvents } = useRadar(url, demo, baseline);

  const [hosted, setHosted] = useState(false);
  useEffect(() => {
    setOrigin(window.location.origin);
    let u = localStorage.getItem(URL_KEY) || "";
    setUrlInput(u);
    setUrl(parseUrls(u).join(" "));
    // 如果本页就是 Kaggle 主机直接提供的（从 Kaggle 输出框点开），同源访问：无跨域、无混合内容、最稳
    if (/^https?:/.test(window.location.protocol)) {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 4000);
      fetch(window.location.origin + "/api/health", { cache: "no-store", signal: ctl.signal })
        .then((r) => r.json())
        .then((j) => {
          if (j && j.kind === "csi-radar") {
            u = window.location.origin;
            setHosted(true);
            setUrlInput(u);
            setUrl(u);
          }
        })
        .catch(() => undefined)
        .finally(() => clearTimeout(to));
    }
    setApiKey(localStorage.getItem(KEY_KEY) || "radar-key");
    const b = parseFloat(localStorage.getItem("radar.baseline") || "3");
    if (b > 0) setBaseline(b);
  }, []);

  const flash = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(""), 2200);
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
  const onStatus = useCallback((s: SceneStatus) => {
    setGl((o) => (o.ok === s.gl && o.renderer === s.renderer && o.error === s.error ? o : { ok: s.gl, renderer: s.renderer, error: s.error }));
    setFps(s.fps);
    setPixelRatio(s.pixelRatio);
  }, []);
  const ctx: DiagCtx = useMemo(() => ({ url, demo, conn, state, gl, fps, pixelRatio, serverDiag }), [url, demo, conn, state, gl, fps, pixelRatio, serverDiag]);
  const counts = diagCounts(ctx);

  // 基线（两节点间距）改动：本地保存 + 通知主机重新校准（防抖）
  const baseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onBaseline = (v: number) => {
    setBaseline(v);
    localStorage.setItem("radar.baseline", String(v));
    if (baseTimer.current) clearTimeout(baseTimer.current);
    if (url && !demo) baseTimer.current = setTimeout(() => post("/api/config", { baselineM: v }, apiKey), 900);
  };

  const L = state?.last ?? null;
  const planN = !state || state.plan > 3 ? 13 : 3;
  const hasData = !!L;
  let banner: { title: string; body: string } | null = null;
  if (!demo && !hasData) {
    if (!url) banner = { title: "第 1 步：填写 Kaggle 网址", body: "在 Kaggle 输出框里复制那个方框里的 https://xxxx.trycloudflare.com，粘贴到上面「Kaggle 网址」输入框，点「连接」。下面的 3D 世界已经是真实渲染，只是还没有数据。" };
    else if (conn.status === "error" || conn.healthOk === false) banner = { title: conn.reach === "blocked" ? "浏览器连不到 Kaggle 网址（网络层不通）" : conn.reach === "dead" ? "Kaggle 隧道已失效 / 网址是旧的" : "连不上 Kaggle 主机", body: `${conn.lastErr || conn.healthMsg}。${conn.hint || "Kaggle 的 Cell 还在运行吗？网址是不是上次的旧网址（每次运行都会变）？"}` };
    else if (conn.status === "connecting") banner = { title: "正在连接 Kaggle…", body: url };
    else if (state && !state.nodes.A.uploads && !state.nodes.B.uploads) banner = { title: "Kaggle 已连接 ✓，等待 ESP32 上传", body: "两块 ESP32 还没有出现在主机上：确认 config.h 里的 WiFi(2.4GHz)、KAGGLE_URL、API_KEY 已烧录并给板子供电；串口应出现 [upload] HTTP 200。点「🩺 检测日志」看卡在哪一步。" };
    else if (state) banner = { title: "ESP32 已在线，等待双节点同步出第一帧", body: `Node A ${state.nodes.A.online ? "在线" : "离线"} / Node B ${state.nodes.B.online ? "在线" : "离线"}。第一帧约需一个“扫描+上传”周期（3~8 秒）；一直没有就看串口 [sync] 行。` };
  }

  const nodeChip = (k: "A" | "B") => {
    const n = state?.nodes[k];
    return chip(n ? (n.uploads ? n.online : false) : null, `Node ${k} ${n ? (n.uploads ? (n.online ? "在线" : "离线") : "未上线") : "—"}`);
  };

  return (
    <div className="fixed inset-0 flex flex-col bg-[#0b0f17] text-slate-100">
      {/* 浏览器外壳 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-white/10 bg-[#1c212c] px-3 py-1.5">
        <div className="hidden gap-1.5 sm:flex">
          <i className="h-3 w-3 rounded-full bg-[#ff5f57]" /><i className="h-3 w-3 rounded-full bg-[#febc2e]" /><i className="h-3 w-3 rounded-full bg-[#28c840]" />
        </div>
        <button onClick={() => window.location.reload()} title="刷新" className="rounded px-2 py-1 text-slate-300 hover:bg-white/10">⟳</button>
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-full bg-[#0e131c] px-3 py-1 text-sm">
          <span>🔒</span>
          <span className="truncate font-mono text-[13px] text-slate-200">{origin || "…"}/</span>
          <button onClick={async () => flash((await copyText(origin + "/")) ? "已复制本站网址" : "复制失败")} className="ml-auto rounded bg-white/10 px-2 py-0.5 text-xs hover:bg-white/20">复制网址</button>
          <a href={origin + "/"} target="_blank" rel="noreferrer" className="rounded bg-white/10 px-2 py-0.5 text-xs hover:bg-white/20">新标签打开</a>
        </div>
        <div className="flex items-center gap-1.5">
          <input
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && connect()}
            placeholder="Kaggle 网址 https://xxxx.trycloudflare.com（或 lhr.life / pinggy）"
            className="w-[260px] rounded-md border border-white/10 bg-[#0e131c] px-2.5 py-1.5 text-[13px] outline-none placeholder:text-slate-500 focus:border-cyan-400/60 max-lg:hidden"
          />
          <button onClick={connect} className="rounded-md bg-cyan-500 px-3 py-1.5 text-[13px] font-semibold text-slate-900 hover:bg-cyan-400">连接</button>
        </div>
        <button onClick={() => setDiagOpen((v) => !v)} className={`relative rounded-md border px-3 py-1.5 text-[13px] ${diagOpen ? "border-cyan-400 bg-cyan-500/20" : "border-white/15 bg-white/5 hover:bg-white/10"}`}>
          🩺 检测日志
          {(counts.fail > 0 || counts.warn > 0) && (
            <span className={`absolute -right-1.5 -top-1.5 rounded-full px-1.5 text-[10px] font-bold ${counts.fail ? "bg-rose-500" : "bg-amber-500 text-slate-900"}`}>{counts.fail || counts.warn}</span>
          )}
        </button>
        <a href="#/code" className="rounded-md bg-emerald-400 px-3 py-1.5 text-[13px] font-semibold text-slate-900 hover:bg-emerald-300">📋 复制代码</a>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-white/10 bg-[#121723] px-4 py-1.5 text-[13px] text-slate-300">
        <span>{hosted ? "✅ 本页由 Kaggle 主机直接提供（同源连接，无跨域）。分享给别人：复制上面的网址。ESP32 数据来自 Kaggle（不用接 USB）。" : "🌐 要在别的电脑/手机打开本模拟器，就复制上面的网址。ESP32 数据来自 Kaggle 网址（不用接 USB）。"}</span>
        <input
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && connect()}
          placeholder="Kaggle 网址"
          className="w-[220px] rounded-md border border-white/10 bg-[#0e131c] px-2 py-1 text-[12px] outline-none lg:hidden"
        />
        <a href="#/code" className="ml-auto rounded-md bg-gradient-to-r from-cyan-400 to-emerald-400 px-4 py-1.5 font-bold text-slate-900 shadow hover:brightness-110">📋 进入复制代码界面</a>
      </div>

      {/* 视口 */}
      <div className="relative min-h-0 flex-1">
        <Radar3D ref={sceneRef} stateRef={stateRef} rowsRef={rowsRef} baselineM={baseline} opts={opts} onStatus={onStatus} />

        {gl.ok === false && (
          <div className="absolute inset-0 z-30 grid place-items-center bg-[#040a14]/90 p-6 text-center">
            <div className="max-w-md rounded-xl border border-rose-400/40 bg-[#0b1220] p-5">
              <div className="mb-2 text-lg font-bold text-rose-300">❌ 这个浏览器没能创建 3D（WebGL）</div>
              <div className="text-sm text-slate-300">{gl.error}</div>
              <div className="mt-3 text-xs text-slate-400">请用电脑版 Chrome / Edge，设置里打开「使用图形加速功能」；打开右上角「🩺 检测日志」可复制详细信息。</div>
            </div>
          </div>
        )}

        {/* 左侧面板 */}
        <div className="pointer-events-none absolute left-3 top-3 flex max-h-[calc(100%-24px)] w-[min(340px,92vw)] flex-col gap-2 overflow-y-auto pr-1">
          <div className="pointer-events-auto rounded-xl border border-white/10 bg-[#070f1b]/85 p-3 backdrop-blur">
            <div className="flex items-center gap-2">
              <b className="text-[15px]">📡 WiFi CSI 雷达</b>
              {demo ? <span className="rounded bg-amber-400 px-1.5 py-0.5 text-[11px] font-bold text-slate-900">演示数据</span> : chip(hasData, hasData ? "真实数据" : conn.status === "ok" ? "等待 ESP32" : "未连接")}
            </div>
            <div className="mt-1 text-[11.5px] leading-snug text-slate-400">双节点 ESP-NOW 跳频 · 双向相位标定 · 重叠子载波拼接 · 路径长度剖面（不是摄像头式图像）</div>
            <div className="mt-2 flex flex-wrap gap-1.5">{nodeChip("A")}{nodeChip("B")}{chip(L ? L.mode === "two-way" : null, L ? (L.mode === "two-way" ? "双向标定" : "仅单向") : "—")}</div>
            <div className="mt-2 grid grid-cols-3 gap-x-2 gap-y-1 text-[11.5px]">
              <div><div className="text-lg font-bold text-cyan-200">{L ? `${L.channelsOk.length}/${planN}` : "—"}</div>信道</div>
              <div><div className="text-lg font-bold text-cyan-200">{L ? L.bwMHz : "—"}</div>带宽 MHz</div>
              <div><div className="text-lg font-bold text-cyan-200">{L ? L.resM : "—"}</div>分辨率 m</div>
              <div><div className="text-lg font-bold text-cyan-200">{L ? L.pairs : "—"}</div>配对数</div>
              <div><div className="text-lg font-bold text-cyan-200">{state?.syncLossPct ?? "—"}{state?.syncLossPct != null ? "%" : ""}</div>同步丢失</div>
              <div><div className="text-lg font-bold text-cyan-200">{state ? state.seq : "—"}</div>剖面序号</div>
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {Array.from({ length: planN === 13 ? 13 : 3 }, (_, i) => (planN === 13 ? i + 1 : [1, 6, 11][i])).map((c) => (
                <span key={c} className={`grid h-6 w-6 place-items-center rounded text-[11px] ${L?.channelsOk.includes(c) ? "bg-emerald-400/80 text-slate-900" : "bg-slate-700/60 text-slate-400"}`}>{c}</span>
              ))}
            </div>
          </div>

          {state && !demo && (
            <div className="pointer-events-auto rounded-xl border border-white/10 bg-[#070f1b]/85 p-3 text-[12px] backdrop-blur">
              <b className="text-[13px]">🖥️ Kaggle 资源 {state.gpu.cuda ? `· ${state.gpu.cuda}×GPU` : "· 无 GPU（CPU 运算）"}</b>
              {state.gpu.cuda > 0 ? (
                <div className="mt-1 space-y-1 text-slate-300">
                  {state.gpu.devices.map((d, i) => (
                    <div key={i}>
                      <div className="truncate text-[11px] text-slate-400">{d}</div>
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 flex-1 overflow-hidden rounded bg-white/10"><div className="h-full bg-cyan-400" style={{ width: `${Math.min(100, state.gpu.memTotalMB?.[i] ? ((state.gpu.memUsedMB?.[i] ?? 0) / state.gpu.memTotalMB[i]) * 100 : 0)}%` }} /></div>
                        <span className="w-28 text-right text-[11px]">显存 {((state.gpu.memUsedMB?.[i] ?? 0) / 1024).toFixed(1)}/{((state.gpu.memTotalMB?.[i] ?? 0) / 1024).toFixed(1)}G · {state.gpu.util?.[i] ?? 0}%</span>
                      </div>
                    </div>
                  ))}
                  <div className="text-[11px] text-slate-400">IFFT→{state.gpu.cir} · MUSIC→{state.gpu.music} · NFFT {state.gpu.nfft} · {state.gpu.cir_ms}/{state.gpu.music_ms} ms</div>
                </div>
              ) : (
                <div className="mt-1 text-[11px] text-amber-200">{state.gpu.err || "Kaggle 右侧 Settings → Accelerator 选 GPU T4 x2，保存后重新运行。"}</div>
              )}
              <div className="mt-1 text-[11px] text-slate-400">内存 {state.gpu.ramGB ?? "—"}/{state.gpu.ramTotalGB ?? "—"} GB · 磁盘剩 {state.gpu.diskFreeGB ?? "—"}/{state.gpu.diskTotalGB ?? "—"} GB · 原始 CSI 落盘 {(state.stats.rawBytes / 2 ** 20).toFixed(1)} MB</div>
              {state.tunnels && state.tunnels.length > 0 && (
                <div className="mt-1 text-[11px] text-slate-400">隧道：{state.tunnels.map((t) => `${t.name}${t.ok ? "✓" : "✗"}`).join(" ")}</div>
              )}
            </div>
          )}

          <div className="pointer-events-auto rounded-xl border border-white/10 bg-[#070f1b]/85 p-3 text-[12px] backdrop-blur">
            <b className="text-[13px]">🫁 感知（来自真实 CSI）</b>
            {L ? (
              <div className="mt-1 space-y-0.5 text-slate-300">
                <div>状态：<b className={L.sense.level === "moving" ? "text-orange-300" : L.sense.level === "still" ? "text-emerald-300" : "text-slate-200"}>{{ calibrating: `校准中 ${L.sense.calN}/${L.sense.calNeed}（请保持安静）`, none: "无人/无变化", still: "有人（静止）", moving: "有人（运动）" }[L.sense.level]}</b></div>
                <div>运动强度 {(L.sense.motion * 100).toFixed(0)}% · z={L.sense.z}</div>
                <div>呼吸：{L.sense.breathBpm ? <b className="text-emerald-300">{L.sense.breathBpm} 次/分</b> : "未检出"}（置信 {L.sense.breathConf}）</div>
                <div>活动路径长度：{L.sense.activeR ?? "—"} m {L.sense.present && L.sense.activeR ? "（绿色椭圆）" : ""}</div>
                <div className="pt-1 text-[11px] text-slate-400">椭圆含义：人在以 A、B 为焦点、路径长度为 L 的椭圆上；2 个节点无法再确定角度。</div>
              </div>
            ) : (
              <div className="mt-1 text-slate-400">还没有真实数据。无人时不会显示任何“人体”。</div>
            )}
            <div className="mt-2 flex gap-1.5">
              <button onClick={() => (demo ? flash("演示模式不需要校准") : post("/api/calibrate", {}, apiKey).then((ok) => flash(ok ? "已发送校准：请保持房间安静 20 秒" : "校准失败：看检测日志")))} className="rounded-md bg-white/10 px-2.5 py-1 hover:bg-white/20">🎯 重新校准</button>
              <button onClick={() => { setDemo((d) => !d); setBannerOff(false); }} className={`rounded-md px-2.5 py-1 ${demo ? "bg-amber-400 font-semibold text-slate-900" : "bg-white/10 hover:bg-white/20"}`}>{demo ? "■ 关闭演示" : "▶ 启动演示数据"}</button>
            </div>
          </div>

          <div className="pointer-events-auto rounded-xl border border-white/10 bg-[#070f1b]/85 p-3 text-[12px] backdrop-blur">
            <label className="flex items-center gap-2">
              <span className="w-24 shrink-0 text-slate-300">两节点间距</span>
              <input type="range" min={0.5} max={15} step={0.1} value={baseline} onChange={(e) => onBaseline(parseFloat(e.target.value))} className="flex-1" />
              <b className="w-12 text-right">{baseline.toFixed(1)}m</b>
            </label>
            <div className="mt-1 text-[11px] text-slate-400">量一下两块 ESP32 的实际距离填在这里：最强径（直达波）会锚定在这个距离。</div>
            <div className="mt-2 grid grid-cols-2 gap-1">
              {([["terrain", "距离-时间地形"], ["ellipses", "路径椭圆"], ["music", "椭圆用 MUSIC 峰"], ["autoRotate", "自动旋转"]] as const).map(([k, t]) => (
                <label key={k} className="flex items-center gap-1.5">
                  <input type="checkbox" checked={opts[k]} onChange={(e) => setOpts((o) => ({ ...o, [k]: e.target.checked }))} />
                  {t}
                </label>
              ))}
            </div>
            <div className="mt-2 flex gap-1.5">
              <button onClick={() => sceneRef.current?.resetView()} className="rounded-md bg-white/10 px-2.5 py-1 hover:bg-white/20">复位视角</button>
              <button onClick={() => document.documentElement.requestFullscreen?.()} className="rounded-md bg-white/10 px-2.5 py-1 hover:bg-white/20">全屏</button>
            </div>
            <div className="mt-1.5 text-[11px] text-slate-500">左键旋转 · 右键平移 · 滚轮缩放 · {fps.toFixed(0)} fps</div>
          </div>
        </div>

        {/* 顶部等待条 */}
        {banner && !bannerOff && (
          <div className="pointer-events-auto absolute left-1/2 top-3 z-20 w-[min(560px,calc(100%-720px))] min-w-[300px] -translate-x-1/2 rounded-xl border border-amber-300/30 bg-[#1a1608]/90 p-3 text-center backdrop-blur max-xl:left-[360px] max-xl:w-[calc(100%-380px)] max-xl:translate-x-0 max-md:left-3 max-md:top-auto max-md:bottom-3 max-md:w-[calc(100%-24px)]">
            <div className="flex items-start gap-2">
              <div className="flex-1 text-left">
                <div className="text-sm font-bold text-amber-200">{banner.title}</div>
                <div className="mt-0.5 text-[12px] leading-snug text-amber-100/80">{banner.body}</div>
              </div>
              <button onClick={() => setDiagOpen(true)} className="rounded bg-white/10 px-2 py-0.5 text-[11px] hover:bg-white/20">详情</button>
              <button onClick={() => setBannerOff(true)} className="rounded px-1.5 text-slate-300 hover:bg-white/10">✕</button>
            </div>
          </div>
        )}

        <Charts state={state} />
        {diagOpen && <DiagPanel ctx={ctx} events={events} onClear={clearEvents} onClose={() => setDiagOpen(false)} />}
        {toast && <div className="absolute bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-emerald-400 px-4 py-1.5 text-sm font-semibold text-slate-900 shadow-lg">{toast}</div>}
      </div>
    </div>
  );
}
