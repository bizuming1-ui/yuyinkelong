import type { Metadata } from "next";
import CodeBrowser from "./CodeBrowser";

export const metadata: Metadata = { title: "复制代码 · ESP32-S3 WiFi 雷达" };

export default function CodePage() {
  return <CodeBrowser />;
}
