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
  active: string; // 当前真正在用的网址（可以同时填多个，自动选能通的）
  reach: Reach;
  hint: string; // 针对失败原因的中文建议
};
export type EventItem = { t: number; lv: "ok" | "warn" | "fail" | "info"; msg: string };

const INIT: Conn = { status: "idle", lastOk: 0, lastErr: "", latency: 0, polls: 0, fails: 0, healthOk: null, healthMsg: "", firstDataAt: 0, active: "", reach: "unknown", hint: "" };

const POLL_TIMEOUT = 15000; // v8 是 6s：隧道首个请求（TLS+隧道建立）经常超过 6s，导致“一直超时”

function withTimeout(ms: number) {
  const ctl = new AbortController();
  const id = setTimeout(() => ctl.abort(), ms);
  return { signal: ctl.signal, done: () => clearTimeout(id) };
}

export type ProbeResult = { ok: boolean; reach: Reach; msg: string; hint: string; ms: number; version?: string };

/** 精确区分：能用 / 浏览器根本连不到该域名(被墙/DNS/断网) / 域名通但隧道已失效(Cloudflare 530/1033) / 通了但不是本雷达主机 */
export async function probeHost(url: string): Promise<ProbeResult> {
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  try {
    const to = withTimeout(POLL_TIMEOUT);
    const r = await fetch(url + "/api/health?_=" + Date.now(), { cache: "no-store", signal: to.signal });
    to.done();
    const txt = await r.text();
    let j: { kind?: string; version?: string; uptime?: number } | null = null;
    try {
      j = JSON.parse(txt);
    } catch {
      j = null;
    }
    if (j && j.kind === "csi-radar") return { ok: true, reach: "ok", msg: `HTTP ${r.status} · ${ms()}ms · 主机 v${j.version} 已运行 ${Math.round(j.uptime || 0)}s`, hint: "", ms: ms(), version: j.version };
    if (r.status === 530 || r.status === 1033 || /1033|Argo Tunnel|tunnel error/i.test(txt))
      return { ok: false, reach: "dead", msg: `HTTP ${r.status}：Cloudflare 说这条隧道已经不存在`, hint: "Kaggle 的 Cell 已停止或重新运行过，网址已换。请回 Kaggle 输出框复制【最新】网址。", ms: ms() };
    if (r.status === 502 || r.status === 503 || r.status === 504)
      return { ok: false, reach: "dead", msg: `HTTP ${r.status}：隧道在，但后面的 Flask 没有响应`, hint: "Kaggle Cell 可能崩溃或还在启动，看 Kaggle 输出框最后几行。", ms: ms() };
    return { ok: false, reach: "wrong", msg: `HTTP ${r.status} 但返回内容不是本雷达主机`, hint: "网址不是本系统的 Kaggle 主机（或旧网址已被别的服务占用）。", ms: ms() };
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    // 再用 no-cors 探一次：能拿到“不透明响应”说明域名可达（只是被 CORS/错误页拦了）；连这个都失败 = 网络层不通
    try {
      const to = withTimeout(10000);
      await fetch(url + "/api/health?_=" + Date.now(), { mode: "no-cors", cache: "no-store", signal: to.signal });
      to.done();
      return {
        ok: false,
        reach: "dead",
        msg: `域名可达，但返回的不是雷达主机（没有 CORS 头/是 Cloudflare 错误页）${name === "AbortError" ? "，且读取超时" : ""}`,
        hint: "这几乎一定是【旧网址/隧道已失效】：回 Kaggle 输出框复制最新网址；或确认 Cell 仍在运行。",
        ms: ms(),
      };
    } catch {
      const cf = /trycloudflare\.com/i.test(url);
      return {
        ok: false,
        reach: "blocked",
        msg: name === "AbortError" ? `${Math.round(POLL_TIMEOUT / 1000)}s 内没有任何响应` : "浏览器连不到这个域名（DNS 解析失败/被网络屏蔽/网址拼错/已断网）",
        hint: cf
          ? "你的网络可能访问不了 trycloudflare.com（国内常见）。办法：①开代理/VPN 后刷新；②改用 Kaggle 输出框里的备用网址（lhr.life / pinggy / ngrok）；③换手机热点试试。"
          : "确认网址完整无拼错、Kaggle Cell 仍在运行；换 Kaggle 输出框里的其它备用网址试试。",
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
    patch({ status: "demo", lastErr: "" });
    log("info", "演示模式已开启：显示的是模拟数据，不是真实 ESP32");
    let n = 0;
    const t0 = performance.now();
    const id = setInterval(() => {
      n++;
      const s = demoState((performance.now() - t0) / 1000, n, baseRef.current);
      stateRef.current = s;
      rowsRef.current.push(...s.rows);
      if (rowsRef.current.length > 400) rowsRef.current.splice(0, rowsRef.current.length - 400);
      setState(s);
      patch({ lastOk: Date.now(), polls: n });
    }, 330);
    return () => {
      clearInterval(id);
      log("info", "演示模式已关闭");
    };
  }, [demo, patch, log]);

  // 真实模式：探测（可同时给多个网址）→ 选通的 → 轮询；连续失败自动重新探测/切换网址
  useEffect(() => {
    if (demo) return;
    stateRef.current = null;
    seqRef.current = 0;
    setState(null);
    const urls = parseUrls(urlText);
    if (!urls.length) {
      patch({ ...INIT, status: "idle" });
      return;
    }
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let nPoll = 0;
    let nFail = 0;
    let errStreak = 0;
    let firstData = 0;
    patch({ ...INIT, status: "connecting" });
    log("info", `开始连接：${urls.join("  |  ")}`);

    const choose = async (): Promise<boolean> => {
      const rs = await Promise.all(urls.map((u) => probeHost(u).then((r) => ({ u, r }))));
      if (stop) return false;
      for (const { u, r } of rs) log(r.ok ? "ok" : "fail", `${u} → ${r.msg}${r.hint ? " · " + r.hint : ""}`);
      const good = rs.find((x) => x.r.ok);
      if (good) {
        activeRef.current = good.u;
        patch({ healthOk: true, healthMsg: good.r.msg, reach: "ok", hint: "", active: good.u, status: connRef.current.status === "error" ? "connecting" : connRef.current.status });
        return true;
      }
      const w = rs[0].r;
      activeRef.current = "";
      patch({ healthOk: false, healthMsg: w.msg, reach: w.reach, hint: w.hint, active: urls[0], status: "error", lastErr: w.msg });
      return false;
    };

    const poll = async () => {
      if (stop) return;
      let delay = 300;
      const base = activeRef.current;
      if (!base) {
        const ok = await choose();
        if (!stop) timer = setTimeout(poll, ok ? 100 : 4000);
        return;
      }
      const to = withTimeout(POLL_TIMEOUT);
      const t = performance.now();
      try {
        const r = await fetch(`${base}/api/state?since=${seqRef.current}`, { cache: "no-store", signal: to.signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const ct = r.headers.get("content-type") || "";
        if (!ct.includes("json")) throw new Error(`返回的不是 JSON（${ct || "无类型"}）：隧道可能已失效`);
        const s = (await r.json()) as RadarState;
        nPoll++;
        if (s.seq < seqRef.current) {
          seqRef.current = 0;
          log("warn", "主机序号回退（主机重启过），重新同步");
        }
        if (s.rows?.length) {
          rowsRef.current.push(...s.rows);
          if (rowsRef.current.length > 400) rowsRef.current.splice(0, rowsRef.current.length - 400);
        }
        seqRef.current = s.seq;
        stateRef.current = s;
        setState(s);
        if (errStreak > 0) log("ok", "连接恢复");
        errStreak = 0;
        if (!firstData && s.seq > 0) {
          firstData = Date.now();
          log("ok", "收到第一帧真实 CSI 剖面");
        }
        patch({ status: "ok", lastOk: Date.now(), latency: Math.round(performance.now() - t), polls: nPoll, fails: nFail, lastErr: "", firstDataAt: firstData, reach: "ok", hint: "" });
      } catch (e) {
        nFail++;
        errStreak++;
        const m = e instanceof Error ? (e.name === "AbortError" ? `请求超时(${POLL_TIMEOUT / 1000}s)` : e.message) : String(e);
        patch({ status: "error", lastErr: m, fails: nFail, polls: nPoll });
        if (errStreak === 1 || errStreak % 20 === 0) log("fail", `轮询失败：${m}`);
        delay = Math.min(5000, 1200 + errStreak * 400);
        // 连续 3 次失败：重新探测所有网址（可能隧道换了/某个备用网址能通），给出准确原因
        if (errStreak === 3 || errStreak % 12 === 0) {
          activeRef.current = "";
          delay = 200;
        }
      } finally {
        to.done();
      }
      if (!stop) timer = setTimeout(poll, delay);
    };
    activeRef.current = "";
    poll();

    const dg = async () => {
      const b = activeRef.current;
      if (!b) return;
      try {
        const to = withTimeout(8000);
        const r = await fetch(b + "/api/diag", { cache: "no-store", signal: to.signal });
        to.done();
        if (r.ok) setServerDiag((await r.json()) as ServerDiag);
      } catch {
        /* 忽略 */
      }
    };
    const di = setInterval(dg, 3000);
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
      clearInterval(di);
    };
  }, [urlText, demo, patch, log]);

  const post = useCallback(
    async (path: string, body: unknown, key: string) => {
      const base = activeRef.current || parseUrls(urlText)[0];
      if (!base) return false;
      try {
        const r = await fetch(base + path, { method: "POST", headers: { "X-Radar-Key": key, "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
        log(r.ok ? "ok" : "fail", `POST ${path} → HTTP ${r.status}${r.status === 401 ? "（API_KEY 不对）" : ""}`);
        return r.ok;
      } catch (e) {
        log("fail", `POST ${path} 失败：${e instanceof Error ? e.message : String(e)}`);
        return false;
      }
    },
    [urlText, log],
  );

  const clearEvents = useCallback(() => setEvents([]), []);
  return { stateRef, rowsRef, state, conn, events, serverDiag, log, post, clearEvents };
}
