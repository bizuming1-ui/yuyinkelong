import { cors, evt, store } from "@/lib/radar-store";

export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: cors() });
}

export async function POST(req: Request) {
  store();
  let j: { entries?: { lv?: unknown; c?: unknown; m?: unknown; t?: unknown }[] } = {};
  try {
    j = await req.json();
  } catch {
    j = {};
  }
  for (const e of (j.entries || []).slice(0, 100)) {
    const t = Number(e.t) / 1000;
    evt(String(e.lv ?? "INFO").slice(0, 5), "web/" + String(e.c ?? "").slice(0, 12), String(e.m ?? "").slice(0, 400), Number.isFinite(t) && t > 0 ? t : undefined);
  }
  return Response.json({ ok: true }, { headers: cors() });
}
