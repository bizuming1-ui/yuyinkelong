import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "ESP32-S3 WiFi 雷达 · 浏览器模拟器",
  description: "ESP32-S3 WiFi 雷达：浏览器模拟器、3D 真实世界、一键复制 GitHub / Kaggle / PlatformIO 代码。",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="bg-[#050b14] text-slate-100 antialiased">{children}</body>
    </html>
  );
}
