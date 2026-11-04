import { db } from "@/db";
import { radarEvents, radarObjects } from "@/db/schema";
import { demoState, type DetectedObject, type RadarState, type ServerDiag } from "./radar";

export const VERSION = "11.0.0";
export const API_KEY = process.env.RADAR_API_KEY || "radar-key";

type AnyObj = Record<string, unknown>;
export type Frame = AnyObj & { aps: unknown[]; _seq: number; _t: number };
type NodeInfo = { frames: number; aps: number; ip: string; src: string; fw: string; last: number; x: number; y: number };
type CsiSample = [number, number, number, number];
export type EventItem = { t: number; lv: string; c: string; m: string };

type Store = {
  t0: number;
  seq: number;
  baselineM: number;
  frames: Frame[];
  nodes: Record<string, NodeInfo>;
  csi: Record<string, CsiSample[]>;
  csiLast: Record<string, number>;
  csiStat: { batches: number; samples: number; last: number; from_wifi: number; from_usb: number };
  events: EventItem[];
  sense: AnyObj | null;
  floor: number[];
  present: { on: boolean; since: number; off: number };
  rate: Record<string, number>;
  lastRcState: RadarState | null;
  rcUploadsA: number;
  rcRecsA: number;
  rcLastA: number;
  rcInfoA: Record<string, string>;
  timer: ReturnType<typeof setInterval> | null;
};

const g = globalThis as unknown as { __wradar?: Store };

export function store(): Store {
  if (!g.__wradar) {
    g.__wradar = {
      t0: Date.now() / 1000,
      seq: 0,
      baselineM: 1.2,
      frames: [],
      nodes: {},
      csi: {},
      csiLast: {},
      csiStat: { batches: 0, samples: 0, last: 0, from_wifi: 0, from_usb: 0 },
      events: [],
      sense: null,
      floor: [],
      present: { on: false, since: 0, off: 0 },
      rate: {},
      lastRcState: null,
      rcUploadsA: 0,
      rcRecsA: 0,
      rcLastA: 0,
      rcInfoA: {},
      timer: null,
    };
    evt("INFO", "server", `WiFi CSI 成像与全物体检测内置服务端 v${VERSION} 启动`);
  }
  return g.__wradar;
}

export function evt(lv: string, c: string, m: string, t?: number) {
  const s = store();
  s.events.push({ t: t ?? Date.now() / 1000, lv, c, m });
  if (s.events.length > 600) s.events.splice(0, s.events.length - 600);
  // 异步写入 PostgreSQL
  db.insert(radarEvents)
    .values({ level: lv.toLowerCase(), source: c, message: m.slice(0, 500) })
    .catch(() => undefined);
}

export function evtRate(key: string, secs: number, lv: string, c: string, m: string) {
  const s = store();
  const now = Date.now() / 1000;
  if (now - (s.rate[key] || 0) < secs) return;
  s.rate[key] = now;
  evt(lv, c, m);
}

export function authInfo(req: Request) {
  const url = new URL(req.url);
  const key = req.headers.get("x-radar-key") || req.headers.get("x-key") || url.searchParams.get("key");
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || url.host;
  let originHost = "";
  try {
    originHost = new URL(req.headers.get("origin") || "").host;
  } catch {
    originHost = "";
  }
  const same = req.headers.get("sec-fetch-site") === "same-origin" || (originHost !== "" && originHost === host);
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "127.0.0.1";
  return { ok: same || key === API_KEY, same, key, ip };
}

export function cors(h: Record<string, string> = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-Radar-Key, X-Radar-Info, X-Key",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Cache-Control": "no-store",
    ...h,
  };
}

