import { authInfo, cors, setBaselineStore } from "@/lib/radar-store";

export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: cors() });
}

export async function POST(req: Request) {
  const a = authInfo(req);
  if (!a.ok) return Response.json({ ok: false }, { status: 401, headers: cors() });
  try {
    const j = (await req.json()) as { baselineM?: number };
    if (typeof j.baselineM === "number") setBaselineStore(j.baselineM);
    return Response.json({ ok: true }, { headers: cors() });
  } catch (e) {
    return Response.json({ ok: false, err: String(e) }, { status: 400, headers: cors() });
  }
}
