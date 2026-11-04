import { GITHUB_BRANCH, GITHUB_REPO } from "@/lib/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// 服务端代理 GitHub 文件树：浏览器直连 api.github.com 被限流(403)时，改走本服务器。
// 可选：在服务器环境变量里设置 GITHUB_TOKEN（只读即可），限额从 60 次/小时提升到 5000 次/小时。
// 15 秒内存缓存，避免多个浏览器同时刷新把额度耗光。
let cache: { at: number; body: string } | null = null;

export async function GET() {
  const now = Date.now();
  if (cache && now - cache.at < 15_000) {
    return new Response(cache.body, { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  }
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "yuyinkelong-sim" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  try {
    const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/git/trees/${GITHUB_BRANCH}?recursive=1`, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) {
      if (cache) return new Response(cache.body, { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
      return Response.json({ error: `GitHub API ${r.status}` }, { status: 502 });
    }
    const j = (await r.json()) as { tree?: { path: string; type: string; sha: string }[] };
    const slim = JSON.stringify({ tree: (j.tree ?? []).map((t) => ({ path: t.path, type: t.type, sha: t.sha })) });
    cache = { at: now, body: slim };
    return new Response(slim, { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ error: String(e instanceof Error ? e.message : e) }, { status: 502 });
  }
}
