import { cors, stateResponse } from "@/lib/radar-store";

export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: cors() });
}

export async function GET(req: Request) {
  const since = parseInt(new URL(req.url).searchParams.get("since") || "0", 10) || 0;
  return Response.json(stateResponse(since), { headers: cors() });
}
