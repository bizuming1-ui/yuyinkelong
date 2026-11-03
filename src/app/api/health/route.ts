import { db } from "@/db";
import { sql } from "drizzle-orm";
import { VERSION, store } from "@/lib/radar-store";

export const dynamic = "force-dynamic";

export async function GET() {
  const s = store();
  let dbOk = true;
  try {
    await db.execute(sql`select 1`);
  } catch {
    dbOk = false;
  }
  return Response.json(
    { ok: dbOk, version: VERSION, frames: s.seq, uptime: Math.floor(Date.now() / 1000 - s.t0), gpu: ["Next.js 内置服务端"], res: "Next.js", topic: "", published: 0 },
    { status: dbOk ? 200 : 500, headers: { "Cache-Control": "no-store" } },
  );
}
