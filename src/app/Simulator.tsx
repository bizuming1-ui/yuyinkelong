"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

type Frame = { seq: number; aps: unknown[]; st?: unknown[] };
type Radar = {
  ingest: (f: unknown) => void;
  demoFrame: () => Frame;
  reset: () => void;
  setWaiting: (title: string, msg: string) => void;
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
  " ESP32-S3 WiFi Radar v1.0.0",
  "=====================================",
  "[cfg] node=S3-DEMO01 ssid='HomeWiFi' pass=**** url='https://demo.trycloudflare.com' key=radar-key",
  "[boot] 开始扫描…",
];

export default function Simulator() {
  const [origin, setOrigin] = useState("");
  const [lines, setLines] = useState<string[]>(["[power] 开发板已上电，等待你按下 RESET 键…"]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [copied, setCopied] = useState("");
  const [pressed, setPressed] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines]);
  useEffect(() => {
    const t = timers.current;
    return () => t.forEach(clearTimeout);
  }, []);

  const getRadar = useCallback((): Radar | undefined => {
    const w = iframeRef.current?.contentWindow as unknown as { WifiRadar?: Radar } | null | undefined;
    return w?.WifiRadar;
  }, []);

  const log = useCallback((l: string) => setLines((p) => [...p.slice(-250), l]), []);

  const press = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setPressed(true);
    setTimeout(() => setPressed(false), 250);
    setLines(["[reset] RESET 键按下 → 芯片复位"]);
    setPhase("booting");
    const radar = getRadar();
    radar?.reset();
    radar?.setWaiting("ESP32 启动中…", "固件正在初始化 WiFi 并开始第一轮扫描。");
    BOOT_LOG.forEach((l, i) => timers.current.push(setTimeout(() => log(l), 150 + i * 110)));
    let ok = 0;
    let first = true;
    const tick = () => {
      const r = getRadar();
      if (!r) {
        log("[wait] 3D 引擎加载中（需要访问 cdn.jsdelivr.net）…");
        timers.current.push(setTimeout(tick, 1200));
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
    timers.current.push(setTimeout(() => {
      setPhase("running");
      tick();
    }, 300 + BOOT_LOG.length * 110));
  }, [getRadar, log]);

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
    setTimeout(() => setCopied(""), 1500);
  };

  const codeUrl = `${origin}/code`;
  const radarUrl = `${origin}/radar.html?demo=1`;
  const led = phase === "running" ? "#2ee6a6" : phase === "booting" ? "#ffb020" : "#ff4d6d";

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <header className="flex flex-wrap items-center gap-3 border-b border-cyan-400/20 bg-[#07111d] px-4 py-2.5">
        <div className="mr-2">
          <div className="text-base font-bold text-white">📡 ESP32-S3 WiFi 雷达 · 浏览器模拟器</div>
          <div className="text-xs text-slate-400">虚拟开发板按 RESET 即运行；数据为模拟环境，真实扫描请烧录固件</div>
        </div>
        <div className="flex min-w-[320px] flex-1 items-center gap-2">
          <span className="whitespace-nowrap text-xs text-slate-400">复制代码页网址</span>
          <input
            readOnly
            value={codeUrl}
            onFocus={(e) => e.currentTarget.select()}
            className="min-w-0 flex-1 rounded-md border border-cyan-400/25 bg-[#0a1826] px-2 py-1.5 font-mono text-xs text-cyan-100 outline-none"
          />
          <button
            onClick={() => copy(codeUrl, "url")}
            className="rounded-md border border-cyan-400/25 bg-[#0d2236] px-3 py-1.5 text-xs hover:border-emerald-400"
          >
            {copied === "url" ? "已复制 ✓" : "复制网址"}
          </button>
          <Link
            href="/code"
            className="rounded-md bg-emerald-400 px-3 py-1.5 text-xs font-bold text-[#04150e] hover:bg-emerald-300"
          >
            进入复制代码界面 →
          </Link>
        </div>
        <Link
          href="/code"
          className="rounded-lg border border-emerald-400 bg-emerald-400/10 px-4 py-2 text-sm font-bold text-emerald-300 hover:bg-emerald-400 hover:text-[#04150e]"
        >
          📋 复制代码
        </Link>
      </header>

      <main className="flex min-h-0 flex-1">
        <section className="flex w-[400px] min-w-[340px] flex-col gap-3 border-r border-cyan-400/15 bg-[#06101a] p-3">
          <div className="rounded-xl border border-cyan-400/20 bg-[#08141f] p-3">
            <svg viewBox="0 0 360 170" className="w-full">
              <rect x="6" y="6" width="348" height="158" rx="10" fill="#0b3b2e" stroke="#16a37a" strokeWidth="2" />
              <rect x="124" y="20" width="110" height="74" rx="4" fill="#1b2430" stroke="#6c7a89" />
              <text x="179" y="52" textAnchor="middle" fill="#cfe9f7" fontSize="13" fontWeight="700">ESP32-S3</text>
              <text x="179" y="70" textAnchor="middle" fill="#7fa3b8" fontSize="10">WROOM-1</text>
              <path d="M150 28 h60 M150 34 h50" stroke="#c9a227" strokeWidth="3" strokeLinecap="round" />
              <rect x="150" y="136" width="60" height="26" rx="3" fill="#aab4be" />
              <text x="180" y="153" textAnchor="middle" fontSize="9" fill="#222">USB</text>
              {Array.from({ length: 14 }).map((_, i) => (
                <g key={i}>
                  <rect x={22 + i * 22} y="10" width="8" height="8" fill="#d4af37" />
                  <rect x={22 + i * 22} y="152" width="8" height="8" fill="#d4af37" />
                </g>
              ))}
              <circle cx="40" cy="60" r="7" fill={led} style={{ filter: `drop-shadow(0 0 6px ${led})` }} />
              <text x="40" y="82" textAnchor="middle" fill="#9fe9ff" fontSize="9">RGB</text>
              <circle cx="300" cy="60" r="12" fill="#1d2733" stroke={pressed ? "#2ee6a6" : "#6c7a89"} strokeWidth="3" />
              <text x="300" y="88" textAnchor="middle" fill="#cfe9f7" fontSize="10">RST</text>
              <circle cx="300" cy="118" r="12" fill="#1d2733" stroke="#6c7a89" strokeWidth="3" />
              <text x="300" y="146" textAnchor="middle" fill="#cfe9f7" fontSize="10">BOOT</text>
            </svg>
            <button
              onClick={press}
              className="mt-2 w-full rounded-lg bg-emerald-400 py-3 text-base font-extrabold text-[#04150e] shadow-lg shadow-emerald-500/20 active:scale-[0.98] hover:bg-emerald-300"
            >
              ⏻ 按下 RESET 键{phase === "idle" ? "（开始运行）" : "（重启）"}
            </button>
            <div className="mt-1.5 text-center text-xs text-slate-400">
              快捷键 R · 状态：
              <b style={{ color: led }}>{phase === "idle" ? "已上电·未运行" : phase === "booting" ? "启动中" : "运行中"}</b>
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-cyan-400/20 bg-[#050a10]">
            <div className="flex items-center justify-between border-b border-cyan-400/15 px-3 py-1.5 text-xs text-slate-400">
              <span>串口监视器 115200 baud（模拟）</span>
              <button onClick={() => setLines([])} className="hover:text-white">清屏</button>
            </div>
            <pre ref={logRef} className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all p-3 font-mono text-[12px] leading-5 text-emerald-300">
              {lines.join("\n")}
            </pre>
          </div>
          <div className="text-[11px] leading-4 text-slate-500">
            说明：WiFi 扫描只能得到热点的信号强度(RSSI)，距离是估算值，方位需多节点或手动校准；详见 README。
          </div>
        </section>

        <section className="relative min-w-0 flex-1">
          <iframe ref={iframeRef} src="/radar.html?sim=1" title="WiFi 3D 雷达" className="h-full w-full border-0" allowFullScreen />
          <div className="absolute left-1/2 top-3 flex -translate-x-1/2 gap-2">
            <a
              href="/radar.html?demo=1"
              target="_blank"
              rel="noreferrer"
              className="rounded-md border border-cyan-400/30 bg-[#07111d]/90 px-3 py-1.5 text-xs text-cyan-100 hover:border-emerald-400"
            >
              ⛶ 新标签页全屏打开 3D 世界（演示数据）
            </a>
            <button
              onClick={() => copy(radarUrl, "radar")}
              className="rounded-md border border-cyan-400/30 bg-[#07111d]/90 px-3 py-1.5 text-xs text-cyan-100 hover:border-emerald-400"
            >
              {copied === "radar" ? "已复制 ✓" : "复制该网址"}
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}
