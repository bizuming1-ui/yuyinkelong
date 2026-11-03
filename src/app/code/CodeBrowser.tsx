"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type BFile = { path: string; content: string; lines: number };
type Bundle = { files: BFile[]; kaggle: string; pio: string[] };
type Status = "checking" | "synced" | "update" | "new" | "error";
type Tab = "github" | "kaggle" | "pio";
type Cfg = { ssid: string; pass: string; url: string; key: string };

const DEFAULT_REPO = "bizuming1-ui/yuyinkelong";
const BRANCH = "main";
const norm = (s: string) => s.replace(/\r\n/g, "\n").replace(/\s+$/, "");
const q = (s: string) => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';

// 把用户填写的 WiFi / 网址 / 密钥写入 config.h 和 Kaggle 脚本（GitHub 版本保持原样，不含任何密码）
function applyCfg(p: string, content: string, cfg: Cfg): string {
  let c = content;
  if (p.endsWith("config.h")) {
    const set = (name: string, val: string) => {
      if (!val) return;
      c = c.replace(new RegExp("^(#define\\s+" + name + "\\s+)\".*\"", "m"), (_m, pre: string) => pre + q(val));
    };
    set("WIFI_SSID", cfg.ssid);
    set("WIFI_PASS", cfg.pass);
    set("SERVER_URL", cfg.url.replace(/\/+$/, ""));
    set("API_KEY", cfg.key);
  } else if (p.endsWith("wifi_radar_kaggle.py") && cfg.key) {
    c = c.replace('API_KEY = "radar-key"', () => "API_KEY = " + q(cfg.key));
  }
  return c;
}

