"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { demoState, type RadarState, type Row, type ServerDiag } from "./radar";

export type ConnStatus = "idle" | "connecting" | "ok" | "error" | "demo";
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
};
export type EventItem = { t: number; lv: "ok" | "warn" | "fail" | "info"; msg: string };

const INIT: Conn = { status: "idle", lastOk: 0, lastErr: "", latency: 0, polls: 0, fails: 0, healthOk: null, healthMsg: "", firstDataAt: 0 };

export function useRadar(url: string, demo: boolean, baselineM: number) {
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
      setState(s);
      patch({ lastOk: Date.now(), polls: n });
    }, 330);
    return () => {
      clearInterval(id);
      log("info", "演示模式已关闭");
    };
  }, [demo, patch, log]);

  // 真实模式：轮询 Kaggle
  useEffect(() => {
    if (demo) return;
    stateRef.current = null;
    seqRef.current = 0;
    setState(null);
    if (!url) {
      patch({ ...INIT, status: "idle" });
      return;
    }
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ctl: AbortController | null = null;
    let nPoll = 0;
    let nFail = 0;
    let errStreak = 0;
    patch({ ...INIT, status: "connecting" });
    log("info", `开始连接 ${url}`);

    (async () => {
      try {
        const t = performance.now();
        const r = await fetch(url + "/api/health", { cache: "no-store" });
        const j = await r.json().catch(() => null);
        if (j && j.kind === "csi-radar") {
          patch({ healthOk: true, healthMsg: `HTTP ${r.status} · ${Math.round(performance.now() - t)}ms · 主机 v${j.version} 运行 ${Math.round(j.uptime)}s` });
          log("ok", "Kaggle 主机 /api/health 正常");
        } else {
          patch({ healthOk: false, healthMsg: `HTTP ${r.status} 但返回内容不是本雷达主机（可能是旧隧道/别的服务）` });
          log("fail", `/api/health 返回异常：HTTP ${r.status}`);
        }
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        patch({ healthOk: false, healthMsg: `无法访问：${m}（网址错？Kaggle Cell 已停？隧道已换新网址？）` });
        log("fail", `无法访问 ${url}/api/health：${m}`);
      }
    })();

    const poll = async () => {
      if (stop) return;
      ctl = new AbortController();
      const to = setTimeout(() => ctl?.abort(), 6000);
      const t = performance.now();
      let delay = 300;
      try {
        const r = await fetch(`${url}/api/state?since=${seqRef.current}`, { cache: "no-store", signal: ctl.signal });
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
        const first = connRef.current.firstDataAt || (s.seq > 0 ? Date.now() : 0);
        if (first && !connRef.current.firstDataAt) log("ok", "收到第一帧真实 CSI 剖面");
        patch({ status: "ok", lastOk: Date.now(), latency: Math.round(performance.now() - t), polls: nPoll, fails: nFail, lastErr: "", firstDataAt: first });
      } catch (e) {
        nFail++;
        errStreak++;
        const m = e instanceof Error ? (e.name === "AbortError" ? "请求超时(6s)" : e.message) : String(e);
        patch({ status: "error", lastErr: m, fails: nFail, polls: nPoll });
        if (errStreak === 1 || errStreak % 20 === 0) log("fail", `轮询失败：${m}`);
        delay = 1500;
      } finally {
        clearTimeout(to);
      }
      if (!stop) timer = setTimeout(poll, delay);
    };
    poll();

    const dg = async () => {
      try {
        const r = await fetch(url + "/api/diag", { cache: "no-store" });
        if (r.ok) setServerDiag((await r.json()) as ServerDiag);
      } catch {
        /* 忽略 */
      }
    };
    dg();
    const di = setInterval(dg, 3000);
    return () => {
      stop = true;
      ctl?.abort();
      if (timer) clearTimeout(timer);
      clearInterval(di);
    };
  }, [url, demo, patch, log]);

  const post = useCallback(
    async (path: string, body: unknown, key: string) => {
      if (!url) return false;
      try {
        const r = await fetch(url + path, { method: "POST", headers: { "X-Radar-Key": key, "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
        log(r.ok ? "ok" : "fail", `POST ${path} → HTTP ${r.status}${r.status === 401 ? "（API_KEY 不对）" : ""}`);
        return r.ok;
      } catch (e) {
        log("fail", `POST ${path} 失败：${e instanceof Error ? e.message : String(e)}`);
        return false;
      }
    },
    [url, log],
  );

  const clearEvents = useCallback(() => setEvents([]), []);
  return { stateRef, rowsRef, state, conn, events, serverDiag, log, post, clearEvents };
}
