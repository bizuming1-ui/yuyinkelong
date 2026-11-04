"use client";
// 复制代码界面：每个文件都有「在 GitHub 编辑」+「复制此文件」，并实时检测 GitHub 上是否已是最新。
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GITHUB_BRANCH, GITHUB_REPO } from "@/lib/config";
import { gitShaVariants } from "@/lib/sha1";

interface CodeFile {
  path: string;
  content: string;
  group: "esp32-1" | "esp32-2" | "web" | "tools" | "docs";
  lines: number;
  bytes: number;
}

type Sync = "unknown" | "synced" | "modified" | "missing";
type Tab = "github" | "esp32-1" | "esp32-2" | "clean";

const REPO_URL = `https://github.com/${GITHUB_REPO}`;

// 旧版（Kaggle + Vite）遗留文件：新版已不再使用。即使 GitHub API 限流(403)，也能逐个用 raw 地址探测它们是否还在仓库里。
const LEGACY_PATHS = [
  "提示词",
  "检测日志",
  "web/index.html",
  "web/package.json",
  "web/tsconfig.json",
  "web/scripts/build-kaggle.mjs",
  "web/src/App.tsx",
  "web/src/main.tsx",
  "web/src/index.css",
  "web/src/vite-env.d.ts",
  "web/src/components/CodeBrowser.tsx",
  "web/src/components/DiagPanel.tsx",
  "web/src/components/Radar3D.tsx",
  "web/src/components/SimulatorShell.tsx",
  "web/src/lib/advisor.ts",
  "web/src/lib/diag.ts",
  "web/src/lib/radar.ts",
  "web/src/lib/useRadar.ts",
  "web/src/utils/cn.ts",
  "tools/sim_esp32_csi.py",
  "tools/test_host.py",
  "tools/test_scene_server.py",
  "tools/test_next_server.py",
  "src/lib/diag.ts",
  "src/lib/radar-store.ts",
];
const editUrl = (p: string, exists: boolean) =>
  exists
    ? `${REPO_URL}/edit/${GITHUB_BRANCH}/${p}`
    : `${REPO_URL}/new/${GITHUB_BRANCH}?filename=${encodeURIComponent(p)}`;

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
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

async function downloadZip(name: string, entries: { path: string; content: string }[]) {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  for (const e of entries) zip.file(e.path, e.content);
  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 2000);
}

