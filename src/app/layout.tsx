import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "双 ESP32-S3 WiFi CSI 3D 感知模拟器",
  description: "双 ESP32-S3 + MQTT + 13 信道拼接 · 路径长度-时间 3D 剖面 · 浏览器直接打开",
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#050a14" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="bg-[#050a14] text-slate-200 antialiased">{children}</body>
    </html>
  );
}
