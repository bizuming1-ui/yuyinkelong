import { authInfo, cors, evt, evtRate, ingestBinaryRc, ingestFrame } from "@/lib/radar-store";

export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: cors() });
}

export async function POST(req: Request) {
  const a = authInfo(req);
  const src = a.same ? "网页转发" : "ESP32 WiFi直传";
  if (!a.ok) {
    evtRate("badkey", 5, "ERR", "ingest", `拒绝 ${a.ip} 上传：API_KEY 不一致`);
    return Response.json({ ok: false, err: "key" }, { status: 401, headers: cors() });
  }

  const ab = await req.arrayBuffer();
  const u8 = new Uint8Array(ab);
  // 支持二进制 'RC' 协议 (v11 ESP32 固件与 sim_esp32_csi.py)
  if (u8.byteLength >= 16 && u8[0] === 0x52 && u8[1] === 0x43) {
    const res = ingestBinaryRc(u8, req.headers.get("x-radar-info") || "", a.ip);
    return Response.json({ ok: res.ok, why: res.why, seq: res.seq }, { status: res.ok ? 200 : 400, headers: cors() });
  }

  // 兼容 JSON 格式
  let f: unknown = null;
  try {
    const raw = new TextDecoder().decode(u8);
    f = JSON.parse(raw);
  } catch {
    f = null;
  }
  if (!f || typeof f !== "object" || !Array.isArray((f as { aps?: unknown }).aps)) {
    return Response.json({ ok: false, why: "bad_frame" }, { status: 400, headers: cors() });
  }
  const seq = ingestFrame(f as { aps: unknown[] }, a.ip, src);
  if (seq === 1) evt("OK", "ingest", `首次收到 ${src}：${a.ip}`);
  return Response.json({ ok: true, seq }, { headers: cors() });
}
