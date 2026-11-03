import { cors, framesResponse } from "@/lib/radar-store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const since = parseInt(new URL(req.url).searchParams.get("since") || "0", 10) || 0;
  return Response.json(framesResponse(since), { headers: cors() });
}
