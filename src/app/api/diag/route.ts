import { cors, serverDiag } from "@/lib/radar-store";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(serverDiag(), { headers: cors() });
}
