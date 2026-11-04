import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "ESP32-S3 单节点全能 WiFi CSI 成像与物体检测系统 · 浏览器模拟器 (v11)",
  description: "1×ESP32-S3 单节点零断连高频探测 + 自参考相位标定 + Kaggle T4×2 GPU 超分辨 + 3D 全物体检测浏览器模拟器",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="bg-[#070b13] text-slate-100 antialiased">{children}</body>
    </html>
  );
}
