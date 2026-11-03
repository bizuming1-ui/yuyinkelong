"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

type Frame = { seq: number; aps: unknown[]; st?: unknown[] };
type Radar = {
  ingest: (f: unknown) => void;
  demoFrame: () => Frame;
  reset: () => void;
  setWaiting: (title: string, msg: string) => void;
  ready?: boolean;
};
type Phase = "idle" | "booting" | "running";

const BOOT_LOG = [
  "ESP-ROM:esp32s3-20210327",
  "Build:Mar 27 2021",
  "rst:0x1 (POWERON),boot:0x8 (SPI_FAST_FLASH_BOOT)",
  "SPIWP:0xee",
  "mode:DIO, clock div:1",
  "load:0x3fce3808,len:0x44c",
  "entry 0x403c98d0",
  "",
  "=====================================",
  " ESP32-S3 WiFi Radar v2.0.0",
  "=====================================",
  "[cfg] node=S3-DEMO01 ssid='HomeWiFi' pass=**** url='https://demo.trycloudflare.com' key=radar-key",
  "[boot] 开始扫描…",
];

export default function Simulator() {
  const [origin, setOrigin] = useState("");
  const [addr, setAddr] = useState("");
  const [frameSrc, setFrameSrc] = useState("/radar.html?sim=1");
  const [external, setExternal] = useState(false);
  const [lines, setLines] = useState<string[]>(["[power] 开发板已上电，等待你按下 RESET 键…"]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [copied, setCopied] = useState("");
  const [pressed, setPressed] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const logRef = useRef<HTMLPreElement>(null);

  const siteUrl = origin ? `${origin}/radar.html?demo=1` : "";

  useEffect(() => {
    const o = window.location.origin;
    setOrigin(o);
    setAddr(`${o}/radar.html?demo=1`);
  }, []);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines]);
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
      return;
    }
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setPressed(true);
    setTimeout(() => setPressed(false), 250);
    setLines(["[reset] RESET 键按下 → 芯片复位"]);
    setPhase("booting");
    getRadar()?.reset();
    getRadar()?.setWaiting("ESP32 启动中…", "固件正在初始化 WiFi 并开始第一轮扫描。");
    BOOT_LOG.forEach((l, i) => timers.current.push(setTimeout(() => log(l), 150 + i * 110)));
    let ok = 0;
    let first = true;
    const tick = () => {
      const r = getRadar();
      if (!r || !r.ready) {
        log("[wait] 3D 页面加载中…");
        timers.current.push(setTimeout(tick, 900));
        return;
      }
      const f = r.demoFrame();
      log(`[scan] #${f.seq} aps=${f.aps.length}`);
      if (f.st) log(`[sniff] stations=${f.st.length}`);
      if (first) {
        log("[wifi] connected ip=192.168.1.23 rssi=-48 ch=6");
        first = false;
      }
      r.ingest(f);
      ok += 1;
      log(`[upload] HTTP 200 (ok=${ok} fail=0)`);
      timers.current.push(setTimeout(tick, 1500));
    };
    timers.current.push(
      setTimeout(() => {
        setPhase("running");
        tick();
      }, 300 + BOOT_LOG.length * 110),
    );
  }, [external, getRadar, log]);

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
    if (origin && url.startsWith(origin)) {
      setExternal(false);
      setFrameSrc("/radar.html?sim=1");
      setLines(["[power] 开发板已上电，等待你按下 RESET 键…"]);
    } else {
      setExternal(true);
      setFrameSrc(url);
      setLines([`[browser] 正在打开外部网址：${url}`]);
    }
  };

  const ledColor = phase === "running" ? "#2ee6a6" : phase === "booting" ? "#ffd23f" : "#3b4a5a";

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
        <button
          onClick={() => copy(siteUrl, "url")}
          className="hidden rounded-lg border border-slate-600 px-2.5 py-1 text-xs hover:bg-slate-700 lg:block"
        >
          {copied === "url" ? "✓ 已复制" : "复制网址"}
        </button>
        <a
          href={siteUrl || "/radar.html?demo=1"}
          target="_blank"
          rel="noreferrer"
          className="hidden rounded-lg border border-slate-600 px-2.5 py-1 text-xs hover:bg-slate-700 lg:block"
        >
          新标签打开
        </a>
        {/* 右上角：复制代码 */}
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
        <Link href="/code" className="ml-auto rounded-lg bg-cyan-400 px-3 py-1 font-semibold text-[#02141d] hover:brightness-110">
          进入复制代码界面 →
        </Link>
      </div>

      {/* ===== 主体 ===== */}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside className="flex w-full flex-none flex-col gap-3 overflow-auto border-r border-slate-800 bg-[#0d141c] p-3 lg:w-[360px]">
          <div className="text-xs text-slate-400">虚拟 ESP32-S3 开发板（上电后按 RESET 就开始运行，键盘 R 也可以）</div>
          <div className="relative h-44 rounded-xl border border-emerald-900 bg-gradient-to-b from-[#0f3d2e] to-[#0a2a20] shadow-inner">
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
          <div className="text-xs text-slate-400">串口监视器 115200</div>
          <pre ref={logRef} className="min-h-[160px] flex-1 overflow-auto rounded-lg bg-black p-2 font-mono text-[11px] leading-4 text-emerald-300">
            {lines.join("\n")}
          </pre>
          <div className="rounded-lg border border-slate-700 bg-[#101a24] p-2 text-[11.5px] leading-5 text-slate-400">
            ⚠ 这里的数据是<b className="text-amber-300">模拟的 WiFi 环境</b>，仅用于预览与验证 3D 界面。真实数据：Kaggle 运行服务端 → 在 3D 页面点「USB 连接 ESP32」，或让 ESP32 通过 WiFi 上传。
          </div>
        </aside>
        <main className="min-h-[60vh] flex-1 bg-black">
          <iframe
            ref={iframeRef}
            src={frameSrc}
            title="WiFi Radar 3D"
            className="h-full w-full border-0"
            allow="serial; fullscreen"
            allowFullScreen
          />
        </main>
      </div>
    </div>
  );
}
