// 文件清单（复制代码界面使用）。路径 = 仓库内相对路径。
// 数据来自 src/lib/manifest.generated.json —— 由 tools/gen_manifest.mjs 在 npm run dev / build 之前自动生成，
// 里面是仓库真实文件的原文，所以复制代码界面展示的永远是当前这份源码本身。
import raw from "./manifest.generated.json";

export type FileGroup = "github" | "esp32-a" | "esp32-b" | "esp32-c" | "kaggle" | "legacy";

export interface CodeFile {
  path: string;
  content: string;
  lines: number;
  bytes: number;
  group: FileGroup;
}

function groupOf(p: string): FileGroup {
  if (p.startsWith("firmware/esp32-a/")) return "esp32-a";
  if (p.startsWith("firmware/esp32-b/")) return "esp32-b";
  if (p.startsWith("firmware/esp32-c/")) return "esp32-c";
  if (p.startsWith("firmware/esp32-1/") || p.startsWith("firmware/esp32-2/")) return "legacy";
  if (p.startsWith("kaggle/")) return "kaggle";
  return "github";
}

const enc = new TextEncoder();
const merged = raw as Record<string, string>;

export const FILES: CodeFile[] = Object.keys(merged)
  .sort((a, b) => a.localeCompare(b))
  .map((path) => {
    const content = merged[path];
    return { path, content, lines: content.split("\n").length, bytes: enc.encode(content).length, group: groupOf(path) };
  });
