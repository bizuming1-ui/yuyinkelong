import { authInfo, cors, evt, evtRate, ingestFrame } from "@/lib/radar-store";

export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: cors() });
}

export async function POST(req: Request) {
  const a = authInfo(req);
  const src = a.same ? "网页USB转发" : "ESP32 WiFi直传";
  if (!a.ok) {
    evtRate("badkey", 5, "ERR", "ingest", `拒绝 ${a.ip} 的上传：API_KEY 不一致（收到 ${JSON.stringify(a.key)}）。请把 config.h 的 API_KEY 改成与服务器一致（默认 radar-key）`);
    return Response.json({ ok: false, error: "bad key" }, { status: 401, headers: cors() });
  }
  let f: unknown = null;
  let raw = "";
  try {
    raw = await req.text();
    f = JSON.parse(raw);
  } catch {
    f = null;
  }
  if (!f || typeof f !== "object" || !Array.isArray((f as { aps?: unknown }).aps)) {
    evtRate("badframe", 5, "ERR", "ingest", `收到格式错误的数据（${src}，${raw.length} 字节）：缺少 aps 数组`);
    return Response.json({ ok: false, error: "bad frame" }, { status: 400, headers: cors() });
  }
  const seq = ingestFrame(f as { aps: unknown[] }, a.ip, src);
  if (seq === 1) evt("OK", "ingest", `首次收到 ${src}：${a.ip}`);
  return Response.json({ ok: true, seq }, { headers: cors() });
}
