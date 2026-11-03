import fs from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";

const ROOT = process.cwd();
const ROOT_FILES = [
  "README.md",
  ".gitignore",
  "package.json",
  "tsconfig.json",
  "next.config.ts",
  "postcss.config.mjs",
  "eslint.config.mjs",
  "drizzle.config.json",
];
const DIRS = ["src", "public", "firmware", "kaggle", "tools", "scripts"];
const SKIP = new Set(["node_modules", ".next", ".pio", ".git", ".shots", ".vscode", "__pycache__"]);
const TEXT_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".json", ".css", ".html", ".md", ".py", ".ini", ".h", ".cpp", ".txt"]);
const KAGGLE = "kaggle/wifi_radar_kaggle.py";

async function walk(dir: string, out: string[]) {
  let entries;
  try {
    entries = await fs.readdir(path.join(ROOT, dir), { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) await walk(rel, out);
    else if (TEXT_EXT.has(path.extname(e.name)) || e.name === ".gitignore") out.push(rel);
  }
}

async function readText(rel: string) {
  return (await fs.readFile(path.join(ROOT, rel), "utf8")).replace(/\r\n/g, "\n");
}

export async function GET() {
  const paths: string[] = [];
  for (const f of ROOT_FILES) {
    try {
      await fs.access(path.join(ROOT, f));
      paths.push(f);
    } catch {
      /* 文件不存在就跳过 */
    }
  }
  for (const d of DIRS) await walk(d, paths);

  const files: { path: string; content: string; lines: number }[] = [];
  for (const p of paths) {
    let content = await readText(p);
    if (p === KAGGLE) {
      // Kaggle 单文件始终由模板 + 最新的 radar.html 实时合成，保证不会过期
      try {
        const tpl = await readText("scripts/kaggle_template.py");
        const html = await readText("public/radar.html");
        content = tpl.replace("__RADAR_HTML__", () => html);
      } catch {
        /* 退回磁盘上已生成的文件 */
      }
    }
    files.push({ path: p, content, lines: content.split("\n").length - (content.endsWith("\n") ? 1 : 0) });
  }
  const pioOrder = ["firmware/platformio.ini", "firmware/include/config.h", "firmware/src/main.cpp"];
  return Response.json({
    files,
    kaggle: KAGGLE,
    pio: pioOrder.filter((p) => files.some((f) => f.path === p)),
  });
}
