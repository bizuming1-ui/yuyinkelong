// 复制代码界面：每个文件都有「在 GitHub 编辑」+「复制此文件」，并实时检测 GitHub (https://github.com/bizuming1-ui/yuyinkelong) 上是否已是最新。
// 分类：GitHub 全部文件 / PlatformIO · ESP32-1（ESP32-A 发射端）/ ESP32-B（接收端1）/ ESP32-C（接收端2） / Kaggle（粘贴到 Notebook 运行）。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GITHUB_BRANCH, GITHUB_REPO, OLD_FILE_HINTS } from "@/lib/config";
import { gitShaVariants } from "@/lib/sha1";
import { FILES, type CodeFile } from "@/lib/manifest";

type Sync = "unknown" | "synced" | "modified" | "missing";
type Tab = "github" | "esp32-a" | "esp32-b" | "esp32-c" | "kaggle" | "clean";

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
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch {
    window.open(url, "_blank");
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function downloadText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function downloadStandaloneHtml(): Promise<boolean> {
  try {
    let htmlText = "";
    try {
      const res = await fetch("/standalone-simulator.html", { cache: "no-store" });
      if (res.ok) {
        const t = await res.text();
        if (t.includes("<html") && t.length > 50_000) htmlText = t;
      }
    } catch {
      /* ignore */
    }
    if (!htmlText) {
      htmlText = "<!doctype html>\n" + document.documentElement.outerHTML;
    }
    const url = URL.createObjectURL(new Blob([htmlText], { type: "text/html;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "esp32s3-tri-2.5d-simulator.html";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return true;
  } catch {
    return false;
  }
}

const PIO_TABS: Record<string, { title: string; shortLabel: string; dir: string; role: string; node: string }> = {
  "esp32-a": {
    title: "ESP32-1 (ESP32-A) · 发射端 TX",
    shortLabel: "ESP32-1",
    dir: "firmware/esp32-a/",
    role: "NODE_ROLE = ROLE_A (ROLE_1)",
    node: "第 1 块板（ESP32-1 / ESP32-A 探测发射端）：以 100Hz 向 ESP32-B / ESP32-C 广播带序列号的 ESP-NOW(HT MCS0) 探测帧",
  },
  "esp32-b": {
    title: "ESP32-B · 接收端 RX1",
    shortLabel: "ESP32-B",
    dir: "firmware/esp32-b/",
    role: "NODE_ROLE = ROLE_B",
    node: "第 2 块板（ESP32-B 接收端1）：接收 ESP32-1(A) 的探测帧 → 提取 64 子载波 CSI → MQTT + USB 双通道上传",
  },
  "esp32-c": {
    title: "ESP32-C · 接收端 RX2",
    shortLabel: "ESP32-C",
    dir: "firmware/esp32-c/",
    role: "NODE_ROLE = ROLE_C",
    node: "第 3 块板（ESP32-C 接收端2）：接收 ESP32-1(A) 的探测帧 → 提取 64 子载波 CSI → MQTT + USB 双通道上传",
  },
};

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
    timer.current = setTimeout(() => setToast(""), 2400);
  };

  const check = useCallback(async () => {
    setChecking(true);
    setErr("");
    try {
      let tree: { path: string; type: string; sha: string }[] | null = null;
      let lastErr = "";
      try {
        const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/git/trees/${GITHUB_BRANCH}?recursive=1&t=${Date.now()}`, {
          cache: "no-store",
          headers: { Accept: "application/vnd.github+json" },
        });
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
        setErr(`GitHub API 暂不可用（${String(e instanceof Error ? e.message : e)}），已自动切换为 raw 文件内容实时对比`);
      } catch {
        setErr("无法连接 GitHub（网络问题）。请稍后点「立即检测」。");
      }
    } finally {
      setChecking(false);
      setCheckedAt(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
    }
  }, [files]);

  // 进入页面检测 + 每 45 秒 + 每次回到本页（你在 GitHub 提交完切回来时）立刻检测
  useEffect(() => {
    check();
    const id = setInterval(check, 45_000);
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

  const isPio = tab === "esp32-a" || tab === "esp32-b" || tab === "esp32-c";
  const pioOrder = (p: string) => (p.endsWith("platformio.ini") ? 0 : p.endsWith("upload_retry.py") ? 1 : p.endsWith("config.h") ? 2 : 3);
  const siteUrl = typeof window !== "undefined" ? window.location.href.split("#")[0] : "";
  const visible = files.filter((f) => {
    if (tab === "github") return !q || f.path.toLowerCase().includes(q.toLowerCase());
    if (isPio || tab === "kaggle") return f.group === tab;
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
    const text = isPio || tab === "kaggle" ? applyWifi(f) : f.content;
    const isOpen = !!open[f.path];
    const exists = s !== "missing";
    const pioBoardTag = isPio ? PIO_TABS[tab]?.shortLabel : null;
    return (
      <div key={f.path} className="rounded-xl border border-slate-800 bg-[#0a1322]">
        <div className="flex flex-wrap items-center gap-2 p-3">
          <button className="min-w-0 flex-1 text-left" onClick={() => setOpen({ ...open, [f.path]: !isOpen })}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-slate-500">{isOpen ? "▼" : "▶"}</span>
              {pioBoardTag && (
                <span className="rounded bg-cyan-500/20 border border-cyan-400/40 px-2 py-0.5 text-xs font-extrabold text-cyan-200">
                  {pioBoardTag}
                </span>
              )}
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
          <button
            className="rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs font-semibold text-slate-300 hover:bg-slate-800"
            onClick={() => downloadText(f.path.split("/").pop() || "file.txt", text)}
          >
            ⬇️ 下载
          </button>
        </div>
        {isOpen && <pre className="max-h-[440px] overflow-auto border-t border-slate-800 bg-[#050a14] p-3 font-mono text-[12px] leading-relaxed whitespace-pre text-slate-300 select-text">{text}</pre>}
      </div>
    );
  };

  const tabBtn = (k: Tab, label: string, extra?: React.ReactNode) => (
    <button key={k} onClick={() => setTab(k)} className={`rounded-lg px-3 py-2 text-sm font-bold whitespace-nowrap transition ${tab === k ? "bg-cyan-400 text-slate-900 shadow" : "bg-slate-800 text-slate-200 hover:bg-slate-700"}`}>
      {label} {extra}
    </button>
  );

  return (
    <div className="flex h-screen min-h-0 flex-col bg-[#050a14] text-slate-200">
      <header className="flex flex-wrap items-center gap-2 border-b border-slate-800 bg-[#0b1220] px-4 py-3">
        <button onClick={() => (window.location.hash = "")} className="rounded-lg bg-cyan-400 px-3 py-2 text-sm font-bold text-slate-900 hover:bg-cyan-300">
          ← 返回 2.5D 浏览器模拟器
        </button>
        <h1 className="text-base font-bold text-cyan-300">
          📋 复制代码界面 · 实时检测同步到 GitHub ({GITHUB_REPO}) / PlatformIO (ESP32-1 · ESP32-B · ESP32-C) / Kaggle
        </h1>
        <div className="ml-auto flex flex-wrap items-center gap-2 text-xs text-slate-400">
          <a href={REPO_URL} target="_blank" rel="noreferrer" className="rounded-lg border border-slate-700 px-3 py-2 font-bold text-slate-200 hover:bg-slate-800">
            打开仓库 {GITHUB_REPO}
          </a>
          <button onClick={check} disabled={checking} className="rounded-lg bg-emerald-500 px-3 py-2 font-bold text-slate-950 hover:bg-emerald-400 disabled:opacity-50">
            {checking ? "正在比对 GitHub…" : "🔄 立即检测 GitHub 同步状态"}
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
              {counts.unknown > 0 && <span className="rounded-full bg-slate-500/15 px-3 py-1 text-slate-300">… 检测中 {counts.unknown}</span>}
              {obsolete.length > 0 && <span className="rounded-full bg-purple-500/15 px-3 py-1 font-bold text-purple-300">🗑 GitHub 上多余 {obsolete.length}</span>}
            </div>
            {err && <div className="mt-2 text-xs text-amber-300">{err}</div>}
            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-cyan-500/30 bg-cyan-950/10 p-3 text-xs">
              <span className="font-bold text-cyan-300">🌐 本浏览器模拟器网址（可直接复制在浏览器打开）</span>
              <code className="min-w-0 flex-1 break-all rounded bg-slate-900 px-2 py-1 text-cyan-100 select-all">{siteUrl}</code>
              <button className="rounded-lg bg-cyan-400 px-3 py-1.5 font-bold text-slate-900 hover:bg-cyan-300" onClick={async () => say((await copyText(siteUrl)) ? "已复制网址" : "复制失败")}>
                复制网址
              </button>
              <a className="rounded-lg border border-slate-600 bg-slate-800 px-3 py-1.5 font-bold text-slate-100 hover:bg-slate-700" href={siteUrl} target="_blank" rel="noreferrer">
                新标签页打开
              </a>
            </div>
            {pending.length > 0 ? (
              <div className="mt-3 rounded-xl border border-orange-500/40 bg-orange-950/20 p-3">
                <div className="mb-2 text-sm font-bold text-orange-300">
                  ⚠️ 实时防漏更提醒：以下 {pending.length} 个文件还未同步到 GitHub（点击即可直接跳到 GitHub 编辑，或点击下方卡片「⚡ 复制并去 GitHub」）：
                </div>
                <div className="flex flex-wrap gap-2">
                  {pending.map((f) => (
                    <a key={f.path} href={editUrl(f.path, statusOf(f.path) !== "missing")} target="_blank" rel="noreferrer" className="rounded-md bg-slate-900 px-2 py-1 font-mono text-[11px] text-orange-200 hover:bg-slate-800">
                      {statusOf(f.path) === "missing" ? "🆕" : "✏️"} {f.path}
                    </a>
                  ))}
                </div>
              </div>
            ) : counts.unknown === 0 && files.length > 0 ? (
              <div className="mt-3 rounded-xl border border-emerald-500/40 bg-emerald-950/20 p-3 text-sm font-bold text-emerald-300">
                🎉 所有文件都已和 GitHub ({GITHUB_REPO}) 100% 同步一致！现在可以直接去 Kaggle 运行 `kaggle/kaggle_cell.py` 了。
              </div>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                className="rounded-lg bg-amber-400 px-3 py-2 text-sm font-bold text-slate-950 hover:bg-amber-300"
                onClick={() => downloadStandaloneHtml().then((ok) => say(ok ? "已开始下载独立单文件模拟器 HTML" : "下载失败"))}
              >
                ⬇️ 下载独立版浏览器模拟器 (.html 直接打开)
              </button>
              <button
                className="rounded-lg bg-cyan-400 px-3 py-2 text-sm font-bold text-slate-900 hover:bg-cyan-300"
                onClick={() => downloadZip("yuyinkelong-all.zip", files.map((f) => ({ path: f.path, content: f.content }))).then(() => say("已开始下载 yuyinkelong-all.zip"))}
              >
                ⬇️ 下载全部 GitHub 代码 ZIP
              </button>
              {(["esp32-a", "esp32-b", "esp32-c"] as const).map((k) => (
                <button
                  key={k}
                  className="rounded-lg bg-slate-800 px-3 py-2 text-sm font-bold text-slate-100 hover:bg-slate-700 border border-slate-700"
                  onClick={() =>
                    downloadZip(
                      `platformio-${PIO_TABS[k].shortLabel.toLowerCase()}.zip`,
                      files.filter((f) => f.group === k).map((f) => ({ path: f.path.replace(PIO_TABS[k].dir, ""), content: applyWifi(f) })),
                    ).then(() => say(`已开始下载 ${PIO_TABS[k].shortLabel} PlatformIO 工程`))
                  }
                >
                  ⬇️ {PIO_TABS[k].shortLabel} PlatformIO 工程 ZIP
                </button>
              ))}
              <button
                className="rounded-lg bg-slate-800 px-3 py-2 text-sm font-bold text-slate-100 hover:bg-slate-700 border border-slate-700"
                onClick={() => files.filter((f) => f.group === "kaggle").forEach((f) => downloadText(f.path.split("/").pop() || "kaggle_cell.py", f.content))}
              >
                ⬇️ 下载 Kaggle 代码 (kaggle_cell.py)
              </button>
            </div>
          </section>

          <div className="flex flex-wrap gap-2">
            {tabBtn("github", "📁 GitHub 全部代码文件", <span className="opacity-70">({files.length})</span>)}
            {tabBtn("esp32-a", "🔵 PlatformIO · ESP32-1 (ESP32-A 发射端)")}
            {tabBtn("esp32-b", "🟢 PlatformIO · ESP32-B (接收端1)")}
            {tabBtn("esp32-c", "🟢 PlatformIO · ESP32-C (接收端2)")}
            {tabBtn("kaggle", "🟠 Kaggle 零崩溃运行代码")}
            {tabBtn("clean", "🗑 GitHub 上多余的旧文件", <span className="opacity-70">({obsolete.length})</span>)}
          </div>

          {isPio && (
            <section className="rounded-2xl border border-cyan-500/30 bg-cyan-950/10 p-4 text-sm">
              <div className="mb-2 flex flex-wrap items-center gap-2 font-bold text-cyan-300">
                <span className="rounded-md bg-cyan-400 px-2.5 py-0.5 text-slate-950 font-extrabold">
                  当前烧录目标：{PIO_TABS[tab]?.shortLabel}
                </span>
                <span>{PIO_TABS[tab]?.title}（{PIO_TABS[tab]?.role}）</span>
              </div>
              <p className="mb-2 text-xs text-slate-300">{PIO_TABS[tab]?.node}</p>
              <ol className="list-decimal space-y-1 pl-5 text-xs text-slate-300">
                <li>VS Code → PlatformIO → 为 <b>{PIO_TABS[tab]?.shortLabel}</b> 新建或打开对应的空工程文件夹。</li>
                <li>
                  将下方专属于 <b>{PIO_TABS[tab]?.shortLabel}</b> 的 4 个文件（<code>platformio.ini</code> / <code>upload_retry.py</code> / <code>include/config.h</code> / <code>src/main.cpp</code>）逐个点击「📋 复制此文件」覆盖对应文件，或直接点上方「⬇️ {PIO_TABS[tab]?.shortLabel} PlatformIO 工程 ZIP」。
                </li>
                <li>在下方填入你的 2.4GHz WiFi 名称与密码，复制出来的 <code>config.h</code> 会自动填入 WiFi 信息。</li>
                <li>PlatformIO 环境选择 <code>n16r8</code> → 点击 Upload 烧录（内置 <code>upload_retry.py</code> 自动防掉线降速重试）。</li>
              </ol>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <label className="text-xs text-slate-400">
                  WiFi 名称（2.4GHz，三块板必须相同）
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

          {tab === "kaggle" && (
            <section className="rounded-2xl border border-amber-500/30 bg-amber-950/10 p-4 text-sm">
              <div className="mb-2 font-bold text-amber-300">🟠 Kaggle（GPU T4×2）v6.0 零崩溃运行步骤（已彻底修复 Draft Session Fatal 弹窗）</div>
              <ol className="list-decimal space-y-1 pl-5 text-xs text-slate-300">
                <li>先在「📁 GitHub 全部代码文件」标签页确认所有修改的文件已更新到 <code>https://github.com/{GITHUB_REPO}</code>。</li>
                <li>打开 Kaggle → New Notebook → 右侧 Settings：Accelerator 选 <b>GPU T4 × 2</b>，<b>Internet 打开 (On)</b>。</li>
                <li>点击下方 <code>kaggle/kaggle_cell.py</code> 的「📋 复制此文件」，粘贴进 Kaggle Notebook 的<b>第一个代码单元</b>并点击 Run。</li>
                <li>
                  运行后，Kaggle 输出框会直接显示一个可视化的<b>「🚀 点击在新标签页打开 3D/2.5D 浏览器模拟器」</b>大按钮与 <code>https://xxxx.trycloudflare.com</code> 网址，且彻底消除了后台线程并发写 ZMQ 与 <code>/kaggle/working</code> 小文件风暴导致的 <i>Oops something went wrong</i> 崩溃。
                </li>
              </ol>
            </section>
          )}

          {tab === "github" && (
            <>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="🔍 搜索文件路径（如 TriApp.tsx / kaggle_cell.py / main.cpp）…" className="w-full rounded-lg border border-slate-700 bg-[#0f1a2c] px-3 py-2 text-sm outline-none" />
              <div className="rounded-xl border border-slate-800 bg-[#0a1322] p-3 text-xs leading-relaxed text-slate-400">
                每个文件都提供 <b>「✏️ 在 GitHub 编辑」</b> 和 <b>「📋 复制此文件」</b> 两个按键（也可直接点「⚡ 复制并去 GitHub」一键完成复制并打开对应 GitHub 编辑页）。你在 GitHub 提交保存后切回本页面，系统会自动重新检测并变为「✅ GitHub 已是最新」。
              </div>
            </>
          )}

          {tab !== "clean" && <div className="space-y-2">{list.map(renderCard)}</div>}

          {tab === "clean" && (
            <section className="space-y-2">
              <div className="rounded-xl border border-purple-500/30 bg-purple-950/10 p-3 text-sm text-slate-300">
                下面这些文件在 GitHub 上存在，但已不属于本项目。需要的话可逐个点「🗑 在 GitHub 删除」。
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