async function copyText(t: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(t);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = t;
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

const BADGE: Record<Status, { t: string; c: string }> = {
  checking: { t: "检测中", c: "bg-slate-700/60 text-slate-300" },
  synced: { t: "已同步", c: "bg-emerald-500/20 text-emerald-300" },
  update: { t: "需更新", c: "bg-amber-500/25 text-amber-300" },
  new: { t: "新增", c: "bg-sky-500/25 text-sky-300" },
  error: { t: "对比失败", c: "bg-rose-500/25 text-rose-300" },
};

export default function CodeBrowser() {
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState<Tab>("github");
  const [repo, setRepo] = useState(DEFAULT_REPO);
  const [status, setStatus] = useState<Record<string, Status>>({});
  const [comparing, setComparing] = useState(false);
  const [onlyUpdate, setOnlyUpdate] = useState(false);
  const [sel, setSel] = useState<Record<Tab, string>>({ github: "", kaggle: "", pio: "" });
  const [cfg, setCfg] = useState<Cfg>({ ssid: "", pass: "", url: "", key: "radar-key" });
  const [toast, setToast] = useState("");
  const runId = useRef(0);

  useEffect(() => {
    try {
      const r = localStorage.getItem("wradar.repo");
      if (r) setRepo(r);
      const c = localStorage.getItem("wradar.cfg");
      if (c) setCfg((p) => ({ ...p, ...JSON.parse(c) }));
    } catch {
      /* ignore */
    }
    fetch("/api/bundle", { cache: "no-store" })
      .then((r) => r.json())
      .then((b: Bundle) => {
        setBundle(b);
        setSel({ github: b.files[0]?.path ?? "", kaggle: b.kaggle, pio: b.pio[0] ?? "" });
      })
      .catch((e) => setErr(String(e)));
  }, []);

  const say = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(""), 2200);
  };
  const saveCfg = (n: Cfg) => {
    setCfg(n);
    localStorage.setItem("wradar.cfg", JSON.stringify(n));
  };

  const compare = useCallback(async () => {
    if (!bundle) return;
    const id = ++runId.current;
    setComparing(true);
    setStatus(Object.fromEntries(bundle.files.map((f) => [f.path, "checking" as Status])));
    const queue = [...bundle.files];
    const worker = async () => {
      for (;;) {
        const f = queue.shift();
        if (!f || id !== runId.current) return;
        let s: Status;
        try {
          const r = await fetch(`https://raw.githubusercontent.com/${repo}/${BRANCH}/${f.path}?_=${Date.now()}`, { cache: "no-store" });
          if (r.status === 404) s = "new";
          else if (!r.ok) s = "error";
          else s = norm(await r.text()) === norm(f.content) ? "synced" : "update";
        } catch {
          s = "error";
        }
        if (id === runId.current) setStatus((p) => ({ ...p, [f.path]: s }));
      }
    };
    await Promise.all([worker(), worker(), worker(), worker(), worker()]);
    if (id === runId.current) setComparing(false);
  }, [bundle, repo]);

  useEffect(() => {
    if (bundle) compare();
  }, [bundle, compare]);

  const list = useMemo(() => {
    if (!bundle) return [];
    if (tab === "kaggle") return bundle.files.filter((f) => f.path === bundle.kaggle).map((f) => ({ ...f, name: f.path }));
    if (tab === "pio") return bundle.files.filter((f) => bundle.pio.includes(f.path)).map((f) => ({ ...f, name: f.path.replace(/^firmware\//, "") }));
    return bundle.files
      .filter((f) => !onlyUpdate || status[f.path] === "update" || status[f.path] === "new")
      .map((f) => ({ ...f, name: f.path }));
  }, [bundle, tab, onlyUpdate, status]);

  const cur = list.find((f) => f.path === sel[tab]) ?? list[0];
  const display = cur ? (tab === "github" ? cur.content : applyCfg(cur.path, cur.content, cfg)) : "";
  const need = bundle ? bundle.files.filter((f) => status[f.path] === "update" || status[f.path] === "new").length : 0;
  const counts = bundle ? { github: bundle.files.length, kaggle: 1, pio: bundle.pio.length } : { github: 0, kaggle: 1, pio: 0 };

  const copyAll = async () => {
    if (!bundle) return;
    let text: string;
    if (tab === "kaggle") text = display;
    else text = list.map((f) => `# ===== ${f.name} =====\n${tab === "github" ? f.content : applyCfg(f.path, f.content, cfg)}`).join("\n\n");
    say((await copyText(text)) ? (tab === "kaggle" ? "已复制 Kaggle 完整代码文件 ✓" : `已复制本类 ${list.length} 个文件 ✓`) : "复制失败，请手动选中复制");
  };

  const editOnGithub = async () => {
    if (!cur) return;
    const ok = await copyText(cur.content); // GitHub 上保存的始终是原始版本(不含你的密码)
    const exists = status[cur.path] === "update" || status[cur.path] === "synced";
    const url = exists
      ? `https://github.com/${repo}/edit/${BRANCH}/${cur.path}`
      : `https://github.com/${repo}/new/${BRANCH}?filename=${encodeURIComponent(cur.path)}`;
    const w = window.open(url, "_blank");
    say(ok ? `已复制 ${cur.path} 的全部内容，并打开 GitHub 编辑页` : "复制失败，请点“复制此文件”");
    if (!w) say("浏览器拦截了新窗口，请允许弹窗后重试");
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[#050b14] text-slate-100">
      <div className="flex items-end gap-3 border-b border-slate-800 bg-[#070d17] px-4 pt-3">
        {(
          [
            ["github", "① 更新到 GitHub 的代码"],
            ["kaggle", "② 复制到 Kaggle 的代码"],
            ["pio", "③ 复制到 PlatformIO 的代码"],
          ] as [Tab, string][]
        ).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`rounded-t-xl px-6 py-3 text-base font-bold ${tab === k ? "bg-[#0d1626] text-white" : "text-slate-400 hover:text-white"}`}
          >
            {label}({counts[k]})
          </button>
        ))}
        <div className="ml-auto pb-2">
          <Link href="/" className="rounded-lg border border-slate-600 px-4 py-2 text-sm hover:border-emerald-400">
            ← 返回浏览器模拟器
          </Link>
        </div>
      </div>

      <div className="space-y-1.5 border-b border-slate-800 px-5 py-3 text-sm text-slate-300">
        {tab === "github" && (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-semibold">GitHub 仓库:</span>
              <input
                value={repo}
                onChange={(e) => {
                  setRepo(e.target.value.trim());
                  localStorage.setItem("wradar.repo", e.target.value.trim());
                }}
                className="w-72 rounded-md border border-slate-600 bg-[#0a1220] px-3 py-1.5 font-mono text-sm outline-none focus:border-emerald-400"
              />
              <button onClick={compare} className="rounded-md border border-slate-600 px-3 py-1.5 hover:border-emerald-400">
                {comparing ? "对比中…" : "重新对比 GitHub"}
              </button>
              <label className="flex cursor-pointer items-center gap-1.5">
                <input type="checkbox" checked={onlyUpdate} onChange={(e) => setOnlyUpdate(e.target.checked)} />
                只看需要更新的
              </label>
              <span className="text-amber-300">
                需要更新/新增 {need} 个文件(已自动与你的仓库逐文件对比
                {comparing ? "，进行中…" : ""})
              </span>
            </div>
            <div>
              1. 点右侧「<b className="text-emerald-300">在 GitHub 编辑</b>」：会先自动复制该文件全部内容并打开 GitHub 编辑页(新增文件会打开 Create new file 且文件名已填好)。
            </div>
            <div>
              2. 在 GitHub 页面里全选原内容(Ctrl+A)→ 粘贴(Ctrl+V)→ 点右上角 Commit changes。提交后回来点「重新对比 GitHub」，徽标会变成「已同步」（GitHub 原始文件缓存约 1~5 分钟）。
            </div>
          </>
        )}
        {tab === "kaggle" && (
          <>
            <div>
              1. Kaggle Notebook 右侧 Settings：<b>Accelerator = GPU T4 x2</b>，<b>Internet = On</b>。新建一个 Code Cell，把下面这<b className="text-emerald-300">一个完整文件</b>粘贴进去运行。
            </div>
            <div>
              2. 输出里会出现 <code className="text-cyan-300">https://xxxx.trycloudflare.com</code>：这就是全屏 3D 网站，同时也是 ESP32 要填的 SERVER_URL。Cell 必须保持运行。
            </div>
            <div className="flex items-center gap-3">
              <span>上传密钥 API_KEY:</span>
              <input
                value={cfg.key}
                onChange={(e) => saveCfg({ ...cfg, key: e.target.value })}
                className="w-48 rounded-md border border-slate-600 bg-[#0a1220] px-3 py-1.5 font-mono text-sm outline-none focus:border-emerald-400"
              />
              <span className="text-slate-400">（会写入下方代码，并要与 PlatformIO 页的密钥一致）</span>
            </div>
          </>
        )}
        {tab === "pio" && (
          <>
            <div>
              1. VSCode → PlatformIO → Open Project，选择仓库里的 <b>firmware</b> 文件夹（或自己新建工程，把下面 3 个文件按名称放好）。
            </div>
            <div>
              2. 在下面填入你的 WiFi 和 Kaggle 网址，右侧文件会自动带上；点「复制此文件」覆盖 include/config.h → 点 ✔ Build → → Upload → 按 ESP32 的 <b>RESET</b> 键即运行。
            </div>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              {(
                [
                  ["ssid", "WiFi 名称(2.4GHz)"],
                  ["pass", "WiFi 密码"],
                  ["url", "Kaggle 网址 https://…"],
                  ["key", "API 密钥"],
                ] as [keyof Cfg, string][]
              ).map(([k, ph]) => (
                <input
                  key={k}
                  value={cfg[k]}
                  placeholder={ph}
                  onChange={(e) => saveCfg({ ...cfg, [k]: e.target.value })}
                  className="rounded-md border border-slate-600 bg-[#0a1220] px-3 py-1.5 text-sm outline-none focus:border-emerald-400"
                />
              ))}
            </div>
          </>
        )}
      </div>

      {err && <div className="p-6 text-rose-400">加载代码失败：{err}</div>}
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[360px] min-w-[300px] flex-col gap-3 border-r border-slate-800 p-3">
          <button onClick={copyAll} className="rounded-xl bg-emerald-400 py-4 text-lg font-extrabold text-[#04150e] hover:bg-emerald-300">
            复制本类全部代码
          </button>
          <div className="min-h-0 flex-1 space-y-1.5 overflow-auto pr-1">
            {list.map((f) => {
              const st = status[f.path] ?? "checking";
              const b = BADGE[st];
              return (
                <button
                  key={f.path}
                  onClick={() => setSel((p) => ({ ...p, [tab]: f.path }))}
                  className={`flex w-full items-center justify-between gap-2 rounded-xl px-3 py-3 text-left font-mono text-[13px] ${
                    cur?.path === f.path ? "bg-[#1a2740]" : "hover:bg-[#101a2c]"
                  }`}
                >
                  <span className="min-w-0 truncate">{f.name}</span>
                  {tab === "github" ? (
                    <span className={`shrink-0 rounded-md px-2 py-0.5 font-sans text-xs ${b.c}`}>{b.t}</span>
                  ) : (
                    <span className="shrink-0 font-sans text-xs text-slate-400">{f.lines} 行</span>
                  )}
                </button>
              );
            })}
            {!list.length && bundle && <div className="p-3 text-sm text-slate-400">没有需要更新的文件 🎉</div>}
          </div>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          {cur && (
            <>
              <div className="flex flex-wrap items-center gap-2.5 border-b border-slate-800 px-5 py-3">
                <span className="font-mono text-lg font-bold">{cur.name}</span>
                <span className="ml-auto text-sm text-slate-400">{display.split("\n").length - (display.endsWith("\n") ? 1 : 0)} 行</span>
                <button
                  onClick={async () => say((await copyText(cur.name)) ? "已复制文件名 ✓" : "复制失败")}
                  className="rounded-lg bg-[#1a2740] px-4 py-2 text-sm font-bold hover:bg-[#233456]"
                >
                  复制文件名
                </button>
                <button onClick={editOnGithub} className="rounded-lg bg-[#1a2740] px-4 py-2 text-sm font-bold hover:bg-[#233456]">
                  在 GitHub 编辑 ↗
                </button>
                <button
                  onClick={async () => say((await copyText(display)) ? `已复制 ${cur.name} ✓` : "复制失败，请手动选中复制")}
                  className="rounded-lg bg-blue-500 px-5 py-2 text-sm font-extrabold text-white hover:bg-blue-400"
                >
                  复制此文件
                </button>
              </div>
              <pre className="min-h-0 flex-1 overflow-auto bg-[#060c16] p-5 font-mono text-[13px] leading-6 text-slate-200">{display}</pre>
            </>
          )}
          {!bundle && !err && <div className="p-8 text-slate-400">正在读取代码文件…</div>}
        </section>
      </div>

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 rounded-xl border border-emerald-400/50 bg-[#07111d] px-5 py-3 text-sm font-semibold text-emerald-300 shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}
