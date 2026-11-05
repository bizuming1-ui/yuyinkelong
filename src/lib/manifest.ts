// 文件清单（复制代码界面使用）。路径 = 仓库内相对路径。
import dataRaw from "./manifest-data.ts?raw";
import { RAW } from "./manifest-data";

export type FileGroup = "github" | "esp32-a" | "esp32-b" | "esp32-c" | "kaggle" | "legacy";

export interface CodeFile {
  path: string;
  content: string;
  lines: number;
  bytes: number;
  group: FileGroup;
}

// 把 import.meta.glob 的相对键（相对 src/lib/）还原成仓库根相对路径
function norm(key: string) {
  const parts = ["src", "lib"];
  for (const seg of key.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== "." && seg !== "") parts.push(seg);
  }
  return parts.join("/");
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
const merged: Record<string, string> = {};
for (const [k, v] of Object.entries(RAW)) merged[norm(k)] = v;
merged["src/lib/manifest-data.ts"] = dataRaw;

export const FILES: CodeFile[] = Object.keys(merged)
  .sort((a, b) => a.localeCompare(b))
  .map((path) => {
    const content = merged[path];
    return { path, content, lines: content.split("\n").length, bytes: enc.encode(content).length, group: groupOf(path) };
  });