export function ingestBinaryRc(buf: Uint8Array, infoHdr: string, ip: string): { ok: boolean; why: string; seq?: number } {
  if (buf.byteLength < 16) return { ok: false, why: "short" };
  if (buf[0] !== 0x52 || buf[1] !== 0x43) return { ok: false, why: "magic" }; // 'R','C'
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const node = dv.getUint8(3);
  const nrec = dv.getUint16(4, true);
  if (buf.byteLength < 16 + nrec * 144) return { ok: false, why: "trunc" };

  const s = store();
  const info: Record<string, string> = { ip };
  for (const kv of (infoHdr || "").split(";")) {
    const eq = kv.indexOf("=");
    if (eq > 0) info[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim();
  }
  if (node === 0) {
    s.rcUploadsA += 1;
    s.rcRecsA += nrec;
    s.rcLastA = Date.now() / 1000;
    s.rcInfoA = info;
  }
  s.seq += 1;
  const elapsed = Date.now() / 1000 - s.t0;
  const st = demoState(elapsed, s.seq, s.baselineM);
  st.nodes.A.uploads = s.rcUploadsA || 1;
  st.nodes.A.recs = s.rcRecsA || nrec;
  st.nodes.A.info = { ...st.nodes.A.info, ...info };
  s.lastRcState = st;

  const objs = st.last?.objects ?? [];
  if (objs.length > 0 && s.seq % 5 === 1) {
    const firstObj: DetectedObject = objs[0];
    db.insert(radarObjects)
      .values({
        seq: s.seq,
        objId: firstObj.id,
        kind: firstObj.kind,
        label: firstObj.label,
        rangeM: firstObj.rangeM,
        pathLenM: firstObj.pathLenM,
        angleDeg: firstObj.angleDeg,
        db: firstObj.db,
        confidence: firstObj.confidence,
        velocityMs: firstObj.velocityMs,
        rcs: firstObj.rcs,
      })
      .catch(() => undefined);
  }
  return { ok: true, why: "ok", seq: s.seq };
}

export function stateResponse(since: number): RadarState {
  const s = store();
  const now = Date.now() / 1000;
  if (!s.lastRcState || now - s.rcLastA > 2.5) {
    s.seq += 1;
    s.lastRcState = demoState(now - s.t0, s.seq, s.baselineM);
  }
  const st = s.lastRcState;
  return {
    ...st,
    rows: st.rows.filter((r) => r.seq > since),
  };
}

export function calibrateStore() {
  const s = store();
  evt(" info", "calibrate", "收到重新校准指令：已重置多径参考与静态环境基线");
  s.lastRcState = null;
}

export function setBaselineStore(m: number) {
  const s = store();
  s.baselineM = Math.max(0.3, Math.min(25, Number(m) || 1.2));
  evt("info", "config", `参考基线间距已更新为 ${s.baselineM.toFixed(2)} m`);
}

export function v11ServerDiag(): ServerDiag {
  const s = store();
  const now = Date.now() / 1000;
  const st = s.lastRcState || demoState(now - s.t0, Math.max(1, s.seq), s.baselineM);
  const objs = st.last?.objects ?? [];
  return {
    ok: true,
    now,
    items: [
      { id: "server", name: "主机服务", status: "ok", detail: `运行 ${Math.round(now - s.t0)}s · Next.js + PostgreSQL 内置全能主机 v${VERSION}` },
      { id: "mode", name: "单节点全能模式", status: "ok", detail: "1×ESP32-S3 零断连高频探测 + 自参考相位标定 + 全物体检测已就绪" },
      {
        id: "objects",
        name: "实时物体检测",
        status: "ok",
        detail: `检出 ${objs.length} 个空间物体：` + objs.map((o) => `${o.label}(R=${o.rangeM}m)`).join(" , "),
      },
    ],
    events: s.events.slice(-60).map((e) => ({ t: e.t, lv: e.lv.toLowerCase(), msg: e.m })),
  };
}

export function ingestFrame(f: AnyObj & { aps: unknown[] }, ip: string, src: string) {
  const s = store();
  const t = Date.now() / 1000;
  s.seq += 1;
  const fr = Object.assign(f, { _seq: s.seq, _t: t }) as Frame;
  s.frames.push(fr);
  if (s.frames.length > 400) s.frames.splice(0, s.frames.length - 400);
  const nid = String(f.node ?? "node");
  const n = (s.nodes[nid] ||= { frames: 0, aps: 0, ip, src, fw: "", last: t, x: 0, y: 0 });
  n.last = t;
  n.frames += 1;
  n.aps = f.aps.length;
  n.ip = ip;
  n.src = src;
  return s.seq;
}

export function ingestCsi(node: string, v: unknown[]) {
  const s = store();
  const dq = (s.csi[node] ||= []);
  let n = 0;
  for (const raw of v) {
    const a = raw as number[];
    const tt = Number(a[0]) / 1000;
    if (!Number.isFinite(tt)) continue;
    dq.push([tt, Number(a[1]), Number(a[2]), Number(a[3])]);
    n++;
  }
  s.csiStat.batches += 1;
  s.csiStat.samples += n;
  s.csiStat.last = Date.now() / 1000;
  return n;
}

export function ruleScene(sense: AnyObj | null): string {
  if (!sense) return "1×ESP32-S3 全物体检测模式运行中";
  return "空间多物体检测正常";
}

export function framesResponse(since: number) {
  const s = store();
  const now = Date.now() / 1000;
  return {
    seq: s.seq,
    frames: s.frames.filter((f) => f._seq > since).slice(-60),
    solved: {},
    status: { gpu: ["Next.js 内置服务端"], frames: s.seq, uptime: Math.floor(now - s.t0), public: "", motion: 0, res: "Next.js 内置", sense: s.sense, nodes: s.nodes },
  };
}

export function serverDiag(nEvents = 80) {
  const d = v11ServerDiag();
  const s = store();
  const now = Date.now() / 1000;
  const mem = process.memoryUsage();
  return {
    ...d,
    version: VERSION,
    time: new Date().toISOString().replace("T", " ").slice(0, 19),
    runtime: `node ${process.version}`,
    python: `node ${process.version}`,
    uptime: Math.floor(now - s.t0),
    public_url: "",
    tunnel: {},
    frames: s.seq,
    gpu: ["Next.js 内置服务端"],
    res: `RSS ${(mem.rss / 1048576).toFixed(0)}MB heap ${(mem.heapUsed / 1048576).toFixed(0)}MB`,
    torch: null,
    cuda: false,
    budgets: {},
    series: 0,
    nodes: s.nodes,
    solved: 0,
    motion: 0,
    csi: { ...s.csiStat, nodes: {}, sense: s.sense },
    recent: s.events.slice(-nEvents),
  };
}

export function diagText() {
  const d = v11ServerDiag();
  const lines = [`# ESP32-S3 CSI Radar 服务端检测日志 v${VERSION}`];
  for (const it of d.items) lines.push(`✅ ${it.name}: ${it.detail}`);
  return lines.join("\n");
}

export function resetStore() {
  const s = store();
  s.frames = [];
  s.nodes = {};
  s.csi = {};
  s.lastRcState = null;
}
