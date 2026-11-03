import { cors, serverDiag } from "@/lib/radar-store";

export const dynamic = "force-dynamic";

export async function GET() {
  const d = serverDiag(0);
  return Response.json({ res: d.res, gpu: d.gpu, series: 0, budgets: d.budgets, motion: 0 }, { headers: cors() });
}
