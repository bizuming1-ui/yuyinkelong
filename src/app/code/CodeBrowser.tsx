"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

const REPO = "bizuming1-ui/yuyinkelong";
const BRANCH = "main";

type FileRec = { path: string; content: string; lines: number };
type Bundle = { files: FileRec[]; kaggle: string; pio: string[] };
type Sync = "checking" | "same" | "diff" | "new" | "unknown";
type Tab = "github" | "kaggle" | "pio";

const norm = (s: string) => s.replace(/\r\n/g, "\n").trimEnd();

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

function githubUrl(path: string, status: Sync) {
  if (status === "new") return `https://github.com/${REPO}/new/${BRANCH}?filename=${encodeURIComponent(path).replace(/%2F/g, "/")}`;
  return `https://github.com/${REPO}/edit/${BRANCH}/${path}`;
}

function FileCard(props: {
  file: FileRec;
  content?: string;
  status?: Sync;
  onToast: (m: string) => void;
  defaultOpen?: boolean;
  big?: boolean;
}) {
  const { file, status = "unknown", onToast } = props;
  const content = props.content ?? file.content;
  const [open, setOpen] = useState(!!props.defaultOpen);
  const [done, setDone] = useState(false);

  const doCopy = async () => {
    const ok = await copyText(content);
    setDone(ok);
    onToast(ok ? `已复制：${file.path}（${content.split("\n").length} 行）` : "复制失败，请展开代码后手动全选复制");
    setTimeout(() => setDone(false), 1600);
  };
  const doEdit = async () => {
    const ok = await copyText(content);
    onToast(ok ? `已复制 ${file.path}，在 GitHub 页面全选后粘贴(Ctrl+V)，再点 Commit changes` : "请手动复制代码后粘贴到 GitHub");
    window.open(githubUrl(file.path, status), "_blank", "noopener");
  };

  const badge =
    status === "same"
      ? ["已同步", "bg-emerald-500/15 text-emerald-300"]
      : status === "diff"
        ? ["需更新", "bg-amber-500/15 text-amber-300"]
        : status === "new"
          ? ["新文件", "bg-sky-500/15 text-sky-300"]
          : status === "checking"
            ? ["对比中…", "bg-slate-500/15 text-slate-400"]
            : null;

  return (
    <div className="rounded-xl border border-slate-700/70 bg-[#111a24]">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        <button onClick={() => setOpen((v) => !v)} className="text-left font-mono text-sm text-cyan-200 hover:underline">
          {open ? "▾" : "▸"} {file.path}
        </button>
        <span className="text-xs text-slate-500">
          {content.split("\n").length} 行 · {(content.length / 1024).toFixed(1)} KB
        </span>
        {badge && <span className={`rounded-full px-2 py-0.5 text-[11px] ${badge[1]}`}>{badge[0]}</span>}
        <div className="ml-auto flex gap-2">
          <button onClick={doEdit} className="rounded-lg border border-slate-600 bg-[#0b1118] px-3 py-1 text-xs hover:bg-slate-700">
            ✏️ 在 GitHub 编辑
          </button>
          <button onClick={doCopy} className="rounded-lg bg-emerald-400 px-3 py-1 text-xs font-bold text-[#02140d] hover:brightness-110">
            {done ? "✓ 已复制" : "📋 复制此文件"}
          </button>
        </div>
      </div>
      {open && (
        <pre className={`overflow-auto border-t border-slate-700/70 bg-black/60 p-3 font-mono text-[11.5px] leading-[1.45] text-slate-300 ${props.big ? "max-h-[70vh]" : "max-h-96"}`}>
          {content}
        </pre>
      )}
    </div>
  );
}

