import fs from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";

const abs = (rel: string) => path.join(/*turbopackIgnore: true*/ process.cwd(), rel);
const ROOT_FILES = ["README.md", "package.json", "next.config.ts", "tsconfig.json", "postcss.config.mjs", "eslint.config.mjs", ".gitignore"];
const DIRS = ["firmware", "kaggle", "tools", "src"];
const SKIP_DIR = new Set(["node_modules", ".next", ".pio", ".git", ".vscode", "__pycache__", "db"]);
const TEXT_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".json", ".css", ".md", ".py", ".ini", ".h", ".cpp", ".txt"]);
const SKIP_FILE = new Set(["next-env.d.ts"]);

async function walk(dir: string, out: string[]) {
  let entries;
  try {
    entries = await fs.readdir(abs(dir), { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (SKIP_DIR.has(e.name)) continue;
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) await walk(rel, out);
    else if ((TEXT_EXT.has(path.extname(e.name)) || e.name === ".gitignore") && !SKIP_FILE.has(e.name)) out.push(rel);
  }
}

export async function GET() {
  const paths: string[] = [];
  for (const f of ROOT_FILES) {
    try {
      await fs.access(abs(f));
      paths.push(f);
    } catch {
      /* skip */
    }
  }
  for (const d of DIRS) await walk(d, paths);
  const files: { path: string; content: string; lines: number; bytes: number }[] = [];
  for (const p of paths) {
    const content = (await fs.readFile(abs(p), "utf8")).replace(/\r\n/g, "\n");
    files.push({ path: p, content, lines: content.split("\n").length - (content.endsWith("\n") ? 1 : 0), bytes: Buffer.byteLength(content) });
  }
  const pioNames = ["platformio.ini", "include/config.h", "include/radar_common.h", "src/main.cpp"];
  return Response.json({
    files,
    kaggle: "kaggle/csi_radar_kaggle.py",
    pioA: pioNames.map((n) => `firmware/node_a/${n}`),
    pioB: pioNames.map((n) => `firmware/node_b/${n}`),
  });
}
