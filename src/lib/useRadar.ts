"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { demoState, parseUrls, type RadarState, type Row, type ServerDiag } from "./radar";

export type ConnStatus = "idle" | "connecting" | "ok" | "error" | "demo";
export type Reach = "unknown" | "ok" | "blocked" | "dead" | "wrong" | "http";
export type Conn = {
  status: ConnStatus;
  lastOk: number;
  lastErr: string;
  latency: number;
  polls: number;
  fails: number;
  healthOk: boolean | null;
  healthMsg: string;
  firstDataAt: number;
  active: string;
  reach: Reach;
  hint: string;
};
export type EventItem = { t: number; lv: "ok" | "warn" | "fail" | "info"; msg: string };

const INIT: Conn = {
  status: "idle",
  lastOk: 0,
  lastErr: "",
  latency: 0,
  polls: 0,
  fails: 0,
  healthOk: null,
  healthMsg: "",
  firstDataAt: 0,
  active: "",
  reach: "unknown",
  hint: "",
};

const POLL_TIMEOUT = 8000;
const HEDGE_DELAY_MS = 2200;

function withTimeout(ms: number) {
  const ctl = new AbortController();
  const id = setTimeout(() => ctl.abort(), ms);
  return { signal: ctl.signal, done: () => clearTimeout(id), abort: () => ctl.abort() };
}

async function fetchViaDirectOrProxy(targetUrl: string, pathAndQuery: string, signal: AbortSignal): Promise<Response> {
  const full = targetUrl + pathAndQuery;
  try {
    return await fetch(full, { cache: "no-store", signal });
  } catch (err) {
    // 如果浏览器直连被 ISP/防火墙瞬时抖动拦截，且当前页面非目标同源，则自动尝试通过本站服务端 /api/proxy 代理转发
    if (typeof window !== "undefined" && !full.startsWith(window.location.origin)) {
      const proxyUrl = `/api/proxy?url=${encodeURIComponent(full)}`;
      return await fetch(proxyUrl, { cache: "no-store", signal });
    }
    throw err;
  }
}

export type ProbeResult = {
  ok: boolean;
  reach: Reach;
  msg: string;
  hint: string;
  ms: number;
  version?: string;
  urls?: string[];
};

export async function probeHost(url: string): Promise<ProbeResult> {
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  try {
    const to = withTimeout(POLL_TIMEOUT);
    const r = await fetchViaDirectOrProxy(url, "/api/health?_=" + Date.now(), to.signal);
    to.done();
    const txt = await r.text();
    let j: { kind?: string; version?: string; uptime?: number; urls?: string[] } | null = null;
    try {
      j = JSON.parse(txt);
    } catch {
      j = null;
    }
    if (j && j.kind === "csi-radar") {
      return {
        ok: true,
        reach: "ok",
        msg: `HTTP ${r.status} · ${ms()}ms · 主机 v${j.version} 已运行 ${Math.round(j.uptime || 0)}s`,
        hint: "",
        ms: ms(),
        version: j.version,
        urls: Array.isArray(j.urls) ? j.urls : [],
      };
    }
    if (r.status === 530 || r.status === 1033 || /1033|Argo Tunnel|tunnel error/i.test(txt)) {
      return {
        ok: false,
        reach: "dead",
        msg: `HTTP ${r.status}：该隧道已过期下线`,
        hint: "Kaggle 的 Cell 已重启或换了新网址。请复制 Kaggle 输出框里的【最新】网址。",
        ms: ms(),
      };
    }
    if (r.status === 502 || r.status === 503 || r.status === 504) {
      return {
        ok: false,
        reach: "dead",
        msg: `HTTP ${r.status}：隧道可达，但后端未响应`,
        hint: "请检查 Kaggle Notebook 的 Cell 是否仍在运行。",
        ms: ms(),
      };
    }
    return {
      ok: false,
      reach: "wrong",
      msg: `HTTP ${r.status} 返回内容不是 CSI 雷达主机`,
      hint: "请确认填写的是 Kaggle 输出框打印的雷达网址。",
      ms: ms(),
    };
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    try {
      const to = withTimeout(5000);
      await fetch(url + "/api/health?_=" + Date.now(), { mode: "no-cors", cache: "no-store", signal: to.signal });
      to.done();
      return {
        ok: false,
        reach: "dead",
        msg: `域名可达，但隧道已失效或返回错误页${name === "AbortError" ? "（读取超时）" : ""}`,
        hint: "请回 Kaggle 输出框复制最新网址，或同时粘贴 lhr.life / pinggy 备用网址。",
        ms: ms(),
      };
    } catch {
      const cf = /trycloudflare\.com/i.test(url);
      return {
        ok: false,
        reach: "blocked",
        msg: name === "AbortError" ? "连接响应超时" : "网络无法直连该隧道域名",
        hint: cf
          ? "当前网络访问 trycloudflare.com 不畅：可改填 Kaggle 输出框里的 pinggy / lhr.life 备用网址。"
          : "请确认 Kaggle Cell 正在运行，或尝试 Kaggle 输出框中的其它备用网址。",
        ms: ms(),
      };
    }
  }
}

