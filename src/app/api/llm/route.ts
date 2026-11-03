import { ruleAdvice } from "@/lib/advisor";
import { cors } from "@/lib/radar-store";

export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: cors() });
}

export async function GET() {
  return Response.json({ ok: true, engine: "rules", model: null, note: "内置服务端使用规则诊断；Kaggle 版会加载 GPU 大模型" }, { headers: cors() });
}

export async function POST(req: Request) {
  let j: { report?: unknown; problems?: unknown } = {};
  try {
    j = await req.json();
  } catch {
    j = {};
  }
  return Response.json({ ok: true, engine: "rules", text: ruleAdvice(typeof j.problems === "string" ? j.problems : String(j.report ?? "").slice(0, 60000)) }, { headers: cors() });
}