export default function CodeBrowser() {
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState<Tab>("github");
  const [toast, setToast] = useState("");
  const [sync, setSync] = useState<Record<string, Sync>>({});
  const [cfg, setCfg] = useState({ ssid: "", pass: "", url: "", key: "radar-key" });

  const showToast = useCallback((m: string) => {
    setToast(m);
    setTimeout(() => setToast(""), 4200);
  }, []);

  useEffect(() => {
    fetch("/api/bundle", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: Bundle) => setBundle(j))
      .catch((e) => setErr(String(e)));
  }, []);

  // 与 GitHub 仓库逐文件对比
  useEffect(() => {
    if (!bundle) return;
    let dead = false;
    const init: Record<string, Sync> = {};
    bundle.files.forEach((f) => (init[f.path] = "checking"));
    setSync(init);
    const queue = [...bundle.files];
    const worker = async () => {
      while (queue.length && !dead) {
        const f = queue.shift()!;
        let st: Sync = "unknown";
        try {
          const r = await fetch(`https://raw.githubusercontent.com/${REPO}/${BRANCH}/${f.path}`, { cache: "no-store" });
          if (r.status === 404) st = "new";
          else if (r.ok) st = norm(await r.text()) === norm(f.content) ? "same" : "diff";
        } catch {
          st = "unknown";
        }
        if (!dead) setSync((p) => ({ ...p, [f.path]: st }));
      }
    };
    Promise.all([worker(), worker(), worker(), worker()]);
    return () => {
      dead = true;
    };
  }, [bundle]);

  const kaggle = bundle?.files.find((f) => f.path === bundle.kaggle);
  const pioFiles = useMemo(() => (bundle ? bundle.pio.map((p) => bundle.files.find((f) => f.path === p)!).filter(Boolean) : []), [bundle]);

  const pioContent = (f: FileRec) => {
    if (!f.path.endsWith("config.h")) return f.content;
    let c = f.content;
    const set = (name: string, v: string) => {
      if (!v) return;
      c = c.replace(new RegExp(`(#define\\s+${name}\\s+)"[^"]*"`), (_m, a: string) => `${a}"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
    };
    set("WIFI_SSID", cfg.ssid);
    set("WIFI_PASS", cfg.pass);
    set("SERVER_URL", cfg.url.replace(/\/+$/, ""));
    set("API_KEY", cfg.key);
    return c;
  };

  const pending = Object.values(sync).filter((s) => s === "diff" || s === "new").length;

  const copyAllPio = async () => {
    const txt = pioFiles.map((f) => `// ===== ${f.path} =====\n${pioContent(f)}`).join("\n\n");
    showToast((await copyText(txt)) ? "已复制 PlatformIO 全部 3 个文件（带文件名分隔）" : "复制失败");
  };

  return (
    <div className="min-h-screen bg-[#0b1118] text-slate-200">
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-slate-700/60 bg-[#101822]/95 px-4 py-3 backdrop-blur">
        <Link href="/" className="rounded-lg border border-slate-600 px-3 py-1 text-sm hover:bg-slate-700">
          ← 返回浏览器模拟器
        </Link>
        <h1 className="text-lg font-bold">
          📋 复制代码界面 <span className="text-sm font-normal text-slate-400">· ESP32-S3 WiFi 雷达</span>
        </h1>
        <nav className="ml-auto flex gap-2">
          {(
            [
              ["github", "① GitHub 代码"],
              ["kaggle", "② Kaggle 单文件"],
              ["pio", "③ PlatformIO 代码"],
            ] as [Tab, string][]
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${tab === k ? "bg-emerald-400 text-[#02140d]" : "border border-slate-600 hover:bg-slate-700"}`}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-5xl space-y-3 p-4">
        {err && <div className="rounded-lg bg-red-900/40 p-3 text-red-200">加载失败：{err}</div>}
        {!bundle && !err && <div className="p-6 text-slate-400">正在读取代码文件…</div>}

        {bundle && tab === "github" && (
          <>
            <div className="rounded-xl border border-slate-700/70 bg-[#111a24] p-3 text-sm leading-6 text-slate-300">
              <div>
                目标仓库：
                <a className="text-cyan-300 underline" href={`https://github.com/${REPO}`} target="_blank" rel="noreferrer">
                  github.com/{REPO}
                </a>
                。下面是项目里<b>全部</b>文件（已和仓库逐个对比：
                <span className="text-emerald-300">已同步</span> / <span className="text-amber-300">需更新</span> / <span className="text-sky-300">新文件</span>
                ）。
              </div>
              <div className="text-slate-400">
                用法：点「在 GitHub 编辑」→ 自动复制并打开 GitHub 编辑页 → 全选 (Ctrl+A) → 粘贴 (Ctrl+V) → Commit changes。新文件会打开“新建文件”页，路径已自动填好。
              </div>
              <div className="mt-1">
                {Object.keys(sync).length > 0 && <b className={pending ? "text-amber-300" : "text-emerald-300"}>{pending ? `共 ${pending} 个文件需要更新到 GitHub` : "对比完成：所有文件已与 GitHub 一致（或无法对比）"}</b>}
              </div>
            </div>
            {bundle.files.map((f) => (
              <FileCard key={f.path} file={f} status={sync[f.path]} onToast={showToast} />
            ))}
          </>
        )}

        {bundle && tab === "kaggle" && kaggle && (
          <>
            <div className="rounded-xl border border-emerald-700/50 bg-[#0f1f1a] p-4 text-sm leading-7 text-slate-200">
              <h2 className="mb-1 text-base font-bold text-emerald-300">Kaggle 只需要这 1 个完整代码文件</h2>
              <ol className="list-decimal pl-5">
                <li>Kaggle Notebook → Settings：Accelerator 选 <b>GPU T4 x2</b>，Internet 选 <b>On</b>。</li>
                <li>新建一个 Code Cell，点下面「复制 Kaggle 全部代码」，粘贴进去运行。</li>
                <li>
                  输出里出现 <code className="text-cyan-300">🌐 全屏 3D 网站： https://xxxx.trycloudflare.com</code>（并显示「公网自检通过」）。
                </li>
                <li>用电脑 Chrome / Edge 打开该网址，点 <b>🔌 USB 连接 ESP32</b>（最稳）；或把网址填进 PlatformIO 的 config.h。</li>
              </ol>
              <div className="mt-2 text-xs text-slate-400">
                资源：多 GPU 分片三边定位（T4×2，显存预算每卡 12GiB，可用环境变量 RADAR_VRAM_GB 调整）· GPU 运动检测 · RSSI 历史内存预算 20GiB（RADAR_RAM_GB）· 磁盘历史写入 /kaggle/temp，上限 45GiB（RADAR_DISK_GB）。
              </div>
              <button
                onClick={async () => showToast((await copyText(kaggle.content)) ? `已复制 Kaggle 全部代码（${kaggle.lines} 行）` : "复制失败")}
                className="mt-3 rounded-lg bg-emerald-400 px-5 py-2 text-base font-bold text-[#02140d] hover:brightness-110"
              >
                📋 复制 Kaggle 全部代码
              </button>
            </div>
            <FileCard file={kaggle} status={sync[kaggle.path]} onToast={showToast} big />
          </>
        )}

        {bundle && tab === "pio" && (
          <>
            <div className="rounded-xl border border-cyan-700/50 bg-[#0f1a24] p-4 text-sm leading-7">
              <h2 className="mb-1 text-base font-bold text-cyan-300">PlatformIO（VSCode）代码：3 个文件</h2>
              <ol className="list-decimal pl-5 text-slate-300">
                <li>VSCode → PlatformIO → New Project（任意名字，Board: Espressif ESP32-S3-DevKitC-1，Framework: Arduino），或直接打开仓库的 <code>firmware/</code> 文件夹。</li>
                <li>把下面 3 个文件分别覆盖到 <code>platformio.ini</code>、<code>include/config.h</code>、<code>src/main.cpp</code>。</li>
                <li>点底部 ✔ Build → → Upload，上传完成后按板子上的 <b>RESET</b> 键，开始运行。</li>
              </ol>
              <div className="mt-3 grid gap-2 sm:grid-cols-4">
                {(
                  [
                    ["ssid", "WiFi 名称 (2.4GHz)"],
                    ["pass", "WiFi 密码"],
                    ["url", "Kaggle 网址"],
                    ["key", "API_KEY"],
                  ] as const
                ).map(([k, ph]) => (
                  <input
                    key={k}
                    value={cfg[k]}
                    placeholder={ph}
                    onChange={(e) => setCfg((p) => ({ ...p, [k]: e.target.value }))}
                    className="rounded-lg border border-slate-600 bg-[#0b1118] px-3 py-1.5 text-sm outline-none focus:border-cyan-400"
                  />
                ))}
              </div>
              <div className="mt-1 text-xs text-slate-400">填写后会自动写入下方 config.h 的复制内容。不填也行：直接用网页里的「USB 连接 ESP32」，ESP32 无需联网。</div>
              <button onClick={copyAllPio} className="mt-3 rounded-lg bg-cyan-400 px-4 py-1.5 font-bold text-[#02141d] hover:brightness-110">
                📋 复制全部 3 个文件
              </button>
            </div>
            {pioFiles.map((f) => (
              <FileCard key={f.path} file={f} content={pioContent(f)} status={sync[f.path]} onToast={showToast} defaultOpen />
            ))}
          </>
        )}
      </main>

      {toast && <div className="fixed bottom-6 left-1/2 z-20 -translate-x-1/2 rounded-xl border border-emerald-400/60 bg-[#0d2236] px-4 py-2 text-sm shadow-xl">{toast}</div>}
    </div>
  );
}
