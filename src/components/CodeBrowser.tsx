"use client";
// 复制代码界面：每个文件都有「在 GitHub 编辑」+「复制此文件」，并实时检测 GitHub 上是否已是最新。
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GITHUB_BRANCH, GITHUB_REPO, OLD_FILE_HINTS } from "@/lib/config";
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
  const [hintOld, setHintOld] = useState<string[] | null>(null);
  const [checkedAt, setCheckedAt] = useState<string>("");
  const [checking, setChecking] = useState(false);
  const [err, setErr] = useState("");
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
      // 三级兜底：① 浏览器直连 GitHub API ② 本站服务器代理（可配 GITHUB_TOKEN）③ raw 文件逐个对比
      let tree: { path: string; type: string; sha: string }[] | null = null;
      let lastErr = "";
      for (const url of [`https://api.github.com/repos/${GITHUB_REPO}/git/trees/${GITHUB_BRANCH}?recursive=1`, "/api/github-tree"]) {
        try {
          const r = await fetch(url, { cache: "no-store", headers: { Accept: "application/vnd.github+json" } });
          if (!r.ok) {
            lastErr = `GitHub API ${r.status}`;
            continue;
          }
          const j = (await r.json()) as { tree?: { path: string; type: string; sha: string }[] };
          if (Array.isArray(j.tree)) {
            tree = j.tree;
            break;
          }
        } catch (e2) {
          lastErr = String(e2 instanceof Error ? e2.message : e2);
        }
      }
      if (!tree) throw new Error(lastErr || "GitHub API 不可用");
      const m = new Map<string, string>();
      for (const t of tree) if (t.type === "blob") m.set(t.path, t.sha);
      setRemote(m);
      setRawStatus(null);
      setHintOld(null);
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
        // 顺便探测"已知旧文件"是否还在仓库里（raw 返回 200 即存在）
        const found: string[] = [];
        let k = 0;
        const probe = async () => {
          while (k < OLD_FILE_HINTS.length) {
            const p = OLD_FILE_HINTS[k++];
            try {
              const rr = await fetch(`https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${p.split("/").map(encodeURIComponent).join("/")}?t=${Date.now()}`, { cache: "no-store" });
              if (rr.ok) found.push(p);
            } catch {
              /* ignore */
            }
          }
        };
        await Promise.all([probe(), probe(), probe(), probe()]);
        setHintOld(found.sort());
        setRawStatus(res);
        setRemote(null);
        setErr(`GitHub API 暂不可用（${String(e instanceof Error ? e.message : e)}），已改用 raw 文件对比（GitHub 缓存可能有几分钟延迟）`);
      } catch {
        setErr("无法连接 GitHub（网络问题）。请稍后点「立即检测」。");
      }
    } finally {
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
    if (!remote) return (hintOld ?? []).filter((p) => !local.has(p));
    return Array.from(remote.keys())
      .filter((p) => !local.has(p) && !/^(LICENSE|\.github\/)/i.test(p))
      .sort();
  }, [remote, files, hintOld]);

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

  const pioOrder = (p: string) => (p.endsWith("platformio.ini") ? 0 : p.endsWith("upload_retry.py") ? 1 : p.endsWith("config.h") ? 2 : 3);
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
            {obsolete.length > 0 && <span className="rounded-full bg-yellow-500/15 px-3 py-1 text-yellow-300">GitHub 上有 {obsolete.length} 个旧文件待清理</span>}
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
                VS Code → PlatformIO → 新建一个空文件夹工程（或直接用「下载 ZIP」解压后用 VS Code 打开），把下面 4 个文件<b>逐个复制并覆盖</b>（<b>4 个都要</b>，缺 upload_retry.py 编译会报错）：
                <code className="mx-1 rounded bg-slate-800 px-1">platformio.ini</code>、
                <code className="mx-1 rounded bg-slate-800 px-1">upload_retry.py</code>、
                <code className="mx-1 rounded bg-slate-800 px-1">include/config.h</code>、
                <code className="mx-1 rounded bg-slate-800 px-1">src/main.cpp</code>
              </li>
              <li>在下面填 WiFi 名称和密码（只保存在你浏览器里，复制出来的 config.h 会自动带上；GitHub 版本保持占位符，不会泄露密码）。</li>
              <li>
                底部状态栏选环境 <b>n16r8</b> → Build → Upload。上传前关闭串口监视器；优先用板子标 <b>UART</b> 的 USB 口。烧录中途掉线时，<b>upload_retry.py 会自动等 COM 口恢复并降速重试最多 4 次</b>（日志里能看到 [upload_retry]）。仍失败 → 选 <b>n16r8_slow</b>，或按住 BOOT 点 RST 再 Upload。
              </li>
              <li>另一块板子重复，只是用 ESP32-2 的 config.h（NODE_ID=2）。两块都上电后，回到模拟器点「🔌 连接 ESP32」。</li>
            </ol>
            <details className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs leading-relaxed text-amber-100">
              <summary className="cursor-pointer text-sm font-semibold text-amber-300">
                🛠 烧录写到一半报 “Cannot configure port … OSError(22, 指定不存在的设备)” / “Please specify upload_port” 怎么办？
              </summary>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                <li>含义：写入中途 Windows 的 COM 口消失（USB 掉线/重新枚举），第二次点 Upload 时电脑里根本没有端口，所以报 “Please specify upload_port”。不是代码错误。</li>
                <li>软件侧：已内置 upload_retry.py，自动等端口回来 → 降速 → 改 ROM 直写，最多 4 次，全程不用你再点。</li>
                <li>硬件侧（最关键）：换<b>带数据的短线</b>；<b>直插主板后面板 USB-A 口</b>（不要 HUB / Type-C 转接）；用标 <b>UART/COM</b> 的口，不要用标 USB 的原生口；只插当前要烧的一块板子。</li>
                <li>关闭串口监视器 / 串口助手 / Arduino IDE；设备管理器 → USB 根集线器 → 电源管理，取消“允许计算机关闭此设备以节约电源”。</li>
                <li>手动进下载模式：按住 BOOT → 点 RST → 松开 BOOT → 再点 Upload（日志出现 “Chip is ESP32-S3” 即成功连接）。</li>
                <li>板子名称显示 “DevKitC-1-N8 (8 MB QD, No PSRAM)” 只是 PlatformIO 内置板卡的标题，实际由 platformio.ini 的 qio_opi + 16MB 配置覆盖，不影响 N16R8。</li>
              </ul>
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
                  say(ok ? "已复制全部 4 个文件（含分隔注释，建议还是逐个文件粘贴）" : "复制失败");
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
            {!remote && !hintOld && <p className="text-sm text-yellow-300">正在检测旧文件…（如长时间无结果请点「立即检测 GitHub」）</p>}
            {!remote && hintOld && <p className="text-sm text-yellow-300">GitHub API 被限流，已用 raw 逐个探测「已知旧文件」（列表可能不完整，API 恢复后会自动列出全部）。</p>}
            {(remote || hintOld) && obsolete.length === 0 && <p className="text-sm text-emerald-300">没有多余文件 🎉</p>}
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
