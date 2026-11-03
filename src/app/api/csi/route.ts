import { authInfo, cors, ingestCsi } from "@/lib/radar-store";

export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: cors() });
}

export async function POST(req: Request) {
  const a = authInfo(req);
  if (!a.ok) return Response.json({ ok: false, error: "bad key" }, { status: 401, headers: cors() });
  let j: { node?: unknown; v?: unknown } | null = null;
  try {
    j = await req.json();
  } catch {
    j = null;
  }
  if (!j || !Array.isArray(j.v)) return Response.json({ ok: false, error: "bad csi batch" }, { status: 400, headers: cors() });
  const n = ingestCsi(String(j.node ?? "node"), j.v);
  return Response.json({ ok: true, n }, { headers: cors() });
}
