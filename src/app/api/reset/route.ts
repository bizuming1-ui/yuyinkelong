import { cors, resetStore } from "@/lib/radar-store";

export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: cors() });
}

export async function POST() {
  resetStore();
  return Response.json({ ok: true }, { headers: cors() });
}
