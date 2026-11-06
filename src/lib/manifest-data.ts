// 复制代码界面的文件清单数据源：构建时由 Vite 把仓库里的真实文件原文打包进来（import.meta.glob + ?raw）。
// 所以「复制代码界面」展示的永远是当前这份源码本身，不会出现「界面里的代码和仓库不一致」。
// 新增/删除文件后无需手动维护清单。
import selfRaw from "./manifest.ts?raw";

const globbed = import.meta.glob(
  [
    "../**/*.{ts,tsx,css}", // src/**
    "../../tools/**/*.{ts,py,md}",
    "../../firmware/**/*.{h,cpp,ini,py,md}",
    "../../kaggle/**/*.{py,md,txt}",
    "../../docs/**/*.md",
    "../../README.md",
    "../../index.html",
    "../../package.json",
    "../../tsconfig.json",
    "../../vite.config.ts",
    "../../.gitignore",
    "../../.github/workflows/*.yml",
    "../../提示词",
    "!../lib/manifest.ts",
  ],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

export const RAW: Record<string, string> = { ...globbed, "../lib/manifest.ts": selfRaw };
