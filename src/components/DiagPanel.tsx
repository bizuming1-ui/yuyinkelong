import { useCallback, useEffect, useState } from "react";
import { app, copyText } from "../lib/store";
import { bridge } from "../lib/bridge";
import { fetchText } from "../lib/host";

async function build(): Promise<string> {
  const L: string[] = ["## 浏览器侧检测"];
  L.push(`${bridge.supported ? "✅" : "❌"} Web Serial: ${bridge.supported ? "支持" : "不支持(请用电脑版 Chrome/Edge)"} · 安全上下文: ${window.isSecureContext} · 内嵌框架: ${bridge.inIframe}`);
  L.push(`ℹ️ 页面: ${location.href} · UA: ${navigator.userAgent.slice(0, 90)}`);
  L.push(`ℹ️ 主机: base=${app.base === null ? "未连接" : app.base || "同源"} · 状态=${app.hostState} · 延迟 ${app.lat}ms · 成功 ${app.okCount} 次 / 失败 ${app.failCount} 次 · 备用网址 ${app.alts.length} 个`);
  L.push(`${bridge.connected ? "✅" : "❌"} ESP32 串口: ${bridge.state} ${bridge.info} · ${bridge.rate} 条/秒 · 累计 ${bridge.total} · 已转发 ${bridge.sent} · 缓存 ${bridge.batch.length}`);
  const s = bridge.stat;
  if (s) L.push(`ℹ️ ESP32: 固件 ${s.fw} · WiFi ${s.ssid}(${s.ip}) ${s.rssi}dBm ch${s.ch} · 复位=${s.rst} · 看门狗复位 ${s.wdtN} 次 · 自愈 WiFi ${s.fixW}/CSI ${s.fixC} · 堆 ${s.heap} · PSRAM ${s.psram || 0} · 断开原因码 ${s.disc}`);
  L.push("");
  if (app.base !== null) {
    try {
      L.push(await fetchText("/api/diag"));
    } catch (e: any) {
      L.push("## 主机侧\n❌ 取不到 /api/diag: " + e.message);
    }
  } else L.push("## 主机侧\nℹ️ 还没有连接 Kaggle：粘贴网址并点「连接」。");
  L.push("\n## 浏览器事件(最近)");
  L.push(...app.logs.slice(-40));
  if (bridge.logs.length) {
    L.push("\n## ESP32 串口日志(最近)");
    L.push(...bridge.logs.slice(-40));
  }
  return L.join("\n");
}

export default function DiagPanel({ onClose }: { onClose: () => void }) {
  const [txt, setTxt] = useState("生成中…");
  const [msg, setMsg] = useState("");
  const refresh = useCallback(async () => {
    app.failBadge = 0;
    setTxt("生成中…");
    setTxt(await build());
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-black/70 p-4" onClick={onClose}>
      <div className="mt-6 flex w-full max-w-4xl flex-col gap-3 rounded-2xl border border-slate-700 bg-[#0b1220] p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <h2 className="flex-1 text-lg font-bold text-white">🩺 检测日志</h2>
          <button
            className="rounded-lg bg-cyan-500 px-3 py-1.5 text-sm font-bold text-slate-950"
            onClick={async () => {
              setMsg((await copyText(txt)) ? "✅ 日志已复制" : "复制失败，请手动全选");
              setTimeout(() => setMsg(""), 2000);
            }}
          >
            复制日志
          </button>
          <button className="rounded-lg bg-slate-700/60 px-3 py-1.5 text-sm text-white" onClick={refresh}>
            刷新
          </button>
          <button className="rounded-lg bg-slate-700/60 px-3 py-1.5 text-sm text-white" onClick={onClose}>
            ✕
          </button>
        </div>
        {msg && <div className="text-sm text-emerald-400">{msg}</div>}
        <textarea readOnly value={txt} className="h-[62vh] w-full resize-none rounded-lg border border-slate-800 bg-black/60 p-3 font-mono text-[12px] leading-relaxed text-slate-200" />
      </div>
    </div>
  );
}
