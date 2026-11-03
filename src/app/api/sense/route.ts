import { cors, store } from "@/lib/radar-store";

export const dynamic = "force-dynamic";

export async function GET() {
  const s = store();
  const nodes: Record<string, number> = {};
  for (const [k, v] of Object.entries(s.csi)) nodes[k] = v.length;
  return Response.json({ sense: s.sense, stat: s.csiStat, nodes }, { headers: cors() });
}
