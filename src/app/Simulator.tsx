"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Frame = { seq: number; aps: unknown[]; st?: unknown[]; node?: string };
type Radar = {
  ingest: (f: unknown) => void;
  feedSerialLine?: (l: string) => void;
  demoFrame: () => Frame;
  reset: () => void;
  setWaiting: (title: string, msg: string) => void;
  ready?: boolean;
};
type Phase = "idle" | "booting" | "running";
type Check = { id: string; name: string; st: "ok" | "wait" | "warn" | "bad"; msg: string; hint?: string };
type Diag = { level: "ok" | "wait" | "warn" | "bad"; summary: string; advice: string; checks: Check[]; report: string; frames: number; aps: number };
type LogE = { t: number; lv: string; c: string; m: string };

const BOOT_LOG = [
  "ESP-ROM:esp32s3-20210327",
  "rst:0x15 (USB_UART_CHIP_RESET),boot:0x8 (SPI_FAST_FLASH_BOOT)",
  "SPIWP:0xee",
  "entry 0x403c98d0",
  "",
  "=====================================",
  " ESP32-S3 WiFi Radar v7.0.0  (reset: EXT_RESET)",
  "=====================================",
  "[port] USB原生口=输出  UART口=输出",
  "[cfg] node=S3-DEMO01 ssid='' pass=(empty) url='' key=radar-key",
  "[info] 未配置 WiFi：只做串口输出（网页 USB 直连 / tools/serial_bridge.py 转发）",
  "[csi] 已开启 CSI 感知：已连路由器后对网关 ping 取 CSI（此处为模拟数据，网页标注“模拟 CSI”）",
  '[csi] ✅ CSI 已启用（L-LTF 64 子载波，≤20 包/秒输出）',
];

const ICON = { ok: "✅", wait: "⏳", warn: "⚠️", bad: "❌" } as const;
const LV_COLOR: Record<string, string> = { ERR: "text-rose-300", WARN: "text-amber-300", OK: "text-emerald-300", INFO: "text-slate-300" };
const SUM_STYLE = {
  ok: "border-emerald-500/50 text-emerald-300",
  wait: "border-cyan-500/40 text-cyan-300",
  warn: "border-amber-500/50 text-amber-300",
  bad: "border-rose-500/60 text-rose-300",
} as const;

const two = (n: number) => String(n).padStart(2, "0");
const fmt = (t: number) => {
  const d = new Date(t);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
};