export default function CodeBrowser({ files }: { files: CodeFile[] }) {
  const [tab, setTab] = useState<Tab>("github");
  const [remote, setRemote] = useState<Map<string, string> | null>(null);
  const [rawStatus, setRawStatus] = useState<Map<string, Sync> | null>(null);
  const [checkedAt, setCheckedAt] = useState<string>("");
  const [checking, setChecking] = useState(false);
  const [err, setErr] = useState("");
  const [legacyFound, setLegacyFound] = useState<string[] | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [toast, setToast] = useState("");
  const [ssid, setSsid] = useState("");
  const [pass, setPass] = useState("");
  const [q, setQ] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    try {
      setSsid(localStorage.getItem("bzm-ssid") || "");
      setPass(localStorage.getItem("bzm-pass") || "");
    } catch {
      /* ignore */
    }
  }, []);

  const shas = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const f of files) m.set(f.path, gitShaVariants(f.content));
    return m;
  }, [files]);

  const say = (t: string) => {
    setToast(t);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(""), 2200);
  };

  const check = useCallback(async () => {
    setChecking(true);
    setErr("");
    try {
      const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/git/trees/${GITHUB_BRANCH}?recursive=1`, {
        cache: "no-store",
        headers: { Accept: "application/vnd.github+json" },
      });
      if (!r.ok) throw new Error(`GitHub API ${r.status}`);
      const j = (await r.json()) as { tree: { path: string; type: string; sha: string }[] };
      const m = new Map<string, string>();
      for (const t of j.tree) if (t.type === "blob") m.set(t.path, t.sha);
      setRemote(m);
      setRawStatus(null);
    } catch (e) {
      // 兜底：API 限流/失败时，逐个下载 raw 文件对比内容
      try {
        const res = new Map<string, Sync>();
        let i = 0;
        const worker = async () => {
          while (i < files.length) {
            const f = files[i++];
            try {
              const rr = await fetch(`https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${f.path}?t=${Date.now()}`, { cache: "no-store" });
              if (rr.status === 404) res.set(f.path, "missing");
              else if (rr.ok) {
                const t = (await rr.text()).replace(/\r\n/g, "\n");
                res.set(f.path, t.trimEnd() === f.content.trimEnd() ? "synced" : "modified");
              } else res.set(f.path, "unknown");
            } catch {
              res.set(f.path, "unknown");
            }
          }
        };
        await Promise.all([worker(), worker(), worker(), worker()]);
        setRawStatus(res);
        setRemote(null);
        setErr(`GitHub API 暂不可用（${String(e instanceof Error ? e.message : e)}），已改用 raw 文件对比（GitHub 缓存可能有几分钟延迟）`);
      } catch {
        setErr("无法连接 GitHub（网络问题）。请稍后点「立即检测」。");
      }
    } finally {
      // 旧文件探测（不依赖 GitHub API）：并发 6 个，raw 地址返回 200 就说明 GitHub 上还有这个旧文件
      try {
        const found: string[] = [];
        let k = 0;
        const probe = async () => {
          while (k < LEGACY_PATHS.length) {
            const lp = LEGACY_PATHS[k++];
            try {
              const rr = await fetch(`https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${lp.split("/").map(encodeURIComponent).join("/")}?t=${Date.now()}`, { cache: "no-store" });
              if (rr.ok) found.push(lp);
            } catch {
              /* 网络问题：忽略 */
            }
          }
        };
        await Promise.all([probe(), probe(), probe(), probe(), probe(), probe()]);
        setLegacyFound(found.sort());
      } catch {
        /* ignore */
      }
      setChecking(false);
      setCheckedAt(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
    }
  }, [files]);

  // 进入页面检测 + 每 90 秒 + 每次回到本页（你在 GitHub 提交完切回来时）立刻检测
  useEffect(() => {
    check();
    const id = setInterval(check, 90_000);
    const onVis = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onVis);
    };
  }, [check]);

  const statusOf = useCallback(
    (p: string): Sync => {
      if (remote) {
        const s = remote.get(p);
        if (!s) return "missing";
        return shas.get(p)?.includes(s) ? "synced" : "modified";
      }
      if (rawStatus) return rawStatus.get(p) ?? "unknown";
      return "unknown";
    },
    [remote, rawStatus, shas],
  );

  const counts = useMemo(() => {
    const c = { synced: 0, modified: 0, missing: 0, unknown: 0 };
    for (const f of files) c[statusOf(f.path)]++;
    return c;
  }, [files, statusOf]);

  const pending = files.filter((f) => ["modified", "missing"].includes(statusOf(f.path)));

  const obsolete = useMemo(() => {
    const local = new Set(files.map((f) => f.path));
    if (!remote) return (legacyFound ?? []).filter((p) => !local.has(p));
    return Array.from(remote.keys())
      .filter((p) => !local.has(p) && !/^(LICENSE|\.github\/)/i.test(p))
      .sort();
  }, [remote, legacyFound, files]);

  const applyWifi = (f: CodeFile) => {
    if (!f.path.endsWith("include/config.h")) return f.content;
    let c = f.content;
    if (ssid) c = c.replace('"YOUR_WIFI_NAME"', JSON.stringify(ssid));
    if (pass) c = c.replace('"YOUR_WIFI_PASSWORD"', JSON.stringify(pass));
    return c;
  };

  const visible = files.filter((f) => {
    if (tab === "github") return !q || f.path.toLowerCase().includes(q.toLowerCase());
    if (tab === "esp32-1" || tab === "esp32-2") return f.group === tab;
    return false;
  });

  const pioOrder = (p: string) => (p.endsWith("platformio.ini") ? 0 : p.endsWith("config.h") ? 1 : 2);
  const list = tab === "esp32-1" || tab === "esp32-2" ? [...visible].sort((a, b) => pioOrder(a.path) - pioOrder(b.path)) : visible;
  const isPio = tab === "esp32-1" || tab === "esp32-2";

  const badge = (s: Sync) => {
    const map: Record<Sync, [string, string]> = {
      synced: ["✅ GitHub 已是最新", "bg-emerald-500/15 text-emerald-300 border-emerald-500/40"],
      modified: ["⚠️ 与 GitHub 不同 · 需要更新", "bg-orange-500/15 text-orange-300 border-orange-500/40"],
      missing: ["🆕 GitHub 上还没有 · 需要新建", "bg-rose-500/15 text-rose-300 border-rose-500/40"],
      unknown: ["… 检测中", "bg-slate-500/15 text-slate-300 border-slate-500/40"],
    };
    const [t, c] = map[s];
    return <span className={`rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${c}`}>{t}</span>;
  };

  const renderCard = (f: CodeFile) => {
    const s = statusOf(f.path);
    const text = isPio ? applyWifi(f) : f.content;
    const isOpen = !!open[f.path];
    return (
      <div key={f.path} className="rounded-xl border border-slate-800 bg-[#0a1322]">
        <div className="flex flex-wrap items-center gap-2 p-3">
          <button className="min-w-0 flex-1 text-left" onClick={() => setOpen({ ...open, [f.path]: !isOpen })}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-slate-500">{isOpen ? "▼" : "▶"}</span>
              <span className="break-all font-mono text-sm font-semibold text-cyan-200">{f.path}</span>
              {badge(s)}
            </div>
            <div className="ml-5 text-[11px] text-slate-500">
              {f.lines} 行 · {(f.bytes / 1024).toFixed(1)} KB
            </div>
          </button>
          <button
            className="btn-ghost"
            onClick={async () => {
              const ok = await copyText(f.content);
              say(ok ? `已复制 ${f.path} → 到 GitHub 编辑器里 Ctrl+A 全选后 Ctrl+V 粘贴，再点 Commit` : "复制失败，请展开后手动复制");
              window.open(editUrl(f.path, s !== "missing"), "_blank", "noopener");
            }}
          >
            ✏️ 在 GitHub 编辑{s === "missing" ? "（新建）" : ""}
          </button>
          <button
            className="btn-primary"
            onClick={async () => {
              const ok = await copyText(text);
              say(ok ? `✓ 已复制 ${f.path}` : "复制失败，请展开后手动复制");
            }}
          >
            📋 复制此文件
          </button>
        </div>
        {isOpen && (
          <pre className="max-h-[60vh] overflow-auto border-t border-slate-800 bg-black/40 p-3 text-[12px] leading-5 text-slate-200">
            <code>{text}</code>
          </pre>
        )}
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-[#050a14] pb-24 text-slate-200">
      <header className="sticky top-0 z-20 flex flex-wrap items-center gap-2 border-b border-slate-800 bg-[#0b1220]/95 px-4 py-3 backdrop-blur">
        <Link href="/" className="btn-ghost">
          ← 返回 3D 模拟器
        </Link>
        <h1 className="mr-auto text-base font-bold text-white">📋 复制代码界面</h1>
        <button className="btn-ghost" onClick={check} disabled={checking}>
          {checking ? "检测中…" : "🔄 立即检测 GitHub"}
        </button>
        <a className="btn-ghost" href="/api/download">
          ⬇ 下载整个项目 ZIP
        </a>
        <a className="btn-ghost" href={REPO_URL} target="_blank" rel="noopener noreferrer">
          打开 GitHub 仓库
        </a>
      </header>

      <div className="mx-auto max-w-5xl space-y-4 px-4 pt-4">
        {/* 同步总览 */}
        <section className="card">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <b className="text-white">GitHub 同步检测</b>
            <span className="text-slate-400">仓库 {GITHUB_REPO} · 分支 {GITHUB_BRANCH}</span>
            <span className="ml-auto text-xs text-slate-500">上次检测 {checkedAt || "…"}（每 90 秒 + 切回本页时自动检测）</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            <span className="rounded-full bg-emerald-500/15 px-3 py-1 text-emerald-300">已最新 {counts.synced}</span>
            <span className="rounded-full bg-orange-500/15 px-3 py-1 text-orange-300">需要更新 {counts.modified}</span>
            <span className="rounded-full bg-rose-500/15 px-3 py-1 text-rose-300">需要新建 {counts.missing}</span>
            <span className="rounded-full bg-slate-500/15 px-3 py-1 text-slate-300">共 {files.length} 个文件</span>
            {obsolete.length > 0 && (
              <button onClick={() => setTab("clean")} className="rounded-full bg-yellow-500/15 px-3 py-1 text-yellow-300 hover:bg-yellow-500/25">
                GitHub 上有 {obsolete.length} 个旧文件待清理 →
              </button>
            )}
          </div>
          {err && <p className="mt-2 text-xs text-yellow-300">{err}</p>}
          {pending.length > 0 ? (
            <div className="mt-3 rounded-lg border border-orange-500/30 bg-orange-500/5 p-3 text-xs">
              <div className="mb-1 font-semibold text-orange-300">⚠️ 还没更新到 GitHub 的文件（点右边按钮逐个处理）：</div>
              <ul className="space-y-1">
                {pending.map((f) => (
                  <li key={f.path} className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-orange-100">{f.path}</span>
                    <span className="text-slate-500">{statusOf(f.path) === "missing" ? "新建" : "更新"}</span>
                    <button
                      className="ml-auto rounded bg-slate-700 px-2 py-0.5 hover:bg-slate-600"
                      onClick={async () => {
                        await copyText(f.content);
                        say(`已复制 ${f.path}，到 GitHub 编辑器粘贴`);
                        window.open(editUrl(f.path, statusOf(f.path) !== "missing"), "_blank", "noopener");
                      }}
                    >
                      复制并去 GitHub 编辑
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            counts.unknown === 0 && <p className="mt-3 text-sm text-emerald-300">🎉 所有文件都已经和 GitHub 一致。</p>
          )}
        </section>

        {/* 标签 */}
        <nav className="flex flex-wrap gap-2">
          {(
            [
              ["github", "📁 GitHub 全部文件"],
              ["esp32-1", "🔌 PlatformIO · ESP32-1"],
              ["esp32-2", "🔌 PlatformIO · ESP32-2"],
              ["clean", "🧹 GitHub 旧文件清理"],
            ] as [Tab, string][]
          ).map(([k, t]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`rounded-lg px-4 py-2 text-sm font-bold ${tab === k ? "bg-cyan-400 text-slate-900" : "bg-[#121d31] text-slate-300 hover:bg-[#1a2a45]"}`}
            >
              {t}
            </button>
          ))}
        </nav>

        {tab === "github" && (
          <div className="space-y-3">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索文件名…"
              className="w-full rounded-lg border border-slate-700 bg-[#0f1a2c] px-3 py-2 text-sm outline-none"
            />
            <p className="text-xs leading-relaxed text-slate-500">
              「在 GitHub 编辑」会先把本文件内容复制到剪贴板，再打开 GitHub 网页编辑器：在编辑框里 <b>Ctrl+A</b> 全选 → <b>Ctrl+V</b> 粘贴 → 右上角 Commit changes。回到本页会自动重新检测。
            </p>
          </div>
        )}

        {isPio && (
          <section className="card space-y-3">
            <h2 className="text-base font-bold text-white">烧录 {tab === "esp32-1" ? "ESP32-1（NODE_ID=1，主节点）" : "ESP32-2（NODE_ID=2，从节点）"}</h2>
            <ol className="list-decimal space-y-1 pl-5 text-sm leading-relaxed text-slate-300">
              <li>
                VS Code → PlatformIO → 新建一个空文件夹工程（或直接用「下载 ZIP」解压后用 VS Code 打开），把下面 3 个文件<b>逐个复制并覆盖</b>：
                <code className="mx-1 rounded bg-slate-800 px-1">platformio.ini</code>、
                <code className="mx-1 rounded bg-slate-800 px-1">include/config.h</code>、
                <code className="mx-1 rounded bg-slate-800 px-1">src/main.cpp</code>
              </li>
              <li>在下面填 WiFi 名称和密码（只保存在你浏览器里，复制出来的 config.h 会自动带上；GitHub 版本保持占位符，不会泄露密码）。</li>
              <li>
                底部状态栏选环境 <b>n16r8</b> → Build → Upload（默认已是 115200 稳定速度）。上传前关闭串口监视器；优先用板子标 <b>UART</b> 的 USB 口。
                失败就依次换环境：<b>n16r8_safe</b>（不压缩）→ <b>n16r8_slow</b>（57600）。
              </li>
              <li>另一块板子重复，只是用 ESP32-2 的 config.h（NODE_ID=2）。两块都上电后，回到模拟器点「🔌 连接 ESP32」。</li>
            </ol>
            <details className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs leading-relaxed text-slate-300">
              <summary className="cursor-pointer text-sm font-bold text-amber-300">🛠 烧录到一半报 OSError(22 指定不存在的设备) / 找不到 upload_port？点开看解决办法</summary>
              <div className="mt-2 space-y-1.5">
                <p><b>原因</b>：写到一半时 Windows 上这个 COM 口突然消失（USB 掉线/重新枚举），esptool 再配置串口就报错；第二次报「Please specify upload_port」是因为板子此时已经没有 COM 口。<b>不是代码错误</b>（固件已在本地用 PlatformIO 编译通过，RAM 14.5% / Flash 10.9%）。</p>
                <ol className="list-decimal space-y-1 pl-5">
                  <li>换一根<b>确定能传数据</b>的短 USB 线，直插电脑主板后置 USB-A 口（不要 HUB / 不要 Type-C 转接 / 不要前置面板口）。</li>
                  <li>两个 USB 口里用标 <b>UART</b> 或 <b>COM</b> 的那个；关闭串口监视器、串口助手、Arduino IDE。</li>
                  <li>手动进下载模式：<b>按住 BOOT 不放 → 点一下 RST → 松开 BOOT</b>。设备管理器会出现新的 COM 口，把它写进 platformio.ini 的 <code>upload_port = COMxx</code>（去掉行首分号）。</li>
                  <li>依次尝试环境 <b>n16r8</b> → <b>n16r8_safe</b>（115200 + 不压缩）→ <b>n16r8_slow</b>（57600 + 不压缩）。</li>
                  <li>设备管理器 → 通用串行总线控制器 → 每个「USB 根集线器」→ 电源管理 → 取消「允许计算机关闭此设备以节约电源」；控制面板 → 电源选项 → USB 选择性暂停设置 → 已禁用。</li>
                  <li>CH340/CH343 驱动太新也会这样：卸载后装 2023 年以前的旧版驱动。仍不行就换电脑 USB 口或换线。</li>
                  <li>烧录成功后：固件已启用 USB CDC，原生口一直保持为 COM 口，以后 Upload 会自动识别并自动复位，不再需要手动按键。</li>
                </ol>
              </div>
            </details>
            <div className="grid gap-2 sm:grid-cols-2">
              <input
                value={ssid}
                onChange={(e) => {
                  setSsid(e.target.value);
                  try {
                    localStorage.setItem("bzm-ssid", e.target.value);
                  } catch {
                    /* ignore */
                  }
                }}
                placeholder="WiFi 名称（2.4GHz）"
                className="rounded-lg border border-slate-700 bg-[#0f1a2c] px-3 py-2 text-sm outline-none"
              />
              <input
                value={pass}
                onChange={(e) => {
                  setPass(e.target.value);
                  try {
                    localStorage.setItem("bzm-pass", e.target.value);
                  } catch {
                    /* ignore */
                  }
                }}
                placeholder="WiFi 密码"
                className="rounded-lg border border-slate-700 bg-[#0f1a2c] px-3 py-2 text-sm outline-none"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                className="btn-primary"
                onClick={async () => {
                  const ok = await copyText(list.map((f) => `// ======== ${f.path.replace(/^firmware\/esp32-\d\//, "")} ========\n${applyWifi(f)}`).join("\n\n"));
                  say(ok ? "已复制全部 3 个文件（含分隔注释，建议还是逐个文件粘贴）" : "复制失败");
                }}
              >
                📋 复制全部（合并）
              </button>
              <button
                className="btn-ghost"
                onClick={() => downloadZip(`${tab}-platformio.zip`, list.map((f) => ({ path: f.path.replace(/^firmware\/esp32-\d\//, ""), content: applyWifi(f) })))}
              >
                ⬇ 下载 {tab} 工程 ZIP（含你的 WiFi）
              </button>
              <a className="btn-ghost" href={`/api/download?t=${tab}`}>
                ⬇ 下载（占位符版）
              </a>
            </div>
          </section>
        )}

        {tab === "clean" ? (
          <section className="card space-y-3">
            <h2 className="text-base font-bold text-white">GitHub 上有、但新版本已不再需要的文件</h2>
            <p className="text-xs leading-relaxed text-slate-400">
              旧版是 Kaggle + Vite 方案（kaggle/、web/、旧的 src/、tools/*.py 等）。新版是 Next.js + MQTT，不再使用 Kaggle。这些旧文件留着不会报错，但会让仓库混乱；其中旧的 package.json / tsconfig.json 会被新版覆盖。点「删除」会打开 GitHub 的删除页面，滚到底点 Commit。
            </p>
            {!remote && legacyFound === null && <p className="text-sm text-yellow-300">正在检测旧文件…（GitHub API 限流时改用 raw 逐个探测已知旧文件）</p>}
            {!remote && legacyFound !== null && <p className="text-xs text-yellow-300">GitHub API 暂不可用，已用 raw 地址探测「已知旧文件」；不在已知清单里的多余文件需要 API 恢复后才能列出。</p>}
            {(remote || legacyFound !== null) && obsolete.length === 0 && <p className="text-sm text-emerald-300">没有多余文件 🎉</p>}
            <ul className="space-y-1">
              {obsolete.map((p) => (
                <li key={p} className="flex items-center gap-2 rounded border border-slate-800 bg-[#0a1322] px-3 py-1.5 text-sm">
                  <span className="break-all font-mono text-slate-300">{p}</span>
                  <a className="btn-ghost ml-auto" target="_blank" rel="noopener noreferrer" href={`${REPO_URL}/delete/${GITHUB_BRANCH}/${p}`}>
                    🗑 在 GitHub 删除
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <div className="space-y-3">
            {list.map((f) => renderCard(f))}
            {list.length === 0 && <p className="text-sm text-slate-500">没有匹配的文件</p>}
          </div>
        )}
      </div>

      {toast && <div className="fixed bottom-6 left-1/2 z-50 max-w-[90vw] -translate-x-1/2 rounded-xl bg-emerald-500 px-5 py-3 text-sm font-semibold text-slate-900 shadow-xl">{toast}</div>}
    </div>
  );
}
