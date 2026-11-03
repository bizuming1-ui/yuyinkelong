"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { copyText } from "./DiagPanel";
import { GH_REPO, KEY_KEY, URL_KEY, normUrl } from "@/lib/radar";

type F = { path: string; content: string; lines: number; bytes: number };
type Bundle = { files: F[]; kaggle: string; pioA: string[]; pioB: string[] };
type Sync = "checking" | "same" | "diff" | "missing" | "unknown";
type Tab = "github" | "kaggle" | "pio";

const rawUrl = (p: string) => `https://raw.githubusercontent.com/${GH_REPO}/main/${p.split("/").map(encodeURIComponent).join("/")}`;
const norm = (s: string) => s.replace(/\r\n/g, "\n").replace(/\s+$/g, "");
const kb = (n: number) => (n > 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

function applyConfig(path: string, content: string, v: { ssid: string; pass: string; url: string; key: string }): string {
  let s = content;
  if (path.endsWith("include/config.h")) {
    if (v.ssid) s = s.replace(/(#define\s+WIFI_SSID\s+)"[^"]*"/, (_m, a) => `${a}${JSON.stringify(v.ssid)}`);
    if (v.pass) s = s.replace(/(#define\s+WIFI_PASS\s+)"[^"]*"/, (_m, a) => `${a}${JSON.stringify(v.pass)}`);
    if (v.url) s = s.replace(/(#define\s+KAGGLE_URL\s+)"[^"]*"/, (_m, a) => `${a}${JSON.stringify(v.url)}`);
    if (v.key) s = s.replace(/(#define\s+API_KEY\s+)"[^"]*"/, (_m, a) => `${a}${JSON.stringify(v.key)}`);
  } else if (path.endsWith("csi_radar_kaggle.py") && v.key) {
    s = s.replace(/os\.environ\.get\("RADAR_KEY",\s*"[^"]*"\)/, `os.environ.get("RADAR_KEY", ${JSON.stringify(v.key)})`);
  }
  return s;
}

export default function CodeBrowser() {
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState<Tab>("pio");
  const [ssid, setSsid] = useState("");
  const [pass, setPass] = useState("");
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("radar-key");
  const [sync, setSync] = useState<Record<string, Sync>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [toast, setToast] = useState("");
  const started = useRef(false);

  useEffect(() => {
    setUrl(localStorage.getItem(URL_KEY) || "");
    setKey(localStorage.getItem(KEY_KEY) || "radar-key");
    setSsid(localStorage.getItem("radar.ssid") || "");
    setPass(localStorage.getItem("radar.pass") || "");
    fetch("/api/code", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: Bundle) => setBundle(j))
      .catch((e) => setErr(String(e)));
  }, []);

  const flash = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(""), 2000);
  };
  const vals = useMemo(() => ({ ssid, pass, url: normUrl(url), key }), [ssid, pass, url, key]);
  const saveVals = (k: string, v: string, set: (s: string) => void) => {
    set(v);
    if (k === URL_KEY) localStorage.setItem(k, v ? normUrl(v) || v : "");
    else localStorage.setItem(k, v);
  };
  const byPath = useMemo(() => new Map((bundle?.files ?? []).map((f) => [f.path, f])), [bundle]);

  // GitHub 同步检测（浏览器直接读 raw.githubusercontent.com）
  useEffect(() => {
    if (tab !== "github" || !bundle || started.current) return;
    started.current = true;
    const queue = [...bundle.files];
    setSync(Object.fromEntries(queue.map((f) => [f.path, "checking" as Sync])));
    const worker = async () => {
      for (;;) {
        const f = queue.shift();
        if (!f) return;
        let st: Sync = "unknown";
        try {
          const r = await fetch(rawUrl(f.path) + `?t=${Date.now()}`, { cache: "no-store" });
          if (r.status === 404) st = "missing";
          else if (r.ok) st = norm(await r.text()) === norm(f.content) ? "same" : "diff";
        } catch {
          st = "unknown";
        }
        setSync((o) => ({ ...o, [f.path]: st }));
      }
    };
    void Promise.all([worker(), worker(), worker(), worker()]);
  }, [tab, bundle]);

  const content = useCallback((f: F, withVals: boolean) => (withVals ? applyConfig(f.path, f.content, vals) : f.content), [vals]);

  const editOnGithub = async (f: F, withVals: boolean) => {
    await copyText(content(f, withVals));
    const enc = f.path.split("/").map(encodeURIComponent).join("/");
    const exists = sync[f.path] === "same" || sync[f.path] === "diff";
    window.open(exists ? `https://github.com/${GH_REPO}/edit/main/${enc}` : `https://github.com/${GH_REPO}/new/main?filename=${encodeURIComponent(f.path)}`, "_blank");
    flash(exists ? "已复制：在 GitHub 编辑页 Ctrl+A 全选后粘贴，再提交" : "已复制：GitHub 新建文件页粘贴内容后提交");
  };

  const renderCard = (p: string, withVals: boolean, showSync: boolean) => {
    const f = byPath.get(p);
    if (!f) return null;
    const isOpen = open[p] ?? true;
    const st = sync[p];
    return (
      <div key={p} className="overflow-hidden rounded-xl border border-white/10 bg-[#0a111d]">
        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
          <button onClick={() => setOpen((o) => ({ ...o, [p]: !isOpen }))} className="text-cyan-300">{isOpen ? "▾" : "▸"}</button>
          <code className="break-all text-[13px] font-semibold text-cyan-200">{p}</code>
          <span className="text-xs text-slate-400">{f.lines} 行 · {kb(f.bytes)}</span>
          {showSync && st && (
            <span className={`rounded-full px-2 py-0.5 text-[11px] ${st === "same" ? "bg-emerald-500/20 text-emerald-200" : st === "diff" ? "bg-amber-500/20 text-amber-200" : st === "missing" ? "bg-rose-500/20 text-rose-200" : "bg-slate-600/40 text-slate-300"}`}>
              {{ checking: "检测中…", same: "已同步", diff: "与仓库不同（需更新）", missing: "仓库没有（需新建）", unknown: "无法检测" }[st]}
            </span>
          )}
          <div className="ml-auto flex gap-2">
            <button onClick={() => editOnGithub(f, withVals)} className="rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-[13px] hover:bg-white/10">✏️ 在 GitHub 编辑</button>
            <button onClick={async () => flash((await copyText(content(f, withVals))) ? `已复制 ${p}` : "复制失败，请手动选择")} className="rounded-lg bg-emerald-400 px-3 py-1.5 text-[13px] font-bold text-slate-900 hover:bg-emerald-300">📋 复制此文件</button>
          </div>
        </div>
        {isOpen && <pre className="max-h-[460px] overflow-auto border-t border-white/10 bg-[#050a12] p-3 font-mono text-[12.5px] leading-[1.5] text-slate-200">{content(f, withVals)}</pre>}
      </div>
    );
  };

  const copyAll = async (paths: string[], label: string) => {
    const txt = paths
      .map((p) => byPath.get(p))
      .filter((f): f is F => !!f)
      .map((f) => `// ===== ${f.path} =====\n${content(f, true)}`)
      .join("\n\n");
    flash((await copyText(txt)) ? `已复制 ${label}（${paths.length} 个文件，带文件名分隔）` : "复制失败");
  };

  const input = (label: string, v: string, on: (s: string) => void, ph: string, type = "text") => (
    <label className="flex flex-col gap-1 text-[12px] text-slate-400">
      {label}
      <input type={type} value={v} onChange={(e) => on(e.target.value)} placeholder={ph} className="rounded-lg border border-white/15 bg-[#0e1623] px-3 py-2 text-[14px] text-slate-100 outline-none focus:border-cyan-400/70" />
    </label>
  );

  const tabBtn = (k: Tab, t: string) => (
    <button onClick={() => setTab(k)} className={`rounded-xl border px-4 py-2 text-sm font-bold ${tab === k ? "border-emerald-300 bg-emerald-400 text-slate-900" : "border-white/20 bg-white/5 text-slate-100 hover:bg-white/10"}`}>{t}</button>
  );

  const ghFiles = bundle?.files ?? [];
  const groups: [string, F[]][] = [
    ["firmware/node_a — Node A 发起端", ghFiles.filter((f) => f.path.startsWith("firmware/node_a/"))],
    ["firmware/node_b — Node B 响应端", ghFiles.filter((f) => f.path.startsWith("firmware/node_b/"))],
    ["kaggle — 主机端单文件", ghFiles.filter((f) => f.path.startsWith("kaggle/"))],
    ["tools — 无硬件仿真/验证", ghFiles.filter((f) => f.path.startsWith("tools/"))],
    ["src — 浏览器模拟器 / 3D 网页", ghFiles.filter((f) => f.path.startsWith("src/"))],
    ["项目根文件", ghFiles.filter((f) => !f.path.includes("/"))],
  ];

  return (
    <div className="min-h-screen bg-[#070b13] text-slate-100">
      <div className="sticky top-0 z-20 flex flex-wrap items-center gap-3 border-b border-white/10 bg-[#0a0f1a]/95 px-5 py-3 backdrop-blur">
        <Link href="/" className="rounded-xl border border-white/25 px-4 py-2 text-sm hover:bg-white/10">← 返回浏览器模拟器</Link>
        <div className="text-lg font-bold">📋 复制代码界面 <span className="text-sm font-normal text-slate-400">· ESP32-S3 双节点 CSI 雷达</span></div>
        <div className="ml-auto flex flex-wrap gap-2">
          {tabBtn("github", "① GitHub 代码")}
          {tabBtn("kaggle", "② Kaggle 单文件")}
          {tabBtn("pio", "③ PlatformIO 代码")}
        </div>
      </div>

      <div className="mx-auto max-w-[1180px] space-y-4 px-4 py-5">
        {err && <div className="rounded-xl border border-rose-400/40 bg-rose-500/10 p-4">加载失败：{err}</div>}
        {!bundle && !err && <div className="text-slate-400">加载中…</div>}

        {bundle && tab === "pio" && (
          <>
            <div className="rounded-2xl border border-cyan-400/20 bg-[#0a121f] p-5">
              <h2 className="text-xl font-bold text-cyan-300">PlatformIO（VSCode）代码：两块 ESP32 各 4 个文件</h2>
              <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-[15px] leading-relaxed text-slate-200">
                <li>VSCode → PlatformIO → New Project（Board: <b>Espressif ESP32-S3-DevKitC-1</b>，Framework: <b>Arduino</b>）。做两个工程：<b>node_a</b> 和 <b>node_b</b>（或直接打开仓库里的 firmware/node_a、firmware/node_b）。</li>
                <li>把下面「Node A」的 4 个文件分别覆盖到 node_a 工程，「Node B」的 4 个文件覆盖到 node_b 工程（<code>platformio.ini</code>、<code>include/config.h</code>、<code>include/radar_common.h</code>、<code>src/main.cpp</code>）。</li>
                <li>两块板子分别 Build → Upload（失败就按住 BOOT 再按 RESET）。<b>上传完成后只要供电（充电头/充电宝）即可，不用连电脑</b>；数据通过 WiFi 传到 Kaggle。</li>
                <li>先在 Kaggle 运行单文件脚本，把输出框里打印的网址粘贴到下面「Kaggle 网址」，复制出来的 config.h 就自动写好了。</li>
              </ol>
              <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {input("WiFi 名称 (2.4GHz)", ssid, (v) => saveVals("radar.ssid", v, setSsid), "WiFi 名称")}
                {input("WiFi 密码", pass, (v) => saveVals("radar.pass", v, setPass), "WiFi 密码", "text")}
                {input("Kaggle 网址（输出框里复制）", url, (v) => saveVals(URL_KEY, v, setUrl), "https://xxxx.trycloudflare.com")}
                {input("API_KEY（与 Kaggle 一致）", key, (v) => saveVals(KEY_KEY, v, setKey), "radar-key")}
              </div>
              <div className="mt-2 text-[12.5px] text-slate-400">
                填写后自动写入下方 config.h 的复制内容（只保存在你的浏览器里）。Kaggle 网址：{vals.url ? <b className="text-emerald-300">{vals.url}</b> : <span className="text-amber-300">还没填（也可留空，固件会通过 ntfy.sh 自动发现 Kaggle 最新网址）</span>}
              </div>
            </div>
            {[
              ["Node A（发起端：信道调度 + 发探测）", bundle.pioA, "Node A"],
              ["Node B（响应端：跟随换台 + 回复探测）", bundle.pioB, "Node B"],
            ].map(([title, paths, short]) => (
              <section key={String(short)} className="space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                  <h3 className="text-lg font-bold text-emerald-300">{title as string}</h3>
                  <button onClick={() => copyAll(paths as string[], String(short))} className="rounded-xl bg-cyan-400 px-4 py-2 text-sm font-bold text-slate-900 hover:bg-cyan-300">📋 复制 {String(short)} 全部 4 个文件</button>
                </div>
                {(paths as string[]).map((p) => renderCard(p, true, false))}
              </section>
            ))}
          </>
        )}

        {bundle && tab === "kaggle" && (
          <>
            <div className="rounded-2xl border border-cyan-400/20 bg-[#0a121f] p-5">
              <h2 className="text-xl font-bold text-cyan-300">Kaggle 单文件：{ghFiles.find((f) => f.path === bundle.kaggle)?.lines ?? 0} 行（只有 1 个文件）</h2>
              <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-[15px] leading-relaxed text-slate-200">
                <li>Kaggle 新建 Notebook → 右侧 Settings：<b>Accelerator = GPU T4 x2</b>，<b>Internet = On</b>。</li>
                <li>新建一个 Code Cell，把下面整个文件粘贴进去，点运行（Shift+Enter）。</li>
                <li>等约 20 秒，<b>输出框里会打印一个方框，里面是 https://xxxx.trycloudflare.com</b> —— 复制它。</li>
                <li>粘贴到本页「③ PlatformIO 代码」顶部的「Kaggle 网址」（生成 config.h），再粘贴到「浏览器模拟器」顶部的 Kaggle 输入框，点「连接」。</li>
              </ol>
              <div className="mt-3 rounded-lg bg-[#0e1623] p-3 text-[13px] leading-relaxed text-slate-300">
                资源使用：GPU0 做 8192 点 IFFT（距离剖面），GPU1 做 MUSIC 超分辨（只有 1 块 GPU 时都在 GPU0）；原始 CSI 滚动落盘到 /kaggle/working/radar_raw（上限 20GB，Disk 最大 57.6GiB）。
                <b>诚实说明</b>：单条链路的数据量很小（每轮约 200 帧×128 字节），T4×2 / 30GB 内存远用不满，这是物理问题规模决定的，不是代码没写好。
              </div>
              <div className="mt-3 max-w-xs">{input("API_KEY（写进脚本默认值，需与 config.h 一致）", key, (v) => saveVals(KEY_KEY, v, setKey), "radar-key")}</div>
            </div>
            {renderCard(bundle.kaggle, true, false)}
          </>
        )}

        {bundle && tab === "github" && (
          <>
            <div className="rounded-2xl border border-cyan-400/20 bg-[#0a121f] p-5">
              <h2 className="text-xl font-bold text-cyan-300">GitHub 代码：{ghFiles.length} 个文件 → {GH_REPO}</h2>
              <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-[15px] leading-relaxed text-slate-200">
                <li>每个文件右侧的徽标会实时对比你仓库的 main 分支：<b>已同步</b> / <b>与仓库不同（需更新）</b> / <b>仓库没有（需新建）</b>。</li>
                <li>点「✏️ 在 GitHub 编辑」：内容自动复制到剪贴板并打开对应的编辑（或新建）页面 → 全选粘贴 → Commit。也可以点「📋 复制此文件」自己处理。</li>
                <li>这里复制的 config.h 是<b>占位版本（不含你的 WiFi 密码）</b>，可放心提交。</li>
                <li>仓库里旧的 firmware/platformio.ini、firmware/src/main.cpp 等是旧版（v7）单节点固件，新版在 firmware/node_a 与 firmware/node_b，旧文件可保留也可删除。</li>
              </ol>
            </div>
            {groups.map(([title, fs]) =>
              fs.length ? (
                <section key={title} className="space-y-3">
                  <h3 className="text-lg font-bold text-emerald-300">{title} <span className="text-sm font-normal text-slate-400">· {fs.length} 个文件</span></h3>
                  {fs.map((f) => renderCard(f.path, false, true))}
                </section>
              ) : null,
            )}
          </>
        )}
      </div>
      {toast && <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-emerald-400 px-5 py-2 text-sm font-bold text-slate-900 shadow-lg">{toast}</div>}
    </div>
  );
}
