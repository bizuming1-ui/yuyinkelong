import { authInfo, calibrateStore, cors } from "@/lib/radar-store";

export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: cors() });
}

export async function POST(req: Request) {
  const a = authInfo(req);
  if (!a.ok) return Response.json({ ok: false }, { status: 401, headers: cors() });
  calibrateStore();
  return Response.json({ ok: true }, { headers: cors() });
}
