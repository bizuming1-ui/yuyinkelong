"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { copyText } from "./DiagPanel";
import { GH_REPO, KEY_KEY, URL_KEY, parseUrls } from "@/lib/radar";

type F = { path: string; content: string; lines: number; bytes: number };
type Bundle = { files: F[]; kaggle: string; pioA: string[]; pioB: string[]; fix?: string[] };
type Sync = "checking" | "same" | "diff" | "missing" | "unknown";
type Tab = "github" | "kaggle" | "pio";

const rawUrl = (p: string) => `https://raw.githubusercontent.com/${GH_REPO}/main/${p.split("/").map(encodeURIComponent).join("/")}`;
const norm = (s: string) => s.replace(/\r\n/g, "\n").replace(/\s+$/g, "");
const LEGACY = [
  "firmware/platformio.ini",
  "firmware/src/main.cpp",
  "firmware/include/config.h",
  "kaggle/wifi_radar_kaggle.py",
  "scripts/build-kaggle.mjs",
  "scripts/kaggle_template.py",
  "public/radar.html",
  "src/app/Simulator.tsx",
  "src/app/code/CodeBrowser.tsx",
  "src/app/api/bundle/route.ts",
  "tools/test_llm_mock.py",
  "tools/test_csi_server.py",
];
const PS_CMDS: [string, string][] = [
  [
    "① 只检查（不删除）：列出被污染的框架文件",
    'Get-ChildItem "$env:USERPROFILE\\.platformio\\packages\\framework-arduinoespressif32\\libraries" -Recurse -File | Select-String -Pattern "postRecs|KAGGLE_URL|RADAR_TOPIC" -List | Select-Object -ExpandProperty Path',
  ],
  [
    "② 修复：删除被污染的框架缓存（下次 Build 自动重新下载）",
    'Remove-Item -Recurse -Force "$env:USERPROFILE\\.platformio\\packages\\framework-arduinoespressif32"',
  ],
];
const kb = (n: number) => (n > 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

function applyConfig(path: string, content: string, v: { ssid: string; pass: string; urls: string[]; key: string }): string {
  let s = content;
  if (path.endsWith("include/config.h")) {
    if (v.ssid) s = s.replace(/(#define\s+WIFI_SSID\s+)"[^"]*"/, (_m, a) => `${a}${JSON.stringify(v.ssid)}`);
    if (v.pass) s = s.replace(/(#define\s+WIFI_PASS\s+)"[^"]*"/, (_m, a) => `${a}${JSON.stringify(v.pass)}`);
    if (v.urls[0]) s = s.replace(/(#define\s+KAGGLE_URL\s+)"[^"]*"/, (_m, a) => `${a}${JSON.stringify(v.urls[0])}`);
    if (v.urls[1]) s = s.replace(/(#define\s+KAGGLE_URL2\s+)"[^"]*"/, (_m, a) => `${a}${JSON.stringify(v.urls[1])}`);
    if (v.urls[2]) s = s.replace(/(#define\s+KAGGLE_URL3\s+)"[^"]*"/, (_m, a) => `${a}${JSON.stringify(v.urls[2])}`);
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
  const [ssid, setSsid] = useState("bzmdiphone");
  const [pass, setPass] = useState("a12332100");
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("radar-key");
  const [sync, setSync] = useState<Record<string, Sync>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [toast, setToast] = useState("");
  const [legacy, setLegacy] = useState<Record<string, string>>({});
  const started = useRef(false);

  useEffect(() => {
    setUrl(localStorage.getItem(URL_KEY) || "");
    setKey(localStorage.getItem(KEY_KEY) || "radar-key");
    setSsid(localStorage.getItem("radar.ssid") || "bzmdiphone");
    setPass(localStorage.getItem("radar.pass") || "a12332100");
    fetch("/api/code", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: Bundle) => setBundle(j))
      .catch((e) => setErr(String(e)));
  }, []);

  const flash = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(""), 2200);
  };
  const vals = useMemo(() => ({ ssid, pass, urls: parseUrls(url), key }), [ssid, pass, url, key]);
  const saveVals = (k: string, v: string, set: (s: string) => void) => {
    set(v);
    if (k === URL_KEY) localStorage.setItem(k, parseUrls(v).join(" ") || v);
    else localStorage.setItem(k, v);
  };
  const byPath = useMemo(() => new Map((bundle?.files ?? []).map((f) => [f.path, f])), [bundle]);

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

  useEffect(() => {
    if (tab !== "github") return;
    LEGACY.forEach((p) => {
      fetch(rawUrl(p) + `?t=${Date.now()}`, { cache: "no-store" })
        .then((r) => setLegacy((o) => ({ ...o, [p]: r.status === 404 ? "gone" : r.ok ? "exists" : "unknown" })))
        .catch(() => setLegacy((o) => ({ ...o, [p]: "unknown" })));
    });
  }, [tab]);

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
          <button onClick={() => setOpen((o) => ({ ...o, [p]: !isOpen }))} className="text-cyan-300">
            {isOpen ? "▾" : "▸"}
          </button>
          <code className="break-all text-[13px] font-semibold text-cyan-200">{p}</code>
          <span className="text-xs text-slate-400">
            {f.lines} 行 · {kb(f.bytes)}
          </span>
          {showSync && st && (
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] ${
                st === "same"
                  ? "bg-emerald-500/20 text-emerald-200"
                  : st === "diff"
                    ? "bg-amber-500/20 text-amber-200"
                    : st === "missing"
                      ? "bg-rose-500/20 text-rose-200"
                      : "bg-slate-600/40 text-slate-300"
              }`}
            >
              {{ checking: "检测中…", same: "已同步", diff: "与仓库不同（需更新）", missing: "仓库没有（需新建）", unknown: "无法检测" }[st]}
            </span>
          )}
          <div className="ml-auto flex gap-2">
            <button
              onClick={() => editOnGithub(f, withVals)}
              className="rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-[13px] hover:bg-white/10"
            >
              ✏️ 在 GitHub 编辑
            </button>
            <button
              onClick={async () => flash((await copyText(content(f, withVals))) ? `已复制 ${p}` : "复制失败，请手动选择")}
              className="rounded-lg bg-emerald-400 px-3 py-1.5 text-[13px] font-bold text-slate-900 hover:bg-emerald-300"
            >
              📋 复制此文件
            </button>
          </div>
        </div>
        {isOpen && (
          <pre className="max-h-[460px] overflow-auto border-t border-white/10 bg-[#050a12] p-3 font-mono text-[12.5px] leading-[1.5] text-slate-200">
            {content(f, withVals)}
          </pre>
        )}
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
      <input
        type={type}
        value={v}
        onChange={(e) => on(e.target.value)}
        placeholder={ph}
        className="rounded-lg border border-white/15 bg-[#0e1623] px-3 py-2 text-[14px] text-slate-100 outline-none focus:border-cyan-400/70"
      />
    </label>
  );

  const tabBtn = (k: Tab, t: string) => (
    <button
      onClick={() => setTab(k)}
      className={`rounded-xl border px-4 py-2 text-sm font-bold ${
        tab === k ? "border-emerald-300 bg-emerald-400 text-slate-900" : "border-white/20 bg-white/5 text-slate-100 hover:bg-white/10"
      }`}
    >
      {t}
    </button>
  );

  const ghFiles = bundle?.files ?? [];
  const groups: [string, F[]][] = [
    ["firmware/node_a — ★ 1 块 ESP32-S3 主节点固件（单节点全能模式，必烧）", ghFiles.filter((f) => f.path.startsWith("firmware/node_a/"))],
    ["firmware/node_b — 可选第 2 块 ESP32-S3 辅助探头固件（单块板使用时无需烧录）", ghFiles.filter((f) => f.path.startsWith("firmware/node_b/"))],
    ["firmware/tools — PlatformIO 框架损坏一键修复脚本", ghFiles.filter((f) => f.path.startsWith("firmware/tools/"))],
    ["kaggle — Kaggle 云端 T4×2 主机端完整单文件", ghFiles.filter((f) => f.path.startsWith("kaggle/"))],
    ["tools — 沙盒仿真与自动化回归验证套件", ghFiles.filter((f) => f.path.startsWith("tools/"))],
    ["src — 浏览器模拟器 / 3D 全物体检测前端与 API", ghFiles.filter((f) => f.path.startsWith("src/"))],
    ["项目根文件", ghFiles.filter((f) => !f.path.includes("/"))],
  ];

  return (
    <div className="min-h-screen bg-[#070b13] text-slate-100">
      <div className="sticky top-0 z-20 flex flex-wrap items-center gap-3 border-b border-white/10 bg-[#0a0f1a]/95 px-5 py-3 backdrop-blur">
        <Link href="/" className="rounded-xl border border-white/25 px-4 py-2 text-sm hover:bg-white/10">
          ← 返回浏览器模拟器
        </Link>
        <div className="text-lg font-bold">
          📋 复制代码界面 <span className="text-sm font-normal text-cyan-300">· v11 单节点 1×ESP32-S3 全物体检测 + 零断连版 → {GH_REPO}</span>
        </div>
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
            <div className="rounded-2xl border border-emerald-400/40 bg-[#091c18] p-5 text-[14.5px] leading-relaxed text-slate-100">
              <h2 className="text-xl font-bold text-emerald-300">
                ★ v11 重大升级：现在只需 1 个 ESP32-S3（烧录 Node A 工程）即可 100% 实现整个 WiFi 成像与全物体检测系统！
              </h2>
              <ol className="mt-2.5 list-decimal space-y-1.5 pl-5 text-slate-200">
                <li>
                  <b>为什么 1 块 ESP32-S3 就能成功且绝不断连？</b> v11 默认开启 <code>SINGLE_NODE_MODE = 1</code>：ESP32-S3 全程锁定路由器/手机热点信道（<b>绝不主动断开 WiFi</b>），通过内置 50Hz 轻量 UDP/ARP/ESP-NOW 脉冲主动激励路由器高频回传 OFDM 帧，提取 64 子载波原始复数 CSI，同时嗅探周围所有无线辐射源与多径反射体。
                </li>
                <li>
                  <b>烧录方法（VSCode PlatformIO）：</b>只需要打开你的 <code>node_a</code> 工程，把下方「Node A」的 4 个文件（<code>platformio.ini</code>、<code>include/config.h</code>、<code>include/radar_common.h</code>、<code>src/main.cpp</code>）点击「📋 复制此文件」覆盖进去 → Build → Upload 即可！
                </li>
                <li>
                  <b>多隧道零断连：</b>你可以在下方「Kaggle 网址」框里一次粘贴 Kaggle 输出框打印的多个网址（空格分隔，如 trycloudflare + pinggy + lhr.life），下方 <code>config.h</code> 会自动填入 <code>KAGGLE_URL</code>、<code>KAGGLE_URL2</code>、<code>KAGGLE_URL3</code>，且每次上传还会从 Kaggle 实时同步最新隧道列表。
                </li>
              </ol>
              <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {input("WiFi 名称 (2.4GHz)", ssid, (v) => saveVals("radar.ssid", v, setSsid), "bzmdiphone")}
                {input("WiFi 密码", pass, (v) => saveVals("radar.pass", v, setPass), "WiFi 密码", "text")}
                {input("Kaggle 网址（可一次粘贴多个，空格分隔）", url, (v) => saveVals(URL_KEY, v, setUrl), "https://xxxx.trycloudflare.com")}
                {input("API_KEY（与 Kaggle 一致）", key, (v) => saveVals(KEY_KEY, v, setKey), "radar-key")}
              </div>
              <div className="mt-2 text-[12.5px] text-slate-300">
                已解析写入 config.h 的网址：
                {vals.urls.length ? (
                  <b className="text-emerald-300"> {vals.urls.join(" | ")}</b>
                ) : (
                  <span className="text-amber-300"> 尚未填写（即使不填，ESP32 联网后也会通过 ntfy.sh 自动发现 Kaggle 最新网址）</span>
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-rose-400/50 bg-[#1a0d12] p-5 text-[14px] leading-relaxed text-slate-200">
              <h3 className="text-base font-bold text-rose-300">
                🚨 如果 VSCode 编译报错路径在 …\.platformio\packages\framework-arduinoespressif32\libraries\WiFiClientSecure\src\WiFiClientSecure.h ？
              </h3>
              <p className="mt-1.5">
                这是 PlatformIO 框架缓存文件被误粘贴污染所致。关闭 VSCode，在 Windows PowerShell 运行下方命令即可一键清理并自动重下干净框架：
              </p>
              <div className="mt-3 space-y-2">
                {PS_CMDS.map(([label, cmd]) => (
                  <div key={label} className="rounded-lg border border-white/10 bg-[#0b0508] p-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-semibold text-rose-200">{label}</span>
                      <button
                        onClick={async () => flash((await copyText(cmd)) ? "已复制命令：粘贴到 PowerShell 回车" : "复制失败")}
                        className="ml-auto rounded-lg bg-rose-300 px-3 py-1 text-[13px] font-bold text-slate-900 hover:bg-rose-200"
                      >
                        📋 复制命令
                      </button>
                    </div>
                    <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[12px] text-slate-300">{cmd}</pre>
                  </div>
                ))}
              </div>
              <div className="mt-3 space-y-3">{(bundle.fix ?? []).map((p) => renderCard(p, false, false))}</div>
            </div>

            {[
              ["★ Node A（主节点：只用 1 个 ESP32-S3 时只需烧录这 4 个文件！）", bundle.pioA, "Node A"],
              ["Node B（可选第 2 块 ESP32-S3 辅助探头：单块板使用时无需烧录）", bundle.pioB, "Node B"],
            ].map(([title, paths, short]) => (
              <section key={String(short)} className="space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                  <h3 className="text-lg font-bold text-emerald-300">{title as string}</h3>
                  <button
                    onClick={() => copyAll(paths as string[], String(short))}
                    className="rounded-xl bg-cyan-400 px-4 py-2 text-sm font-bold text-slate-900 hover:bg-cyan-300"
                  >
                    📋 复制 {String(short)} 全部 4 个文件
                  </button>
                </div>
                {(paths as string[]).map((p) => renderCard(p, true, false))}
              </section>
            ))}
          </>
        )}

        {bundle && tab === "kaggle" && (
          <>
            <div className="rounded-2xl border border-cyan-400/30 bg-[#0a121f] p-5">
              <h2 className="text-xl font-bold text-cyan-300">
                Kaggle 完整单文件（{ghFiles.find((f) => f.path === bundle.kaggle)?.lines ?? 0} 行 · 仅此 1 个文件）
              </h2>
              <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-[15px] leading-relaxed text-slate-200">
                <li>
                  Kaggle 新建 Notebook → 右侧 Settings：<b>Accelerator = GPU T4 x2</b>，<b>Internet = On</b>。
                </li>
                <li>新建一个 Code Cell，点击下方「📋 复制此文件」，把整个文件粘贴进 Cell 运行（Shift+Enter）。</li>
                <li>
                  <b>用尽 Kaggle T4×2 / 30GiB RAM / 57.6GiB Disk 资源：</b>
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-[13.5px] text-slate-300">
                    <li>
                      <b>GPU 0 (Tesla T4 15GiB)：</b>预分配高达 80% 显存池（≈12GiB VRAM），执行 <b>65,536 点超精细零填充批量 IFFT</b> + 自回归频谱外推（Burg AR）+ 65 路并行 SAR 相位自动聚焦；
                    </li>
                    <li>
                      <b>GPU 1 (Tesla T4 15GiB)：</b>预分配高达 80% 显存池（≈12GiB VRAM），执行 <b>高阶前后向空间平滑 MUSIC 超分辨（1024 密集网格）</b> + <b>SVD 奇异值分解静态物体/动态目标分离</b> + <b>256×256 全距离-多普勒/呼吸矩阵扫描</b>；
                    </li>
                    <li>
                      <b>CPU RAM (最大 30GiB)：</b>构建 <b>大容量内存环形张量池（RAM Tensor Ring Buffer，Kaggle 下自动分配高达 6GiB 高速历史张量池）</b>，加上无锁快照架构（<code>/api/state</code> 响应 &lt;0.5ms）；
                    </li>
                    <li>
                      <b>Disk (最大 57.6GiB)：</b>原始 CSI 飞行记录器自动写入 <code>/tmp/radar_raw</code>（上限自适应高达 50GiB 滚动落盘）。
                    </li>
                  </ul>
                </li>
                <li>
                  <b>零断连架构：</b>修复了 PyTorch CUDA <code>flip(dims=(0,1))</code> 异常，移除 GPU 计算期间的全局锁阻塞，并内置每 8 秒三隧道（cloudflared + pinggy + localhost.run）主动保活预热器，彻底消灭 50 秒空闲断连。
                </li>
              </ol>
              <div className="mt-3 max-w-xs">{input("API_KEY（写进脚本默认值，需与 config.h 一致）", key, (v) => saveVals(KEY_KEY, v, setKey), "radar-key")}</div>
            </div>
            {renderCard(bundle.kaggle, true, false)}
          </>
        )}

        {bundle && tab === "github" && (
          <>
            <div className="rounded-2xl border border-cyan-400/20 bg-[#0a121f] p-5">
              <h2 className="text-xl font-bold text-cyan-300">
                GitHub 仓库全部代码文件（共 {ghFiles.length} 个文件）→ {GH_REPO}
              </h2>
              <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-[15px] leading-relaxed text-slate-200">
                <li>
                  每个文件卡片均提供 <b>「✏️ 在 GitHub 编辑」</b> 和 <b>「📋 复制此文件」</b> 两个按键，并自动对比你仓库 <code>{GH_REPO}</code> 的 <code>main</code> 分支同步状态。
                </li>
                <li>
                  点击「✏️ 在 GitHub 编辑」会自动把最新代码复制到剪贴板并打开对应文件的 GitHub 编辑/新建页面，在页面里按 <code>Ctrl+A</code> 全选 → <code>Ctrl+V</code> 粘贴 → 右上角 <b>Commit changes</b> 即可。
                </li>
              </ol>
              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                <a
                  href={`https://github.com/${GH_REPO}`}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-lg border border-white/20 bg-white/5 px-3 py-1.5 hover:bg-white/10"
                >
                  打开仓库 {GH_REPO} ↗
                </a>
                <button
                  onClick={() => {
                    started.current = false;
                    setSync({});
                    setTab("pio");
                    setTimeout(() => setTab("github"), 30);
                  }}
                  className="rounded-lg border border-white/20 bg-white/5 px-3 py-1.5 hover:bg-white/10"
                >
                  🔄 重新检测 GitHub 同步状态
                </button>
              </div>
            </div>

            {LEGACY.some((p) => legacy[p] === "exists") && (
              <div className="rounded-2xl border border-rose-400/30 bg-rose-500/10 p-5">
                <h3 className="text-base font-bold text-rose-300">🗑 仓库里还存在的旧版废弃文件（建议在 GitHub 删除）</h3>
                <div className="mt-2 space-y-1.5">
                  {LEGACY.filter((p) => legacy[p] === "exists").map((p) => (
                    <div key={p} className="flex items-center gap-2 rounded-lg bg-black/30 px-3 py-1.5 text-sm">
                      <code className="text-rose-200">{p}</code>
                      <a
                        href={`https://github.com/${GH_REPO}/delete/main/${p.split("/").map(encodeURIComponent).join("/")}`}
                        target="_blank"
                        rel="noreferrer"
                        className="ml-auto rounded-lg bg-rose-400 px-3 py-1 text-xs font-bold text-slate-900 hover:bg-rose-300"
                      >
                        🗑 在 GitHub 删除
                      </a>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {groups.map(([title, list]) =>
              list.length ? (
                <section key={title} className="space-y-3">
                  <h3 className="text-lg font-bold text-emerald-300">
                    {title}（{list.length}）
                  </h3>
                  {list.map((f) => renderCard(f.path, false, true))}
                </section>
              ) : null,
            )}
          </>
        )}
      </div>

      {toast && (
        <div className="pointer-events-none fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-full bg-cyan-400 px-4 py-1.5 text-sm font-semibold text-slate-950 shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}
