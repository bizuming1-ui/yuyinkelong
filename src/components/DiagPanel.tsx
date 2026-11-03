"use client";
import { useMemo, useState } from "react";
import { buildLogText, clientChecks, type Check, type DiagCtx } from "@/lib/diag";
import type { EventItem } from "@/lib/useRadar";
import { GH_REPO } from "@/lib/radar";

const COL: Record<string, string> = { ok: "text-emerald-300", warn: "text-amber-300", fail: "text-rose-400", info: "text-sky-300" };
const MARK: Record<string, string> = { ok: "✅", warn: "⚠️", fail: "❌", info: "ℹ️" };

export async function copyText(s: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(s);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = s;
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

export function diagCounts(ctx: DiagCtx) {
  const all: Check[] = [...clientChecks(ctx), ...((ctx.serverDiag?.items as Check[] | undefined) ?? [])];
  return { fail: all.filter((x) => x.status === "fail").length, warn: all.filter((x) => x.status === "warn").length, total: all.length };
}

export default function DiagPanel({ ctx, events, onClear, onClose }: { ctx: DiagCtx; events: EventItem[]; onClear: () => void; onClose: () => void }) {
  const [tab, setTab] = useState<"checks" | "events" | "text">("checks");
  const [msg, setMsg] = useState("");
  const client = useMemo(() => clientChecks(ctx), [ctx]);
  const server = (ctx.serverDiag?.items ?? []) as Check[];
  const text = useMemo(() => buildLogText(ctx, events), [ctx, events]);
  const flash = (m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(""), 2200);
  };
  const row = (k: Check) => (
    <div key={k.id + k.name} className="border-b border-white/5 py-1.5">
      <div className={`text-[13px] font-semibold ${COL[k.status]}`}>
        {MARK[k.status]} {k.name}
      </div>
      <div className="break-words text-[12px] leading-snug text-slate-300/90">{k.detail}</div>
    </div>
  );
  const merged = [...(ctx.serverDiag?.events ?? []).map((e) => ({ t: e.t * 1000, lv: e.lv, msg: "[主机] " + e.msg })), ...events.map((e) => ({ ...e, msg: "[网页] " + e.msg }))].sort((a, b) => a.t - b.t).slice(-150);
  return (
    <div className="absolute right-3 top-3 z-40 flex max-h-[calc(100%-24px)] w-[min(520px,calc(100%-24px))] flex-col rounded-xl border border-cyan-400/30 bg-[#070f1b]/95 shadow-2xl backdrop-blur">
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
        <b className="text-cyan-200">🩺 全能检测日志</b>
        <span className="text-xs text-slate-400">浏览器 + Kaggle + 两块 ESP32，每秒刷新</span>
        <button onClick={onClose} className="ml-auto rounded px-2 py-0.5 text-slate-300 hover:bg-white/10">✕</button>
      </div>
      <div className="flex gap-1 px-3 pt-2 text-xs">
        {(["checks", "events", "text"] as const).map((k) => (
          <button key={k} onClick={() => setTab(k)} className={`rounded-md px-2.5 py-1 ${tab === k ? "bg-cyan-500/25 text-cyan-100" : "bg-white/5 text-slate-300 hover:bg-white/10"}`}>
            {k === "checks" ? "检测项" : k === "events" ? "事件流" : "日志原文"}
          </button>
        ))}
      </div>
      <div className="min-h-[120px] flex-1 overflow-auto px-3 py-2">
        {tab === "checks" && (
          <>
            <div className="mb-1 text-[11px] uppercase tracking-wider text-slate-400">浏览器侧</div>
            {client.map(row)}
            <div className="mb-1 mt-3 text-[11px] uppercase tracking-wider text-slate-400">Kaggle 主机 / ESP32 侧</div>
            {server.length ? server.map(row) : <div className="text-[12px] text-slate-400">暂无（尚未连接 Kaggle，或主机不可达）</div>}
          </>
        )}
        {tab === "events" && (
          <div className="font-mono text-[11.5px] leading-relaxed">
            {merged.length === 0 && <div className="text-slate-400">还没有事件</div>}
            {merged.map((e, i) => (
              <div key={i} className={COL[e.lv] ?? "text-slate-300"}>
                {new Date(e.t).toLocaleTimeString("zh-CN", { hour12: false })} {e.msg}
              </div>
            ))}
          </div>
        )}
        {tab === "text" && <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-slate-200">{text}</pre>}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-white/10 px-3 py-2 text-xs">
        <button onClick={async () => flash((await copyText(text)) ? "已复制日志" : "复制失败，请手动选择")} className="rounded-md bg-cyan-500 px-3 py-1.5 font-semibold text-slate-900 hover:bg-cyan-400">📋 复制日志</button>
        <button
          onClick={() => {
            const b = new Blob([text], { type: "text/plain;charset=utf-8" });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(b);
            a.download = `检测日志-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.txt`;
            a.click();
          }}
          className="rounded-md bg-white/10 px-3 py-1.5 hover:bg-white/20"
        >
          ⬇ 下载 .txt
        </button>
        <button
          onClick={async () => {
            await copyText(text);
            window.open(`https://github.com/${GH_REPO}/new/main?filename=${encodeURIComponent("检测日志")}`, "_blank");
            flash("日志已复制，在 GitHub 页面粘贴后提交");
          }}
          className="rounded-md bg-white/10 px-3 py-1.5 hover:bg-white/20"
        >
          🐙 复制并去 GitHub 提交
        </button>
        <button onClick={onClear} className="rounded-md bg-white/5 px-2.5 py-1.5 text-slate-300 hover:bg-white/10">清空网页事件</button>
        {msg && <span className="text-emerald-300">{msg}</span>}
      </div>
    </div>
  );
}
