// 服务端：扫描"需要放进 GitHub 的全部文件"。新增/删除文件无需维护清单，页面会自动出现并参与同步检测。
import fs from "node:fs";
import path from "node:path";

export interface CodeFile {
  path: string;
  content: string;
  group: "esp32-1" | "esp32-2" | "web" | "tools" | "docs";
  lines: number;
  bytes: number;
}

const ROOT = /*turbopackIgnore: true*/ process.cwd();
const DIRS = ["src/app", "src/components", "src/lib", "firmware", "tools"];
const FILES = ["package.json", "tsconfig.json", "next.config.ts", "postcss.config.mjs", "eslint.config.mjs", "README.md", ".gitignore"];
const SKIP = [/^src\/app\/api\/health\//, /(^|\/)node_modules\//, /(^|\/)\.pio\//, /(^|\/)\.next\//, /\.(png|jpg|ico|bin|elf)$/i];

function walk(rel: string, out: string[]) {
  const abs = path.join(ROOT, rel);
  let ents: fs.Dirent[] = [];
  try {
    ents = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    const r = `${rel}/${e.name}`;
    if (SKIP.some((re) => re.test(r))) continue;
    if (e.isDirectory()) walk(r, out);
    else out.push(r);
  }
}

function groupOf(p: string): CodeFile["group"] {
  if (p.startsWith("firmware/esp32-1/")) return "esp32-1";
  if (p.startsWith("firmware/esp32-2/")) return "esp32-2";
  if (p.startsWith("tools/")) return "tools";
  if (p === "README.md" || p === ".gitignore") return "docs";
  return "web";
}

export function loadFiles(): CodeFile[] {
  const list: string[] = [];
  for (const d of DIRS) walk(d, list);
  for (const f of FILES) if (fs.existsSync(path.join(ROOT, f))) list.push(f);
  const out: CodeFile[] = [];
  for (const p of Array.from(new Set(list)).sort()) {
    try {
      const abs = path.join(ROOT, p);
      const st = fs.statSync(abs);
      if (st.size > 600_000) continue;
      const content = fs.readFileSync(abs, "utf8").replace(/\r\n/g, "\n");
      out.push({ path: p, content, group: groupOf(p), lines: content.split("\n").length, bytes: Buffer.byteLength(content) });
    } catch {
      /* 跳过读取失败的文件 */
    }
  }
  return out;
}
