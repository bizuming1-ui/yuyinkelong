import { cors } from "@/lib/radar-store";

export const dynamic = "force-dynamic";

// 内置服务端不做 WiFi 地理定位（Kaggle 版才有 beaconDB / OSM 代理）；页面会自动改用浏览器定位或手动经纬度。
export async function GET() {
  return Response.json({ ok: false, error: "内置服务端不提供 /api/geo，请用浏览器定位" }, { headers: cors() });
}
