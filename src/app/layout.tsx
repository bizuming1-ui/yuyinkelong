import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "WiFi RADAR · 浏览器模拟器",
  description: "ESP32-S3 WiFi 雷达：浏览器模拟器 + 3D 真实世界 + 一键复制代码",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="bg-[#0b1118] text-slate-200 antialiased">{children}</body>
    </html>
  );
}
