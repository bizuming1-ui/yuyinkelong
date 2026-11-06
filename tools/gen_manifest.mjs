// 生成「复制代码界面」的文件清单数据：把仓库里的真实文件原文收集到 src/lib/manifest.generated.json。
// 由 npm 的 predev / prebuild 自动运行（Vite），也被 Next.js 沙盒的 next.config.ts 调用。
// 所以「复制代码界面」展示的永远是当前这份源码本身，不会漏文件，也不需要手动维护清单。
//   node tools/gen_manifest.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT_REL = "src/lib/manifest.generated.json";

// 目录 → 允许的扩展名
const DIRS = [
  ["src", [".ts", ".tsx", ".css"]],
  ["tools", [".ts", ".py", ".md", ".mjs"]],
  ["firmware", [".h", ".cpp", ".ini", ".py", ".md"]],
  ["kaggle", [".py", ".md", ".txt"]],
  ["docs", [".md"]],
  [".github/workflows", [".yml", ".yaml"]],
];
const FILES = ["README.md", "index.html", "package.json", "tsconfig.json", "vite.config.ts", ".gitignore", "提示词"];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".pio", "work", ".next", "__pycache__", ".shots"]);

function walk(root, rel, exts, out) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return;
  for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
    const r = rel + "/" + ent.name;
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) walk(root, r, exts, out);
    } else if (ent.isFile()) {
      if (r === OUT_REL) continue;
      if (exts.length === 0 || exts.includes(path.extname(ent.name))) out.push(r);
    }
  }
}

export function collect(root) {
  const list = [];
  for (const [dir, exts] of DIRS) walk(root, dir, exts, list);
  for (const f of FILES) if (fs.existsSync(path.join(root, f))) list.push(f);
  list.sort((a, b) => a.localeCompare(b));
  const data = {};
  for (const p of list) data[p] = fs.readFileSync(path.join(root, p), "utf8");
  return data;
}

export function generateManifest(root) {
  const data = collect(root);
  const json = JSON.stringify(data);
  const out = path.join(root, OUT_REL);
  let old = "";
  try {
    old = fs.readFileSync(out, "utf8");
  } catch {
    /* first run */
  }
  if (old !== json) fs.writeFileSync(out, json);
  return Object.keys(data).length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const n = generateManifest(root);
  console.log(`[manifest] 已收集 ${n} 个文件 → ${OUT_REL}`);
}
