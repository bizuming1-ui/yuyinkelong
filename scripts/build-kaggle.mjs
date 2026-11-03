// 生成 Kaggle 单文件：把 public/radar.html 嵌入 scripts/kaggle_template.py -> kaggle/wifi_radar_kaggle.py
// 用法：node scripts/build-kaggle.mjs   （修改 public/radar.html 或模板后要重新运行一次）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tpl = fs.readFileSync(path.join(root, "scripts/kaggle_template.py"), "utf8");
const html = fs.readFileSync(path.join(root, "public/radar.html"), "utf8").replace(/\r\n/g, "\n");
if (html.includes("'''")) throw new Error("radar.html 不能包含 ''' (会破坏 Python 原始字符串)");
if (html.trimEnd().endsWith("\\")) throw new Error("radar.html 不能以反斜杠结尾");
const out = tpl.replace("__RADAR_HTML__", () => html);
fs.mkdirSync(path.join(root, "kaggle"), { recursive: true });
fs.writeFileSync(path.join(root, "kaggle/wifi_radar_kaggle.py"), out);
console.log("kaggle/wifi_radar_kaggle.py 已生成：", out.split("\n").length, "行,", Math.round(out.length / 1024), "KB");
