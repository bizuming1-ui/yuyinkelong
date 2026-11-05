// 复制代码界面：每个文件都有「在 GitHub 编辑」+「复制此文件」，并实时检测 GitHub 上是否已是最新。
// 分三类：GitHub 全部文件 / PlatformIO · ESP32-1 / PlatformIO · ESP32-2（复制到 PlatformIO 烧录用）。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GITHUB_BRANCH, GITHUB_REPO, OLD_FILE_HINTS } from "@/lib/config";
import { gitShaVariants } from "@/lib/sha1";
import { FILES, type CodeFile } from "@/lib/manifest";

type Sync = "unknown" | "synced" | "modified" | "missing";
type Tab = "github" | "esp32-1" | "esp32-2" | "clean";

const REPO_URL = `https://github.com/${GITHUB_REPO}`;
const editUrl = (p: string, exists: boolean) => (exists ? `${REPO_URL}/edit/${GITHUB_BRANCH}/${p}` : `${REPO_URL}/new/${GITHUB_BRANCH}?filename=${encodeURIComponent(p)}`);

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

export default function CodeBrowser() {
  const files = FILES;
  const [tab, setTab] = useState<Tab>("github");
  const [remote, setRemote] = useState<Map<string, string> | null>(null);
  const [rawStatus, setRawStatus] = useState<Map<string, Sync> | null>(null);
  const [hintOld, setHintOld] = useState<string[] | null>(null);
  const [checkedAt, setCheckedAt] = useState("");
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
      let tree: { path: string; type: string; sha: string }[] | null = null;
      let lastErr = "";
      try {
        const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/git/trees/${GITHUB_BRANCH}?recursive=1`, { cache: "no-store", headers: { Accept: "application/vnd.github+json" } });
        if (r.ok) {
          const j = (await r.json()) as { tree?: { path: string; type: string; sha: string }[] };
          if (Array.isArray(j.tree)) tree = j.tree;
        } else lastErr = `GitHub API ${r.status}`;
      } catch (e2) {
        lastErr = String(e2 instanceof Error ? e2.message : e2);
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

  // 进入页面检测 + 每 60 秒 + 每次回到本页（你在 GitHub 提交完切回来时）立刻检测
  useEffect(() => {
    check();
    const id = setInterval(check, 60_000);
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

  const isPio = tab === "esp32-1" || tab === "esp32-2";
  const pioOrder = (p: string) => (p.endsWith("platformio.ini") ? 0 : p.endsWith("upload_retry.py") ? 1 : p.endsWith("config.h") ? 2 : 3);
  const visible = files.filter((f) => {
    if (tab === "github") return !q || f.path.toLowerCase().includes(q.toLowerCase());
    if (isPio) return f.group === tab;
    return false;
  });
  const list = isPio ? [...visible].sort((a, b) => pioOrder(a.path) - pioOrder(b.path)) : visible;

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
    const exists = s !== "missing";
    return (
      <div key={f.path} className="rounded-xl border border-slate-800 bg-[#0a1322]">
        <div className="flex flex-wrap items-center gap-2 p-3">
          <button className="min-w-0 flex-1 text-left" onClick={() => setOpen({ ...open, [f.path]: !isOpen })}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-slate-500">{isOpen ? "▼" : "▶"}</span>
              <span className="font-mono text-sm font-semibold break-all text-cyan-200">{f.path}</span>
              {badge(s)}
            </div>
            <div className="mt-0.5 pl-5 text-[11px] text-slate-500">
              {f.lines} 行 · {(f.bytes / 1024).toFixed(1)} KB
            </div>
          </button>
          <a href={editUrl(f.path, exists)} target="_blank" rel="noreferrer" className="rounded-lg border border-slate-600 bg-slate-800 px-3 py-1.5 text-xs font-bold text-slate-100 hover:bg-slate-700">
            ✏️ 在 GitHub 编辑
          </a>
          <button
            className="rounded-lg bg-cyan-400 px-3 py-1.5 text-xs font-bold text-slate-900 hover:bg-cyan-300 active:scale-95"
            onClick={async () => say((await copyText(text)) ? `已复制：${f.path}` : "复制失败，请展开后手动复制")}
          >
            📋 复制此文件
          </button>
          <button
            className="rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-bold text-slate-950 hover:bg-emerald-400 active:scale-95"
            title="先复制，再打开 GitHub 编辑页，到编辑框里 Ctrl+A 全选后 Ctrl+V 粘贴"
            onClick={async () => {
              const ok = await copyText(text);
              say(ok ? "已复制，请在 GitHub 编辑页 Ctrl+A → Ctrl+V → Commit" : "复制失败");
              window.open(editUrl(f.path, exists), "_blank");
            }}
          >
            ⚡ 复制并去 GitHub
          </button>
        </div>
        {isOpen && <pre className="max-h-[420px] overflow-auto border-t border-slate-800 bg-[#050a14] p-3 font-mono text-[12px] leading-relaxed whitespace-pre text-slate-300">{text}</pre>}
      </div>
    );
  };

  const tabBtn = (k: Tab, label: string, extra?: React.ReactNode) => (
    <button key={k} onClick={() => setTab(k)} className={`rounded-lg px-3 py-2 text-sm font-bold whitespace-nowrap ${tab === k ? "bg-cyan-400 text-slate-900" : "bg-slate-800 text-slate-200 hover:bg-slate-700"}`}>
      {label} {extra}
    </button>
  );

  return (
    <div className="flex h-screen min-h-0 flex-col bg-[#050a14] text-slate-200">
      <header className="flex flex-wrap items-center gap-2 border-b border-slate-800 bg-[#0b1220] px-4 py-3">
        <button onClick={() => (window.location.hash = "")} className="rounded-lg bg-cyan-400 px-3 py-2 text-sm font-bold text-slate-900 hover:bg-cyan-300">
          ← 返回 3D 模拟器
        </button>
        <h1 className="text-base font-bold text-cyan-300">📋 复制代码界面 · 同步到 GitHub / PlatformIO</h1>
        <div className="ml-auto flex flex-wrap items-center gap-2 text-xs text-slate-400">
          <a href={REPO_URL} target="_blank" rel="noreferrer" className="rounded-lg border border-slate-700 px-3 py-2 font-bold text-slate-200 hover:bg-slate-800">
            打开仓库 {GITHUB_REPO}
          </a>
          <button onClick={check} disabled={checking} className="rounded-lg bg-slate-800 px-3 py-2 font-bold text-slate-100 hover:bg-slate-700 disabled:opacity-50">
            {checking ? "检测中…" : "🔄 立即检测"}
          </button>
          <span>上次检测 {checkedAt || "—"}</span>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl space-y-4 p-4">
          <section className="rounded-2xl border border-slate-800 bg-[#0b1322] p-4">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="rounded-full bg-emerald-500/15 px-3 py-1 font-bold text-emerald-300">✅ 已同步 {counts.synced}</span>
              <span className="rounded-full bg-orange-500/15 px-3 py-1 font-bold text-orange-300">⚠️ 需更新 {counts.modified}</span>
              <span className="rounded-full bg-rose-500/15 px-3 py-1 font-bold text-rose-300">🆕 需新建 {counts.missing}</span>
              {counts.unknown > 0 && <span className="rounded-full bg-slate-500/15 px-3 py-1 text-slate-300">… 未知 {counts.unknown}</span>}
              {obsolete.length > 0 && <span className="rounded-full bg-purple-500/15 px-3 py-1 font-bold text-purple-300">🗑 GitHub 上多余 {obsolete.length}</span>}
            </div>
            {err && <div className="mt-2 text-xs text-amber-300">{err}</div>}
            {pending.length > 0 ? (
              <div className="mt-3 rounded-xl border border-orange-500/40 bg-orange-950/20 p-3">
                <div className="mb-2 text-sm font-bold text-orange-300">⚠️ 这 {pending.length} 个文件还没更新到 GitHub（点文件名跳到 GitHub 编辑）：</div>
                <div className="flex flex-wrap gap-2">
                  {pending.map((f) => (
                    <a key={f.path} href={editUrl(f.path, statusOf(f.path) !== "missing")} target="_blank" rel="noreferrer" className="rounded-md bg-slate-900 px-2 py-1 font-mono text-[11px] text-orange-200 hover:bg-slate-800">
                      {statusOf(f.path) === "missing" ? "🆕" : "✏️"} {f.path}
                    </a>
                  ))}
                </div>
              </div>
            ) : counts.unknown === 0 && files.length > 0 ? (
              <div className="mt-3 rounded-xl border border-emerald-500/40 bg-emerald-950/20 p-3 text-sm font-bold text-emerald-300">🎉 所有文件都已和 GitHub 一致。</div>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-2">
              <button className="rounded-lg bg-cyan-400 px-3 py-2 text-sm font-bold text-slate-900 hover:bg-cyan-300" onClick={() => downloadZip("yuyinkelong-all.zip", files.map((f) => ({ path: f.path, content: f.content }))).then(() => say("已开始下载 yuyinkelong-all.zip"))}>
                ⬇️ 下载全部代码 ZIP
              </button>
              <button className="rounded-lg bg-slate-800 px-3 py-2 text-sm font-bold text-slate-100 hover:bg-slate-700" onClick={() => downloadZip("platformio-esp32-1.zip", files.filter((f) => f.group === "esp32-1").map((f) => ({ path: f.path.replace("firmware/esp32-1/", ""), content: applyWifi(f) }))).then(() => say("已开始下载 ESP32-1 工程"))}>
                ⬇️ ESP32-1 PlatformIO 工程 ZIP
              </button>
              <button className="rounded-lg bg-slate-800 px-3 py-2 text-sm font-bold text-slate-100 hover:bg-slate-700" onClick={() => downloadZip("platformio-esp32-2.zip", files.filter((f) => f.group === "esp32-2").map((f) => ({ path: f.path.replace("firmware/esp32-2/", ""), content: applyWifi(f) }))).then(() => say("已开始下载 ESP32-2 工程"))}>
                ⬇️ ESP32-2 PlatformIO 工程 ZIP
              </button>
            </div>
          </section>

          <div className="flex flex-wrap gap-2">
            {tabBtn("github", "📁 GitHub 代码文件", <span className="opacity-70">({files.length})</span>)}
            {tabBtn("esp32-1", "🔵 PlatformIO · ESP32-1")}
            {tabBtn("esp32-2", "🟣 PlatformIO · ESP32-2")}
            {tabBtn("clean", "🗑 GitHub 上多余的旧文件", <span className="opacity-70">({obsolete.length})</span>)}
          </div>

          {isPio && (
            <section className="rounded-2xl border border-cyan-500/30 bg-cyan-950/10 p-4 text-sm">
              <div className="mb-2 font-bold text-cyan-300">{tab === "esp32-1" ? "ESP32-1（NODE_ID = 1，主节点：发起 13 信道扫频）" : "ESP32-2（NODE_ID = 2，从节点：跟随扫频）"} · 烧录步骤</div>
              <ol className="list-decimal space-y-1 pl-5 text-slate-300">
                <li>VS Code → PlatformIO → 新建一个空工程文件夹（板子随便选，下面的 platformio.ini 会覆盖）。</li>
                <li>
                  下面 4 个文件逐个「复制此文件」，粘贴覆盖到工程里对应路径（也可点上面的 <b>ZIP</b> 一次性下载整个工程）。
                </li>
                <li>在下面填好 2.4GHz WiFi，复制出来的 config.h 会自动带上（只保存在你自己的浏览器里）。</li>
                <li>环境选 n16r8 → Upload。成功后串口应显示「[PING] 开始 ping 网关」。</li>
              </ol>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <label className="text-xs text-slate-400">
                  WiFi 名称（2.4GHz）
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
                    className="mt-1 w-full rounded-lg border border-slate-700 bg-[#0f1a2c] px-3 py-2 text-sm text-slate-100 outline-none"
                    placeholder="YOUR_WIFI_NAME"
                  />
                </label>
                <label className="text-xs text-slate-400">
                  WiFi 密码
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
                    className="mt-1 w-full rounded-lg border border-slate-700 bg-[#0f1a2c] px-3 py-2 text-sm text-slate-100 outline-none"
                    placeholder="YOUR_WIFI_PASSWORD"
                  />
                </label>
              </div>
            </section>
          )}

          {tab === "github" && (
            <>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="🔍 搜索文件路径…" className="w-full rounded-lg border border-slate-700 bg-[#0f1a2c] px-3 py-2 text-sm outline-none" />
              <div className="rounded-xl border border-slate-800 bg-[#0a1322] p-3 text-xs leading-relaxed text-slate-400">
                提示：GitHub 编辑页没有「上传」按钮时，可用「⚡ 复制并去 GitHub」→ 在编辑框 Ctrl+A、Ctrl+V → 右上角 Commit changes。新文件会自动打开「新建文件」页并带好路径。上方也可以一次性下载整个仓库 ZIP，解压后用 GitHub Desktop / 网页「Upload files」整体上传。
              </div>
            </>
          )}

          {tab !== "clean" && <div className="space-y-2">{list.map(renderCard)}</div>}

          {tab === "clean" && (
            <section className="space-y-2">
              <div className="rounded-xl border border-purple-500/30 bg-purple-950/10 p-3 text-sm text-slate-300">
                下面这些文件在 GitHub 上存在，但已不属于本项目（例如旧的 Next.js 版本文件 / 旧 Kaggle 方案）。需要的话逐个点「🗑 在 GitHub 删除」。<b>不删也不影响运行</b>，只是仓库会比较乱。
              </div>
              {obsolete.length === 0 && <div className="text-sm text-emerald-300">没有多余文件 ✅</div>}
              {obsolete.map((p) => (
                <div key={p} className="flex items-center justify-between gap-2 rounded-xl border border-slate-800 bg-[#0a1322] p-3">
                  <span className="font-mono text-sm break-all text-purple-200">{p}</span>
                  <a href={`${REPO_URL}/delete/${GITHUB_BRANCH}/${p}`} target="_blank" rel="noreferrer" className="rounded-lg bg-rose-500 px-3 py-1.5 text-xs font-bold text-white hover:bg-rose-400">
                    🗑 在 GitHub 删除
                  </a>
                </div>
              ))}
            </section>
          )}
        </div>
      </div>
      {toast && <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-emerald-500 px-5 py-2 text-sm font-bold text-slate-950 shadow-xl">{toast}</div>}
    </div>
  );
}
