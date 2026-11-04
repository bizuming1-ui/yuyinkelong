import JSZip from "jszip";
import { loadFiles } from "@/lib/manifest";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/download            → 整个项目（可直接解压后 git push）
// GET /api/download?t=esp32-1  → 只含 ESP32-1 的 PlatformIO 工程（3 个文件）
// GET /api/download?t=esp32-2  → 只含 ESP32-2 的 PlatformIO 工程
export async function GET(req: Request) {
  const t = new URL(req.url).searchParams.get("t");
  const files = loadFiles();
  const zip = new JSZip();
  let name = "yuyinkelong-project";
  if (t === "esp32-1" || t === "esp32-2") {
    name = `${t}-platformio`;
    const prefix = `firmware/${t}/`;
    for (const f of files) if (f.path.startsWith(prefix)) zip.file(f.path.slice(prefix.length), f.content);
  } else {
    for (const f of files) zip.file(f.path, f.content);
  }
  const buf = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  return new Response(buf as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${name}.zip"`,
      "Cache-Control": "no-store",
    },
  });
}
