import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "WiFi RADAR · 浏览器模拟器",
  description: "ESP32-S3 WiFi 雷达：3D 真实世界 + 浏览器模拟器 + 全能检测日志 + 复制代码界面",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="bg-[#0b1118] text-slate-200 antialiased">{children}</body>
    </html>
  );
}