export default function Simulator() {
  const [origin, setOrigin] = useState("");
  const [addr, setAddr] = useState("");
  const [frameSrc, setFrameSrc] = useState("/radar.html?sim=1");
  const [external, setExternal] = useState(false);
  const [lines, setLines] = useState<string[]>(["[power] 开发板已上电，等待你按下 RESET 键…"]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [copied, setCopied] = useState("");
  const [pressed, setPressed] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [diag, setDiag] = useState<Diag | null>(null);
  const [diagAt, setDiagAt] = useState(0);
  const [now, setNow] = useState(0);
  const [logs, setLogs] = useState<LogE[]>([]);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const logRef = useRef<HTMLPreElement>(null);
  const panelLogRef = useRef<HTMLDivElement>(null);
  const simLog = useRef<LogE[]>([]);

  const siteUrl = origin ? `${origin}/radar.html?demo=1` : "";

  const sim = useCallback((lv: string, m: string) => {
    const e = { t: Date.now(), lv, c: "sim", m };
    simLog.current = [...simLog.current.slice(-300), e];
    setLogs((p) => [...p.slice(-400), e]);
  }, []);

  useEffect(() => {
    const o = window.location.origin;
    setOrigin(o);
    setAddr(`${o}/radar.html?demo=1`);
    sim("INFO", `模拟器启动：${navigator.userAgent.slice(0, 90)}`);
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [sim]);

  // 接收内嵌 3D 页面（本地或 Kaggle）发来的检测日志与检测结果
  useEffect(() => {
    const onMsg = (ev: MessageEvent) => {
      if (ev.source !== iframeRef.current?.contentWindow) return;
      const m = ev.data as { type?: string; e?: LogE } & Partial<Diag>;
      if (!m || typeof m !== "object") return;
      if (m.type === "wradar-log" && m.e) {
        const e = m.e;
        setLogs((p) => [...p.slice(-400), e]);
      } else if (m.type === "wradar-diag") {
        setDiag(m as Diag);
        setDiagAt(Date.now());
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines]);
  useEffect(() => {
    const el = panelLogRef.current;
    if (el && el.scrollTop + el.clientHeight >= el.scrollHeight - 40) el.scrollTop = el.scrollHeight;
  }, [logs]);
  useEffect(() => {
    const t = timers.current;
    return () => t.forEach(clearTimeout);
  }, []);

  const getRadar = useCallback((): Radar | undefined => {
    try {
      const w = iframeRef.current?.contentWindow as unknown as { WifiRadar?: Radar } | null | undefined;
      return w?.WifiRadar;
    } catch {
      return undefined;
    }
  }, []);

  const log = useCallback((l: string) => setLines((p) => [...p.slice(-250), l]), []);

  const press = useCallback(() => {
    if (external) {
      setLines(["[提示] 当前地址栏打开的是外部网站(例如 Kaggle)，虚拟开发板只驱动内置的模拟页面。", "       把地址栏改回左侧的模拟器网址再按 RESET。"]);
      sim("WARN", "RESET 被忽略：当前显示的是外部网站");
      return;
    }
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setPressed(true);
    setTimeout(() => setPressed(false), 250);
    setLines(["[reset] RESET 键按下 → 芯片复位"]);
    sim("INFO", "虚拟 ESP32：RESET 按下，固件重新启动");
    setPhase("booting");
    getRadar()?.reset();
    getRadar()?.setWaiting("ESP32 启动中…", "固件正在初始化 WiFi 并开始第一轮扫描。");
    BOOT_LOG.forEach((l, i) => timers.current.push(setTimeout(() => log(l), 150 + i * 100)));
    let n = 0;
    const nodeId = "S3-DEMO01";
    const feed = (line: string) => {
      const r = getRadar();
      if (r?.feedSerialLine) r.feedSerialLine(line);
    };
    const hello = () =>
      feed("RADARHELLO:" + JSON.stringify({ fw: "7.0.0", csi: 1, csihz: 20, node: nodeId, chip: "ESP32-S3", rev: 0, cores: 2, flash: 8388608, psram: 0, heap: 250000, rst: "EXT_RESET", usb: 1, mirror: 1, up: 0, ssid: "", url: "" }));
    const tick = () => {
      const r = getRadar();
      if (!r || !r.ready) {
        log("[wait] 3D 页面加载中…");
        timers.current.push(setTimeout(tick, 900));
        return;
      }
      if (n === 0) hello();
      const f = r.demoFrame();
      f.node = nodeId;
      n += 1;
      feed("RADARHB:" + JSON.stringify({ fw: "7.0.0", node: nodeId, up: n * 2, st: "scan", cyc: n, seq: f.seq, aps: f.aps.length, scanms: 1700, ok: 0, fail: 0, http: 0, heap: 240000, wifi: 0, rssi: 0, csi: n * 30, csir: 20, csim: 1, csie: 0, csid: 0 }));
      log(`[scan] #${f.seq} aps=${f.aps.length} scan=1710ms`);
      log(`[csi] ${n * 30} 包 · 20 包/秒 · RADARCSI 行已输出`);
      if (f.st) log(`[sniff] stations=${f.st.length}`);
      // 走和真实串口完全相同的解析路径（RADARJSON 行）
      if (r.feedSerialLine) r.feedSerialLine("RADARJSON:" + JSON.stringify(f));
      else r.ingest(f);
      timers.current.push(setTimeout(tick, 1500));
    };
    timers.current.push(
      setTimeout(() => {
        setPhase("running");
        sim("OK", "虚拟 ESP32 开始输出 RADARHELLO / RADARHB / RADARJSON");
        tick();
      }, 300 + BOOT_LOG.length * 100),
    );
  }, [external, getRadar, log, sim]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "r" || e.key === "R") && !(e.target instanceof HTMLInputElement) && !e.ctrlKey && !e.metaKey) press();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [press]);

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
    setTimeout(() => setCopied(""), 1600);
  };

  const go = () => {
    const v = addr.trim();
    if (!v) return;
    const url = /^https?:\/\//i.test(v) ? v : `https://${v}`;
    timers.current.forEach(clearTimeout);
    setPhase("idle");
    setDiag(null);
    setDiagAt(0);
    if (origin && url.startsWith(origin)) {
      setExternal(false);
      setFrameSrc("/radar.html?sim=1");
      setLines(["[power] 开发板已上电，等待你按下 RESET 键…"]);
      sim("INFO", "切换到内置模拟页面");
    } else {
      setExternal(true);
      setFrameSrc(url);
      setLines([`[browser] 正在打开外部网址：${url}`]);
      sim("INFO", `打开外部网址：${url}`);
    }
  };

  // 完整检测报告 = 3D 页面报告 + 模拟器自身日志
  const fullReport = useMemo(() => {
    const head = `===== 浏览器模拟器 =====\n时间: ${new Date().toISOString()}\n模拟器页面: ${origin}\n当前内嵌: ${external ? frameSrc : "内置模拟页面"}\n`;
    const body = diag?.report ?? "(尚未收到 3D 页面的检测数据" + (external ? "：外部页面可能还是旧版代码，请用新的 Kaggle 单文件重新运行" : "") + ")";
    const sl = simLog.current.map((e) => `${fmt(e.t)} ${e.lv} [sim] ${e.m}`).join("\n");
    return `${head}\n${body}\n\n--- 模拟器日志 ---\n${sl}\n`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diag, origin, external, frameSrc, logs.length]);

  const copyReport = () => {
    copy(fullReport, "report");
    sim("INFO", "已复制检测日志");
  };
  const downloadReport = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([fullReport], { type: "text/plain;charset=utf-8" }));
    a.download = `wifi-radar-检测日志-${Date.now()}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 800);
  };
  const cmd = (c: string) => iframeRef.current?.contentWindow?.postMessage({ type: "wradar-cmd", cmd: c }, "*");

  const stale = external && !diag && now - 0 > 0 && logs.filter((l) => l.c !== "sim").length === 0;
  const level = diag?.level ?? "wait";
  const ledColor = phase === "running" ? "#2ee6a6" : phase === "booting" ? "#ffd23f" : "#3b4a5a";
  const panelLogs = logs.slice(-150);

  return (
    <div className="flex h-screen flex-col bg-[#0b1118] text-slate-200">
      {/* ===== 浏览器外壳 ===== */}
      <div className="flex items-center gap-3 border-b border-slate-700/60 bg-[#141c26] px-3 py-2">
        <div className="flex gap-1.5">
          <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
          <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
          <span className="h-3 w-3 rounded-full bg-[#28c840]" />
        </div>
        <div className="hidden rounded-t-lg bg-[#0b1118] px-3 py-1 text-xs text-slate-300 md:block">📡 WiFi RADAR · 3D 真实世界</div>
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-full border border-slate-600/60 bg-[#0b1118] px-3 py-1">
          <span className="text-xs text-emerald-400">🔒</span>
          <input
            value={addr}
            onChange={(e) => setAddr(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && go()}
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
            aria-label="网址栏"
          />
          <button onClick={go} className="rounded-full bg-slate-700 px-2.5 py-0.5 text-xs hover:bg-slate-600">
            前往
          </button>
        </div>
        <button onClick={() => copy(siteUrl, "url")} className="hidden rounded-lg border border-slate-600 px-2.5 py-1 text-xs hover:bg-slate-700 lg:block">
          {copied === "url" ? "✓ 已复制" : "复制网址"}
        </button>
        <a
          href={external ? frameSrc : siteUrl || "/radar.html?demo=1"}
          target="_blank"
          rel="noreferrer"
          className="hidden rounded-lg border border-slate-600 px-2.5 py-1 text-xs hover:bg-slate-700 lg:block"
          title="Web Serial 在新标签页里最稳定"
        >
          新标签打开
        </a>
        {/* 右上角：检测日志 + 复制代码 */}
        <button
          onClick={() => setPanelOpen((v) => !v)}
          id="diag-toggle-top"
          className={`whitespace-nowrap rounded-lg border px-3 py-1.5 text-sm font-semibold hover:brightness-125 ${SUM_STYLE[level]}`}
        >
          🩺 检测日志 {ICON[level]}
        </button>
        <Link
          href="/code"
          id="copy-code-top"
          className="whitespace-nowrap rounded-lg bg-emerald-400 px-3 py-1.5 text-sm font-bold text-[#02140d] shadow hover:brightness-110"
        >
          📋 复制代码
        </Link>
      </div>

      {/* ===== 网址 + 进入复制代码界面 ===== */}
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-800 bg-[#10171f] px-4 py-2 text-sm">
        <span className="text-slate-400">打开这个网站（3D 世界）的网址：</span>
        <code className="select-all rounded bg-[#0b1118] px-2 py-0.5 text-cyan-300">{siteUrl || "…"}</code>
        <button onClick={() => copy(siteUrl, "url2")} className="rounded border border-slate-600 px-2 py-0.5 text-xs hover:bg-slate-700">
          {copied === "url2" ? "✓ 已复制" : "复制"}
        </button>
        <span className="text-slate-500">· ESP32 直传地址（config.h 的 SERVER_URL 填站点根网址）：</span>
        <code className="select-all rounded bg-[#0b1118] px-2 py-0.5 text-amber-300">{origin ? `${origin}/api/ingest` : "…"}</code>
        <button onClick={() => copy(origin, "url3")} className="rounded border border-slate-600 px-2 py-0.5 text-xs hover:bg-slate-700">
          {copied === "url3" ? "✓ 已复制" : "复制根网址"}
        </button>
        <Link href="/code" className="ml-auto rounded-lg bg-cyan-400 px-3 py-1 font-semibold text-[#02141d] hover:brightness-110">
          进入复制代码界面 →
        </Link>
      </div>

      {/* ===== 主体 ===== */}
      <div className="relative flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside className="flex w-full flex-none flex-col gap-3 overflow-auto border-r border-slate-800 bg-[#0d141c] p-3 lg:w-[340px]">
          <div className="text-xs text-slate-400">虚拟 ESP32-S3 开发板（上电后按 RESET 就开始运行，键盘 R 也可以）</div>
          <div className="relative h-44 flex-none rounded-xl border border-emerald-900 bg-gradient-to-b from-[#0f3d2e] to-[#0a2a20] shadow-inner">
            <div className="absolute left-1/2 top-2 h-16 w-28 -translate-x-1/2 rounded bg-[#1b1b1f] text-center text-[10px] leading-4 text-slate-300">
              <div className="mt-2 font-bold">ESP32-S3</div>
              <div>WROOM-1</div>
              <div className="mx-auto mt-1 h-1 w-20 rounded bg-slate-600" />
            </div>
            <div className="absolute bottom-0 left-1/2 h-4 w-14 -translate-x-1/2 rounded-t bg-slate-400" title="USB" />
            <div className="absolute left-3 top-3 h-3 w-3 rounded-full" style={{ background: ledColor, boxShadow: `0 0 10px ${ledColor}` }} title="状态灯" />
            <button
              onClick={press}
              className="absolute bottom-6 left-6 grid h-12 w-12 place-items-center rounded-full border-4 border-slate-300 bg-red-500 text-[10px] font-bold text-white shadow-lg transition active:scale-90"
              style={{ transform: pressed ? "scale(.88)" : undefined }}
              aria-label="RESET"
            >
              RESET
            </button>
            <div className="absolute bottom-6 right-6 grid h-10 w-10 place-items-center rounded-full border-4 border-slate-500 bg-slate-700 text-[9px] text-slate-200">BOOT</div>
          </div>
          <button onClick={press} className="rounded-lg bg-red-500 py-2 font-bold text-white hover:bg-red-400">
            ⏻ 按下 RESET 键
          </button>
          <div className="text-xs text-slate-400">串口监视器 115200（与真实固件输出格式一致）</div>
          <pre ref={logRef} className="min-h-[140px] flex-1 overflow-auto whitespace-pre-wrap rounded-lg bg-black p-2 font-mono text-[11px] leading-4 text-emerald-300">
            {lines.join("\n")}
          </pre>
          <div className="rounded-lg border border-slate-700 bg-[#101a24] p-2 text-[11.5px] leading-5 text-slate-400">
            ⚠ 这里的数据是<b className="text-amber-300">模拟的 WiFi 环境</b>，仅用于预览与验证 3D 界面和解析流程。真实数据：Kaggle 运行服务端 → 在 3D 页面点「🔌 USB 连接 ESP32」。
          </div>
        </aside>

        <div className="relative min-h-[420px] flex-1 bg-black">
          <iframe
            ref={iframeRef}
            key={frameSrc}
            src={frameSrc}
            title="WiFi Radar 3D"
            allow="serial; fullscreen; clipboard-write; clipboard-read"
            className="h-full w-full border-0"
            onLoad={() => sim("INFO", `3D 页面加载完成：${frameSrc}`)}
          />

          {/* ===== 右上角：全能检测日志面板 ===== */}
          {panelOpen && (
            <div className="absolute right-3 top-3 z-20 flex max-h-[calc(100%-24px)] w-[430px] max-w-[92%] flex-col rounded-xl border border-slate-600/70 bg-[#07101c]/95 p-2.5 shadow-2xl backdrop-blur" id="diag-panel">
              <div className="mb-1.5 flex items-center gap-1.5">
                <b className="flex-1 text-sm">🩺 全能检测日志</b>
                <button onClick={copyReport} className="rounded bg-emerald-400 px-2 py-1 text-xs font-bold text-[#02140d] hover:brightness-110">
                  {copied === "report" ? "✓ 已复制" : "📋 复制日志"}
                </button>
                <button onClick={downloadReport} className="rounded border border-slate-600 px-2 py-1 text-xs hover:bg-slate-700">
                  ⬇ 下载
                </button>
                <button
                  onClick={() => {
                    setLogs([]);
                    simLog.current = [];
                  }}
                  className="rounded border border-slate-600 px-2 py-1 text-xs hover:bg-slate-700"
                >
                  清空
                </button>
                <button onClick={() => setPanelOpen(false)} className="rounded border border-slate-600 px-2 py-1 text-xs hover:bg-slate-700">
                  ✕
                </button>
              </div>
              <div className={`mb-1.5 break-all rounded-md border bg-[#0a1626] px-2 py-1 text-[12px] ${SUM_STYLE[level]}`}>
                {ICON[level]} {diag ? diag.summary : stale || (external && now > 0 && !diag) ? "外部页面尚未发送检测数据（若 6 秒后仍无：Kaggle 页面还是旧版代码，请复制新的 Kaggle 单文件重新运行）" : "等待 3D 页面的检测数据…"}
                {diag?.advice ? <div className="text-amber-300">↳ {diag.advice}</div> : null}
              </div>
              {diag && (
                <div className="mb-1.5 max-h-[34%] overflow-auto text-[11.5px]">
                  {diag.checks.map((c) => (
                    <div key={c.id} className={`my-0.5 border-l-[3px] bg-white/[0.02] px-1.5 py-0.5 ${c.st === "ok" ? "border-emerald-400" : c.st === "bad" ? "border-rose-500" : c.st === "warn" ? "border-amber-300" : "border-cyan-400"}`}>
                      <b>
                        {ICON[c.st]} {c.name}
                      </b>
                      <div className="break-all text-slate-300">{c.msg}</div>
                      {c.hint && c.st !== "ok" ? <div className="break-all text-amber-300">↳ {c.hint}</div> : null}
                    </div>
                  ))}
                </div>
              )}
              <div ref={panelLogRef} className="min-h-[120px] flex-1 overflow-auto rounded-md bg-[#050b14] p-1.5 font-mono text-[10.5px] leading-[1.45]">
                {panelLogs.length === 0 && <div className="text-slate-500">暂无事件</div>}
                {panelLogs.map((e, i) => (
                  <div key={i} className={`whitespace-pre-wrap break-all ${LV_COLOR[e.lv] ?? "text-slate-300"}`}>
                    <span className="text-slate-500">{fmt(e.t)}</span> <span className="text-cyan-400">{e.c}</span> {e.m}
                  </div>
                ))}
              </div>
              <div className="mt-1.5 flex gap-1.5 text-[11px]">
                <button onClick={() => cmd("serialConnect")} className="rounded border border-slate-600 px-2 py-0.5 hover:bg-slate-700">
                  🔌 USB 连接
                </button>
                <button onClick={() => cmd("serialReset")} className="rounded border border-slate-600 px-2 py-0.5 hover:bg-slate-700">
                  🔁 复位 ESP32
                </button>
                <span className="ml-auto text-slate-500">{diagAt ? `更新于 ${Math.max(0, Math.round((now - diagAt) / 1000))}s 前` : ""}</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
