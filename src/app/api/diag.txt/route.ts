import { cors, diagText } from "@/lib/radar-store";

export const dynamic = "force-dynamic";

export async function GET() {
  return new Response(diagText(), { headers: cors({ "Content-Type": "text/plain; charset=utf-8" }) });
}
