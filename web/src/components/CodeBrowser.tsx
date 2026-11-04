import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { copyText } from "./DiagPanel";
import { CODE_FILES, KAGGLE_PATH, PIO_A, PIO_B, type CodeFile } from "@/codeBundle";
import { GH_REPO, KEY_KEY, URL_KEY, parseUrls } from "@/lib/radar";

type Sync = "checking" | "same" | "diff" | "missing" | "unknown";
type Tab = "github" | "kaggle" | "pio";

const rawUrl = (p: string) => `https://raw.githubusercontent.com/${GH_REPO}/main/${p.split("/").map(encodeURIComponent).join("/")}`;
const norm = (s: string) => s.replace(/\r\n/g, "\n").replace(/\s+$/g, "");
const kb = (n: number) => (n > 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
const PREVIEW_LINES = 160;

type Vals = { ssid: string; pass: string; urls: string[]; key: string };

/** 把页面里填的 WiFi / Kaggle 网址 / 密钥写进复制出来的 config.h（Kaggle 脚本里的 RADAR_KEY 也同步） */
function applyConfig(f: CodeFile, v: Vals): string {
  let s = f.content;
  if (f.gh.endsWith("include/config.h")) {
    const set = (name: string, val: string) => {
      s = s.replace(new RegExp(`(#define\\s+${name}\\s+)"[^"]*"`), (_m, a) => `${a}${JSON.stringify(val)}`);
    };
    if (v.ssid) set("WIFI_SSID", v.ssid);
    if (v.pass) set("WIFI_PASS", v.pass);
    if (v.urls[0]) set("KAGGLE_URL", v.urls[0]);
    if (v.urls[1]) set("KAGGLE_URL2", v.urls[1]);
    if (v.urls[2]) set("KAGGLE_URL3", v.urls[2]);
    if (v.key) set("API_KEY", v.key);
  } else if (f.gh.endsWith("csi_radar_kaggle.py") && v.key && v.key !== "radar-key") {
    s = s.replace(/os\.environ\.get\("RADAR_KEY",\s*"[^"]*"\)/, `os.environ.get("RADAR_KEY", ${JSON.stringify(v.key)})`);
  }
  return s;
}

export default function CodeBrowser() {
  const [tab, setTab] = useState<Tab>("pio");
  const [ssid, setSsid] = useState(localStorage.getItem("radar.ssid") || "");
  const [pass, setPass] = useState(localStorage.getItem("radar.pass") || "");
  const [urlText, setUrlText] = useState(localStorage.getItem(URL_KEY) || "");
  const [key, setKey] = useState(localStorage.getItem(KEY_KEY) || "radar-key");
  const [sync, setSync] = useState<Record<string, Sync>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [full, setFull] = useState<Record<string, boolean>>({});
  const [toast, setToast] = useState("");
  const started = useRef(false);

  const flash = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(""), 2600);
  };
  const vals: Vals = useMemo(() => ({ ssid, pass, urls: parseUrls(urlText), key }), [ssid, pass, urlText, key]);
  const save = (k: string, v: string, set: (s: string) => void) => {
    set(v);
    localStorage.setItem(k, v);
  };
  const byGh = useMemo(() => new Map(CODE_FILES.map((f) => [f.gh, f])), []);
  const content = useCallback((f: CodeFile) => applyConfig(f, vals), [vals]);

  // GitHub 同步检测：浏览器直接读 raw.githubusercontent.com，对比你仓库里的版本
  useEffect(() => {
    if (tab !== "github" || started.current) return;
    started.current = true;
    const queue = [...CODE_FILES];
    setSync(Object.fromEntries(queue.map((f) => [f.gh, "checking" as Sync])));
    const worker = async () => {
      for (;;) {
        const f = queue.shift();
        if (!f) return;
        let st: Sync = "unknown";
        try {
          const r = await fetch(rawUrl(f.gh) + `?t=${Date.now()}`, { cache: "no-store" });
          if (r.status === 404) st = "missing";
          else if (r.ok) st = norm(await r.text()) === norm(f.content) ? "same" : "diff";
        } catch {
          st = "unknown";
        }
        setSync((o) => ({ ...o, [f.gh]: st }));
      }
    };
    void Promise.all([worker(), worker(), worker(), worker()]);
  }, [tab]);

  const editOnGithub = async (f: CodeFile) => {
    await copyText(content(f));
    const enc = f.gh.split("/").map(encodeURIComponent).join("/");
    const exists = sync[f.gh] === "same" || sync[f.gh] === "diff";
    window.open(exists ? `https://github.com/${GH_REPO}/edit/main/${enc}` : `https://github.com/${GH_REPO}/new/main?filename=${encodeURIComponent(f.gh)}`, "_blank");
    flash(exists ? "已复制：在 GitHub 编辑页 Ctrl+A 全选后 Ctrl+V 粘贴，再点 Commit changes" : "已复制：GitHub 新建文件页粘贴内容后提交（文件名已自动填好）");
  };

  const card = (f: CodeFile | undefined, showSync: boolean) => {
    if (!f) return null;
    const isOpen = open[f.gh] ?? (f.bytes < 20000);
    const st = sync[f.gh];
    const text = content(f);
    const lines = text.split("\n");
    const cut = !full[f.gh] && lines.length > PREVIEW_LINES;
    return (
      <div key={f.gh} className="overflow-hidden rounded-xl border border-white/10 bg-[#0a111d]">
        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
          <button onClick={() => setOpen((o) => ({ ...o, [f.gh]: !isOpen }))} className="text-cyan-300">{isOpen ? "▾" : "▸"}</button>
          <code className="break-all text-[13px] font-semibold text-cyan-200">{f.gh}</code>
          <span className="text-xs text-slate-400">{f.lines} 行 · {kb(f.bytes)}</span>
          {showSync && st && (
            <span className={`rounded-full px-2 py-0.5 text-[11px] ${st === "same" ? "bg-emerald-500/20 text-emerald-200" : st === "diff" ? "bg-amber-500/20 text-amber-200" : st === "missing" ? "bg-rose-500/20 text-rose-200" : "bg-slate-500/20 text-slate-300"}`}>
              {{ checking: "检测中…", same: "已同步", diff: "与仓库不同（需更新）", missing: "仓库没有（需新建）", unknown: "无法检测" }[st]}
            </span>
          )}
          <div className="ml-auto flex gap-2">
            <button onClick={() => editOnGithub(f)} className="rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-[13px] hover:bg-white/10">✏️ 在 GitHub 编辑</button>
            <button onClick={async () => flash((await copyText(text)) ? `已复制 ${f.gh}（${f.lines} 行，完整文件）` : "复制失败，请手动选择")} className="rounded-lg bg-emerald-400 px-3 py-1.5 text-[13px] font-bold text-slate-900 hover:bg-emerald-300">📋 复制此文件</button>
          </div>
        </div>
        {isOpen && (
          <>
            <pre className="max-h-[460px] overflow-auto whitespace-pre border-t border-white/10 bg-[#050a12] p-3 font-mono text-[12.5px] leading-[1.5] text-slate-200">
              {cut ? lines.slice(0, PREVIEW_LINES).join("\n") : text.length > 400000 ? text.slice(0, 400000) : text}
            </pre>
            {lines.length > PREVIEW_LINES && (
              <div className="border-t border-white/10 bg-[#0a111d] px-3 py-1.5 text-[12px] text-slate-400">
                {cut ? `只预览前 ${PREVIEW_LINES} 行（共 ${lines.length} 行）。上面的「复制此文件」复制的是【完整文件】。` : "已展开"}{" "}
                <button className="text-cyan-300 underline" onClick={() => setFull((o) => ({ ...o, [f.gh]: !full[f.gh] }))}>{cut ? "展开全部（会比较卡）" : "收起"}</button>
              </div>
            )}
          </>
        )}
      </div>
    );
  };

  const copyAll = async (paths: string[], label: string) => {
    const txt = paths
      .map((p) => byGh.get(p))
      .filter((f): f is CodeFile => !!f)
      .map((f) => `// ===== ${f.gh} =====\n${content(f)}`)
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

  const groups: [string, CodeFile[]][] = [
    ["kaggle/ — Kaggle 单文件主机端（含内嵌网站）", CODE_FILES.filter((f) => f.gh.startsWith("kaggle/"))],
    ["firmware/node_a — Node A 发起端（PlatformIO）", CODE_FILES.filter((f) => f.gh.startsWith("firmware/node_a/"))],
    ["firmware/node_b — Node B 响应端（PlatformIO）", CODE_FILES.filter((f) => f.gh.startsWith("firmware/node_b/"))],
    ["tools/ — 无硬件仿真与回归测试", CODE_FILES.filter((f) => f.gh.startsWith("tools/"))],
    ["web/ — 浏览器模拟器（Vite + React + three.js）", CODE_FILES.filter((f) => f.gh.startsWith("web/"))],
    ["项目根文件", CODE_FILES.filter((f) => !f.gh.includes("/"))],
  ];
  const kaggleFile = byGh.get(KAGGLE_PATH);

  return (
    <div className="min-h-screen bg-[#070b13] text-slate-100">
      <div className="sticky top-0 z-20 flex flex-wrap items-center gap-3 border-b border-white/10 bg-[#0a0f1a]/95 px-5 py-3 backdrop-blur">
        <a href="#/" className="rounded-xl border border-white/25 px-4 py-2 text-sm hover:bg-white/10">← 返回浏览器模拟器</a>
        <div className="text-lg font-bold">📋 复制代码界面 <span className="text-sm font-normal text-slate-400">· ESP32-S3 双节点 CSI 雷达 v9</span></div>
        <div className="ml-auto flex flex-wrap gap-2">
          {tabBtn("github", "① GitHub 代码")}
          {tabBtn("kaggle", "② Kaggle 单文件")}
          {tabBtn("pio", "③ PlatformIO 代码")}
        </div>
      </div>

      <div className="mx-auto max-w-[1180px] space-y-4 px-4 py-5">
        {tab === "pio" && (
          <>
            <div className="rounded-2xl border border-cyan-400/20 bg-[#0a121f] p-5">
              <h2 className="text-xl font-bold text-cyan-300">PlatformIO（VSCode）代码：两块 ESP32 各 4 个文件</h2>
              <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-[15px] leading-relaxed text-slate-200">
                <li>VSCode → PlatformIO → New Project（Board: <b>Espressif ESP32-S3-DevKitC-1</b>，Framework: <b>Arduino</b>），建两个工程：<b>node_a</b>、<b>node_b</b>。</li>
                <li>把「Node A」的 4 个文件覆盖进 node_a 工程，「Node B」的 4 个文件覆盖进 node_b 工程（<code>platformio.ini</code>、<code>include/config.h</code>、<code>include/radar_common.h</code>、<code>src/main.cpp</code>）。</li>
                <li>两块板子分别 Build → Upload（失败就按住 BOOT 再按 RESET）。<b>烧录完只要供电即可，不用连电脑</b>；板载 RGB 灯显示状态：蓝=连路由器 · 黄=上传 · 绿=成功 · 红=失败 · 紫=等对端 · 青=扫描。</li>
                <li>先运行 Kaggle 单文件，把输出框里的网址（可一次粘贴多个：trycloudflare / lhr.life / pinggy）粘到下面「Kaggle 网址」，复制出来的 config.h 就自动写好了。</li>
              </ol>
              <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {input("WiFi 名称 (2.4GHz)", ssid, (v) => save("radar.ssid", v, setSsid), "WiFi 名称")}
                {input("WiFi 密码", pass, (v) => save("radar.pass", v, setPass), "WiFi 密码")}
                {input("API_KEY（与 Kaggle 一致）", key, (v) => save(KEY_KEY, v, setKey), "radar-key")}
                <label className="flex flex-col gap-1 text-[12px] text-slate-400 sm:col-span-2 lg:col-span-4">
                  Kaggle 网址（可粘贴 1~3 个，第 1 个写进 KAGGLE_URL，其余写进 KAGGLE_URL2/3 作为失败时自动切换的备用）
                  <textarea value={urlText} rows={2} onChange={(e) => save(URL_KEY, e.target.value, setUrlText)} placeholder={"https://xxxx.trycloudflare.com\nhttps://yyyy.lhr.life"} className="rounded-lg border border-white/15 bg-[#0e1623] px-3 py-2 font-mono text-[13px] text-slate-100 outline-none focus:border-cyan-400/70" />
                </label>
              </div>
              <div className="mt-2 text-[12px] text-slate-400">解析到 {vals.urls.length} 个网址 · {vals.ssid ? "WiFi 已填" : "WiFi 未填（config.h 保持占位）"}。填写内容只保存在你自己的浏览器里。</div>
            </div>
            {([["Node A（发起端）", PIO_A, "Node A"], ["Node B（响应端）", PIO_B, "Node B"]] as const).map(([title, paths, lb]) => (
              <div key={title} className="space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                  <h3 className="text-lg font-bold text-emerald-300">{title} — 复制到 {lb === "Node A" ? "node_a" : "node_b"} 工程</h3>
                  <button onClick={() => copyAll([...paths], `${lb} 全部 4 个文件`)} className="rounded-lg bg-emerald-400 px-3 py-1.5 text-[13px] font-bold text-slate-900 hover:bg-emerald-300">📋 一次复制 4 个文件</button>
                </div>
                {paths.map((p) => card(byGh.get(p), false))}
              </div>
            ))}
          </>
        )}

        {tab === "kaggle" && (
          <>
            <div className="rounded-2xl border border-cyan-400/20 bg-[#0a121f] p-5">
              <h2 className="text-xl font-bold text-cyan-300">Kaggle：只要 1 个完整文件</h2>
              <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-[15px] leading-relaxed text-slate-200">
                <li>Kaggle 新建 Notebook → 右侧 Settings：<b>Accelerator = GPU T4 x2</b>，<b>Internet = On</b>，Persistence 随意。</li>
                <li>新建 Code Cell，点下面「📋 复制此文件」，整段粘贴进去，运行。第一次约 1~2 分钟（装依赖、下载 cloudflared）。</li>
                <li><b>输出框里会直接出现整个 WiFi 成像网站</b>：一个绿色按钮「🚀 打开 WiFi 成像系统」+ 全部可用网址（cloudflared / pinggy / localhost.run）+ 内嵌小窗。点按钮就能用，浏览器自动连上主机（同源，无需粘贴）。</li>
                <li>把输出框里的网址粘贴到「③ PlatformIO」页顶部，复制两块板子的 config.h。Cell 要一直保持运行；重新运行后网址会变（固件会通过 ntfy 自动发现，国内网络请手动更新 config.h）。</li>
              </ol>
              <div className="mt-3 rounded-lg border border-white/10 bg-black/20 p-3 text-[13px] text-slate-300">
                资源使用：GPU0 = 16384 点 IFFT；GPU1 = MUSIC + 全距离呼吸扫描；预留显存池（每卡 35%，环境变量 <code>RADAR_VRAM_FRAC</code> 可调）；
                内存 / 磁盘用于原始 CSI 滚动落盘到 /tmp（默认最多 min(40GB, 剩余−8GB)，<code>RADAR_RAW_MAX_GB</code> 可调）。
                数据量只有约 40KB/s，GPU 利用率不会很高——这是物理上的真实情况，脚本不会空转烧 GPU。网页左侧「Kaggle 资源」面板实时显示 nvidia-smi 的利用率/显存。
              </div>
              <div className="mt-3">{input("API_KEY（与 ESP32 一致，非默认时会写进脚本）", key, (v) => save(KEY_KEY, v, setKey), "radar-key")}</div>
            </div>
            {kaggleFile ? (
              card(kaggleFile, true)
            ) : (
              <div className="rounded-xl border border-amber-400/30 bg-amber-500/10 p-4 text-amber-100">
                当前这个页面本身就是从 Kaggle 内嵌的版本，不再包含 Kaggle 脚本（避免自己包含自己）。请到“浏览器模拟器”主站的「复制代码」里获取完整 Kaggle 文件。
              </div>
            )}
          </>
        )}

        {tab === "github" && (
          <>
            <div className="rounded-2xl border border-cyan-400/20 bg-[#0a121f] p-5">
              <h2 className="text-xl font-bold text-cyan-300">GitHub：{GH_REPO} 需要更新的全部文件</h2>
              <ul className="mt-3 list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-slate-200">
                <li>每个文件右侧有「✏️ 在 GitHub 编辑」（自动复制内容 + 打开该文件的编辑页，粘贴后 Commit）和「📋 复制此文件」。</li>
                <li>徽章实时对比你仓库里的版本：<b className="text-emerald-300">已同步</b> / <b className="text-amber-300">与仓库不同（需更新）</b> / <b className="text-rose-300">仓库没有（需新建）</b>。</li>
                <li>新网页（Vite + React）放在仓库 <code>web/</code> 目录，不会覆盖旧的 Next.js 文件；旧的 <code>src/ public/ next.config.ts</code> 等可以以后自行删除。</li>
                <li>Kaggle 文件很大（内嵌了整个网站，约几百 KB），GitHub 网页编辑器粘贴会慢几秒，属于正常。</li>
              </ul>
              <div className="mt-2 flex flex-wrap gap-2">
                <button onClick={() => window.open(`https://github.com/${GH_REPO}`, "_blank")} className="rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-[13px] hover:bg-white/10">打开仓库主页</button>
                <span className="self-center text-[12px] text-slate-400">共 {CODE_FILES.length} 个文件</span>
              </div>
            </div>
            {groups.map(([name, files]) =>
              files.length ? (
                <div key={name} className="space-y-3">
                  <h3 className="text-lg font-bold text-emerald-300">{name}</h3>
                  {files.map((f) => card(f, true))}
                </div>
              ) : null,
            )}
          </>
        )}
      </div>
      {toast && <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-xl bg-emerald-400 px-5 py-2.5 font-semibold text-slate-900 shadow-lg">{toast}</div>}
    </div>
  );
}
