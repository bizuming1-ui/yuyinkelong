import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "ESP32-S3 双节点 WiFi CSI 雷达 · 浏览器模拟器",
  description: "ESP-NOW 全信道跳频 + 双向相位标定 + 重叠子载波拼接 + Kaggle GPU 主机端 + 3D 距离-时间可视化",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="bg-[#070b13] text-slate-100 antialiased">{children}</body>
    </html>
  );
}
