import type { Metadata } from "next";
import CodeBrowser from "@/components/CodeBrowser";

export const metadata: Metadata = { title: "复制代码界面 · ESP32-S3 CSI 雷达" };

export default function CodePage() {
  return <CodeBrowser />;
}
