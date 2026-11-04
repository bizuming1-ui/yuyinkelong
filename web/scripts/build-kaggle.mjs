// 构建流水线（在项目根目录运行：node scripts/build-kaggle.mjs）
//  1) 临时移走 generated/，用 vite 构建“内嵌版网站”（单文件 HTML，不含 Kaggle 脚本，避免自己包含自己）
//  2) gzip + base64 → 写进 kaggle-src/csi_radar_kaggle.py 的 SITE_B64 → 输出 generated/csi_radar_kaggle.py
//  3) 之后再运行 npm run build，主站的“复制代码界面”就包含这个完整 Kaggle 文件
import { execSync } from "node:child_process";
import fs from "node:fs";
import zlib from "node:zlib";

const GEN = "generated";
const OUT = "/tmp/embed_dist";
fs.rmSync(OUT, { recursive: true, force: true });
fs.rmSync(GEN, { recursive: true, force: true });
fs.mkdirSync(GEN, { recursive: true });
execSync(`npx vite build --outDir ${OUT} --emptyOutDir`, { stdio: "inherit", env: { ...process.env, VITE_EMBED: "1" } });
const html = fs.readFileSync(`${OUT}/index.html`);
const gz = zlib.gzipSync(html, { level: 9 });
const b64 = gz.toString("base64").replace(/(.{100})/g, "$1\n");
const src = fs.readFileSync("kaggle-src/csi_radar_kaggle.py", "utf8");
const marker = 'SITE_B64 = ""  # @@SITE_B64@@';
if (!src.includes(marker)) throw new Error("marker not found in kaggle-src/csi_radar_kaggle.py");
const out = src.replace(marker, `SITE_B64 = """\n${b64}\n"""  # 内嵌网站(gzip+base64)，由 scripts/build-kaggle.mjs 生成`);
fs.writeFileSync(`${GEN}/csi_radar_kaggle.py`, out);
console.log(`site html ${(html.length / 1024).toFixed(0)} KB → gzip ${(gz.length / 1024).toFixed(0)} KB → kaggle file ${(out.length / 1024).toFixed(0)} KB`);
