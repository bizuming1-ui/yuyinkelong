export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const target = new URL(req.url).searchParams.get("url") || "";
  if (!/^https?:\/\//i.test(target)) {
    return Response.json({ ok: false, error: "invalid url" }, { status: 400 });
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 7500);
  try {
    const r = await fetch(target, {
      cache: "no-store",
      signal: ctl.signal,
      headers: { Accept: "application/json, text/plain, */*" },
    });
    const body = await r.text();
    return new Response(body, {
      status: r.status,
      headers: {
        "Content-Type": r.headers.get("content-type") || "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}
