import { useEffect, useRef, useState } from "react";
import { PassageScene, type PassageViewOpts } from "@/lib/tri/passageScene";
import type { PassageEngine } from "@/lib/tri/passage";
import type { Presence } from "@/lib/tri/features";

// 「👁 过路成像」视图：把 A→B、A→C 两条链路的扰动变成「看得懂」的 2.5D 画面。
// 读法：①黄/红的山峰 = 物体当前最可能所在位置（越高越强）②青色拖尾 = 刚刚经过的轨迹 ③A→B/A→C 光束变粗变红 = 该链路被扰动
// ④黄色圆球 + 箭头 = 估计位置与运动方向 ⑤底部时间轴：B、C 曲线谁先升起，就是物体先靠近谁。
export default function PassageView({ engine, state, simulation, links }: { engine: PassageEngine; state: Presence; simulation: boolean; links: { B: boolean; C: boolean } }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const hudRef = useRef<HTMLCanvasElement>(null);
  const scRef = useRef<PassageScene | null>(null);
  const [opts, setOpts] = useState<PassageViewOpts>({ wake: true, stat: true, links: true, region: true, autoRotate: false });
  const [help, setHelp] = useState(true);
  const [fps, setFps] = useState(0);

  useEffect(() => {
    if (!boxRef.current) return;
    const sc = new PassageScene(boxRef.current, hudRef.current, engine);
    scRef.current = sc;
    const id = setInterval(() => setFps(sc.fps), 500);
    return () => {
      clearInterval(id);
      sc.dispose();
      scRef.current = null;
    };
  }, [engine]);

  useEffect(() => {
    if (scRef.current) scRef.current.opts = opts;
  }, [opts]);

  const m = engine.marker;
  const T = engine.T;
  const dist = T > 1.2 ? "很近" : T > 0.55 ? "中等" : "较远";
  const noData = state === "offline" || state === "calibrating";
  const active = m.visible && !noData;
  const tog = (k: keyof PassageViewOpts, label: string) => (
    <button
      onClick={() => setOpts((o) => ({ ...o, [k]: !o[k] }))}
      className={`rounded px-2 py-1 text-[11px] border ${opts[k] ? "bg-cyan-500/25 border-cyan-400 text-cyan-100" : "bg-slate-900/80 border-slate-700 text-slate-400"}`}
    >
      {opts[k] ? "☑" : "☐"} {label}
    </button>
  );
  const vb = (k: "oblique" | "top" | "front" | "reset", label: string) => (
    <button onClick={() => scRef.current?.view(k)} className="rounded border border-slate-600 bg-slate-900/80 px-2 py-1 text-[11px] text-slate-200 hover:border-cyan-400">
      {label}
    </button>
  );

  let banner: [string, string, string];
  if (state === "offline") banner = ["⚪ 等待 ESP32 数据", "未收到 B / C 的 CSI，此时不显示任何物体（不伪造）。点右上角「🔌 连接 ESP32」", "border-slate-600 text-slate-300"];
  else if (state === "calibrating") banner = ["🟡 自适应校准中", "请保持周围无人走动约 8–20 秒，校准完成后自动开始成像", "border-amber-500 text-amber-200"];
  else if (active) banner = [`🟢 检测到物体 · ${engine.dirText || "位置估计中"}`, `相对距离：${dist}　·　位置置信 ${(m.conf * 100).toFixed(0)}%　·　估计位置 x=${m.x.toFixed(2)}m z=${m.z.toFixed(2)}m`, "border-emerald-400 text-emerald-200"];
  else banner = [engine.statLevel > 0.3 ? "🟠 检测到静止/驻留物体" : "🔵 环境平稳 · 暂无物体经过", "有物体经过时，这里会显示方向，画面出现山峰与光束变化", engine.statLevel > 0.3 ? "border-amber-500 text-amber-200" : "border-cyan-700 text-cyan-200"];

  return (
    <div className="absolute inset-0 z-0">
      <div ref={boxRef} className="absolute inset-0" />

      {/* 状态横幅 */}
      <div className="pointer-events-none absolute top-14 left-1/2 z-10 w-[min(640px,60vw)] -translate-x-1/2">
        <div className={`rounded-lg border bg-black/70 px-4 py-2 backdrop-blur ${banner[2]}`}>
          <div className="text-[15px] font-bold leading-tight">{banner[0]}</div>
          <div className="text-[11px] opacity-90">{banner[1]}</div>
          {simulation && <div className="mt-1 text-[11px] font-bold text-amber-300">SIMULATION · 合成数据演示，不是真实测量</div>}
        </div>
      </div>

      {/* 链路指示 */}
      <div className="pointer-events-none absolute top-[7.5rem] left-1/2 z-10 flex -translate-x-1/2 gap-3 text-[11px] font-mono">
        <span className="rounded bg-black/60 px-2 py-0.5 text-emerald-300 border border-emerald-900">A→B {links.B ? `${(engine.aB * 100).toFixed(0)}%` : "离线"}</span>
        <span className="rounded bg-black/60 px-2 py-0.5 text-pink-300 border border-pink-900">A→C {links.C ? `${(engine.aC * 100).toFixed(0)}%` : "离线"}</span>
        <span className="rounded bg-black/60 px-2 py-0.5 text-slate-400 border border-slate-800">{fps} FPS · 20Hz 成像</span>
      </div>

      {/* 看图说明 */}
      <div className="absolute top-24 right-3 z-10 w-[250px] text-[11px]">
        <button onClick={() => setHelp((v) => !v)} className="mb-1 rounded border border-slate-600 bg-slate-900/85 px-2 py-1 text-slate-200 hover:border-cyan-400">
          {help ? "▾ 收起「怎么看这张图」" : "▸ 怎么看这张图"}
        </button>
        {help && (
          <div className="space-y-1.5 rounded-lg border border-slate-700 bg-black/75 p-2.5 leading-relaxed text-slate-300 backdrop-blur">
            <div>
              <span className="text-orange-300 font-bold">🏔 彩色山峰</span> = 物体（估计位置），越高越红越强。没有物体时画面是空的。<span className="text-violet-300">紫色低矮薄层</span> = 「可能区域」：只有 2 路链路，距离/方位本来就有歧义，真实位置可能在这片区域内的任何地方。
            </div>
            <div>
              <span className="text-cyan-300 font-bold">🌊 青色山脊拖尾</span> = 峰刚走过的轨迹，约 2 秒慢慢消失，用来看「经过」。
            </div>
            <div>
              <span className="text-amber-300 font-bold">🟡 圆球 + 箭头</span> = 估计位置和运动方向；外圈 = 不确定范围。
            </div>
            <div>
              <span className="text-emerald-300 font-bold">A→B</span> / <span className="text-pink-300 font-bold">A→C</span> 光束变粗变红 = 这条无线链路被物体扰动了。
            </div>
            <div>
              <span className="text-amber-200 font-bold">🟠 橙色平台</span> = 静止物体（空房基准偏离）。
            </div>
            <div className="text-slate-400">时间轴里 B、C 曲线谁先升高，物体就先靠近谁；两条一起升 = 在 A 前方/中间经过。</div>
            {engine.compact && <div className="rounded bg-amber-900/40 p-1.5 text-amber-200">⚠ 当前阵列边长 {engine.geom.side.toFixed(2)}m 太小：只能判断「有无/强弱/大致远近」，无法分辨左右方向。把 A/B/C 拉开 ≥1.5m 并在左侧「三角阵列边长」填实际距离，方向和位置才可信。</div>}
            <div className="text-slate-500">高度 = 概率强度，不是物体高度。前/后存在镜像歧义，已加入「物体在 B/C 前方」的弱先验（A 在后方）。</div>
          </div>
        )}
        {engine.events.length > 0 && (
          <div className="mt-1.5 rounded-lg border border-slate-700 bg-black/75 p-2 backdrop-blur">
            <div className="mb-1 font-bold text-cyan-300">📜 最近经过记录</div>
            {engine.events.slice(0, 5).map((e, i) => (
              <div key={e.at + "-" + i} className="flex justify-between gap-2 border-t border-slate-800 py-0.5 text-slate-300">
                <span>{new Date(e.at).toLocaleTimeString("zh-CN", { hour12: false })}</span>
                <span className="text-amber-200">{e.dir}</span>
                <span className="text-slate-500">{e.dur.toFixed(1)}s</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 时间轴 HUD */}
      <canvas ref={hudRef} className="absolute bottom-3 right-3 z-10 h-[130px] w-[min(440px,46vw)] rounded" />

      {/* 视角 / 图层 */}
      <div className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 flex-wrap items-center justify-center gap-1.5 rounded-lg bg-black/60 p-1.5 backdrop-blur">
        {vb("oblique", "🎥 斜视")}
        {vb("top", "⬇ 俯视")}
        {vb("front", "➡ 侧视")}
        {vb("reset", "⟲ 复位")}
        <span className="mx-1 h-4 w-px bg-slate-700" />
        {tog("wake", "拖尾")}
        {tog("region", "可能区域")}
        {tog("stat", "静止物体")}
        {tog("links", "链路光束")}
        {tog("autoRotate", "自转")}
      </div>
    </div>
  );
}
