import type { Metadata } from "next";
import CodeBrowser from "@/components/CodeBrowser";
import { loadFiles } from "@/lib/manifest";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "复制代码 · 双 ESP32-S3 CSI 雷达" };

export default function CodePage() {
  return <CodeBrowser files={loadFiles()} />;
}
