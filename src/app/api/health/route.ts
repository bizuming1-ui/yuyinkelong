import { db } from "@/db";
import { sql } from "drizzle-orm";

export const dynamic = "force-dynamic";
const T0 = Date.now();

export async function GET() {
  try {
    await db.execute(sql`select 1`);
    return Response.json(
      {
        ok: true,
        kind: "csi-radar",
        version: "11.0",
        t: Date.now() / 1000,
        uptime: Math.round((Date.now() - T0) / 100) / 10,
        urls: [],
        gpus: 0,
      },
      {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store",
        },
      },
    );
  } catch {
    return Response.json({ ok: false }, { status: 500 });
  }
}