export function useRadar(urlText: string, demo: boolean, baselineM: number) {
  const stateRef = useRef<RadarState | null>(null);
  const rowsRef = useRef<Row[]>([]);
  const [state, setState] = useState<RadarState | null>(null);
  const [conn, setConn] = useState<Conn>(INIT);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [serverDiag, setServerDiag] = useState<ServerDiag | null>(null);
  const connRef = useRef<Conn>(INIT);
  const seqRef = useRef(0);
  const baseRef = useRef(baselineM);
  baseRef.current = baselineM;
  const activeRef = useRef("");
  const poolRef = useRef<string[]>([]);

  const log = useCallback((lv: EventItem["lv"], msg: string) => {
    setEvents((e) => [...e.slice(-199), { t: Date.now(), lv, msg }]);
  }, []);

  const patch = useCallback((p: Partial<Conn>) => {
    connRef.current = { ...connRef.current, ...p };
    setConn(connRef.current);
  }, []);

  // 演示模式
  useEffect(() => {
    if (!demo) return;
    patch({ status: "demo", lastErr: "", healthOk: true, reach: "ok", hint: "" });
    log("info", "演示模式已开启：实时模拟 1 块 ESP32-S3 全能雷达 + 空间多物体检测");
    let n = 0;
    const t0 = performance.now();
    const tick = () => {
      n++;
      const s = demoState((performance.now() - t0) / 1000, n, baseRef.current);
      stateRef.current = s;
      rowsRef.current.push(...s.rows);
      if (rowsRef.current.length > 400) rowsRef.current.splice(0, rowsRef.current.length - 400);
      setState(s);
      patch({ lastOk: Date.now(), polls: n, latency: 8 });
    };
    tick();
    const id = setInterval(tick, 300);
    return () => {
      clearInterval(id);
      log("info", "演示模式已关闭");
    };
  }, [demo, patch, log]);

  // 真实模式：多隧道并发抢占 + 零断连保活轮询
  useEffect(() => {
    if (demo) return;
    stateRef.current = null;
    seqRef.current = 0;
    setState(null);
    const initialCandidates = parseUrls(urlText);
    if (!initialCandidates.length) {
      activeRef.current = "";
      poolRef.current = [];
      patch({ ...INIT, status: "idle" });
      return;
    }
    poolRef.current = [...initialCandidates];
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let nPoll = 0;
    let nFail = 0;
    let errStreak = 0;
    activeRef.current = initialCandidates[0];
    patch({ ...INIT, status: "connecting", active: initialCandidates[0] });
    log("info", `开始连接：${initialCandidates.join(" , ")}`);

    const mergePool = (extra: string[]) => {
      for (const raw of extra) {
        for (const u of parseUrls(raw)) {
          if (u && !poolRef.current.includes(u)) poolRef.current.push(u);
        }
      }
    };

    const pickBest = async (): Promise<string> => {
      const cands = poolRef.current.length ? poolRef.current : initialCandidates;
      const results = await Promise.all(cands.map(async (u) => ({ u, r: await probeHost(u) })));
      if (stop) return activeRef.current;
      for (const { r } of results) {
        if (r.urls?.length) mergePool(r.urls);
      }
      const good = results.find((x) => x.r.ok);
      if (good) {
        activeRef.current = good.u;
        patch({
          active: good.u,
          healthOk: true,
          reach: "ok",
          healthMsg: good.r.msg,
          hint: "",
          lastErr: "",
        });
        log("ok", `${good.u} → ${good.r.msg}`);
        return good.u;
      }
      const first = results[0];
      patch({
        healthOk: false,
        reach: first.r.reach,
        healthMsg: first.r.msg,
        hint: first.r.hint,
        lastErr: first.r.msg,
        status: "error",
      });
      log("fail", `${first.u}：${first.r.msg}`);
      return first.u;
    };

    const fetchStateFromUrl = async (u: string, since: number, timeoutMs: number): Promise<{ u: string; s: RadarState; dt: number }> => {
      const to = withTimeout(timeoutMs);
      const t0 = performance.now();
      try {
        const r = await fetchViaDirectOrProxy(u, `/api/state?since=${since}&_=${Date.now()}`, to.signal);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const ct = r.headers.get("content-type") || "";
        if (!ct.includes("json")) throw new Error(`非 JSON 响应`);
        const s = (await r.json()) as RadarState;
        return { u, s, dt: Math.round(performance.now() - t0) };
      } finally {
        to.done();
      }
    };

    // 核心零断连抢占式拉取：主网址超过 2.2s 未回或报错时，立即并发请求池中其它备用隧道，谁先返回用谁
    const poll = async () => {
      if (stop) return;
      let delay = 280;
      const primary = activeRef.current || poolRef.current[0];
      const backups = poolRef.current.filter((x) => x !== primary);
      try {
        let res: { u: string; s: RadarState; dt: number };
        if (backups.length > 0) {
          res = await new Promise<{ u: string; s: RadarState; dt: number }>((resolve, reject) => {
            let settled = false;
            let pending = 1 + backups.length;
            let lastErr: unknown = new Error("timeout");
            const onWin = (val: { u: string; s: RadarState; dt: number }) => {
              if (!settled) {
                settled = true;
                resolve(val);
              }
            };
            const onFail = (e: unknown) => {
              lastErr = e;
              pending--;
              if (pending <= 0 && !settled) reject(lastErr);
            };
            fetchStateFromUrl(primary, seqRef.current, POLL_TIMEOUT).then(onWin).catch(onFail);
            const hedgeTimer = setTimeout(() => {
              if (settled) return;
              for (const b of backups) {
                fetchStateFromUrl(b, seqRef.current, POLL_TIMEOUT).then(onWin).catch(onFail);
              }
            }, HEDGE_DELAY_MS);
            // 若主请求在 HEDGE_DELAY_MS 前完成，清理定时器并扣减未触发的 backup 计数
            setTimeout(() => clearTimeout(hedgeTimer), HEDGE_DELAY_MS + 50);
          });
        } else {
          res = await fetchStateFromUrl(primary, seqRef.current, POLL_TIMEOUT);
        }

        const { u: winnerUrl, s, dt } = res;
        activeRef.current = winnerUrl;
        if (s.tunnels?.length) {
          mergePool(s.tunnels.filter((t) => t.ok && t.url).map((t) => t.url));
        }
        if (s.tunnel) mergePool([s.tunnel]);

        nPoll++;
        if (s.seq < seqRef.current) {
          seqRef.current = 0;
        }
        if (s.rows?.length) {
          rowsRef.current.push(...s.rows);
          if (rowsRef.current.length > 400) rowsRef.current.splice(0, rowsRef.current.length - 400);
        }
        seqRef.current = s.seq;
        stateRef.current = s;
        setState(s);
        errStreak = 0;
        const first = connRef.current.firstDataAt || (s.seq > 0 ? Date.now() : 0);
        if (first && !connRef.current.firstDataAt) log("ok", "收到第一帧真实 CSI 剖面与空间物体数据");
        patch({
          status: "ok",
          active: winnerUrl,
          reach: "ok",
          healthOk: true,
          hint: "",
          lastOk: Date.now(),
          latency: dt,
          polls: nPoll,
          fails: nFail,
          lastErr: "",
          firstDataAt: first,
        });
      } catch (e) {
        errStreak++;
        // 关键零断连策略：偶发 1~3 次网络抖动立即在 200ms 内快速重试或无缝切备用隧道，绝不弹窗断连或刷屏报错
        if (errStreak <= 3 && stateRef.current) {
          delay = 180;
          if (poolRef.current.length > 1) {
            const idx = (poolRef.current.indexOf(activeRef.current) + 1) % poolRef.current.length;
            activeRef.current = poolRef.current[idx];
          }
        } else {
          nFail++;
          const m = e instanceof Error ? (e.name === "AbortError" ? "通道切换重试中" : e.message) : String(e);
          if (errStreak >= 4) {
            await pickBest();
          }
          if (errStreak >= 6) {
            patch({ status: "error", lastErr: m, fails: nFail, polls: nPoll });
            if (errStreak === 6 || errStreak % 20 === 0) log("warn", `网络波动自动重连中：${m}`);
          }
          delay = 600;
        }
      }
      if (!stop) timer = setTimeout(poll, delay);
    };

    const dg = async () => {
      const u = activeRef.current || poolRef.current[0];
      if (!u) return;
      try {
        const to = withTimeout(6000);
        const r = await fetchViaDirectOrProxy(u, "/api/diag?_=" + Date.now(), to.signal);
        to.done();
        if (r.ok) setServerDiag((await r.json()) as ServerDiag);
      } catch {
        /* 忽略诊断抖动 */
      }
    };

    pickBest().then(() => {
      if (!stop) {
        poll();
        dg();
      }
    });
    const di = setInterval(dg, 3500);
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
      clearInterval(di);
    };
  }, [urlText, demo, patch, log]);

  const post = useCallback(
    async (path: string, body: unknown, key: string) => {
      const u = activeRef.current || parseUrls(urlText)[0];
      if (!u) return false;
      try {
        const to = withTimeout(POLL_TIMEOUT);
        const r = await fetch(u + path, {
          method: "POST",
          headers: { "X-Radar-Key": key, "Content-Type": "application/json" },
          body: JSON.stringify(body ?? {}),
          signal: to.signal,
        });
        to.done();
        log(r.ok ? "ok" : "fail", `POST ${path} → HTTP ${r.status}${r.status === 401 ? "（API_KEY 不一致）" : ""}`);
        return r.ok;
      } catch (e) {
        log("fail", `POST ${path} 失败：${e instanceof Error ? e.message : String(e)}`);
        return false;
      }
    },
    [urlText, log],
  );

  const clearEvents = useCallback(() => setEvents([]), []);
  return { stateRef, rowsRef, state, conn, events, serverDiag, post, clearEvents };
}
