import { cors, ruleScene, store } from "@/lib/radar-store";

export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: cors() });
}

// 与 Kaggle 版 /api/scene 同接口：内置服务端没有 GPU，只给规则解说
export async function GET() {
  const s = store();
  return Response.json({ ok: true, scene: ruleScene(s.sense), engine: "rules", ms: 0, n: 0, ai: { state: "规则（无 GPU）", model: "", vram: [] } }, { headers: cors() });
}
