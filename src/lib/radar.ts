// 雷达共用类型 / 工具 / 演示数据（演示数据会在界面上明确标注“演示”，绝不冒充真实数据）
export const GH_REPO = "bizuming1-ui/yuyinkelong";
export const URL_KEY = "radar.kaggleUrl";
export const KEY_KEY = "radar.apiKey";

export type NodeInfo = {
  online: boolean;
  age: number | null;
  uploads: number;
  recs: number;
  boots: number;
  uptimeMs: number;
  dropped: number;
  info: Record<string, string>;
};

export type Sense = {
  calibrated: boolean;
  calN: number;
  calNeed: number;
  present: boolean;
  motion: number;
  z: number;
  breathBpm: number | null;
  breathConf: number;
  breathPow?: number;
  activeR: number | null;
  activeConf?: number;
  level: "calibrating" | "none" | "still" | "moving";
};

export type Peak = { r: number; db: number };

export type LastSweep = {
  mode: "two-way" | "one-way";
  twoWay: boolean;
  sweep: number;
  t: number;
  pairs: number;
  channelsOk: number[];
  coherence: number;
  refCorr: number;
  overlaps: number[];
  bins: number;
  bwMHz: number;
  resM: number;
  music: number[] | null;
  musicPeaks?: Peak[];
  spectrum: number[];
  peaks: Peak[];
  sense: Sense;
  arrive: number;
};

export type Row = { seq: number; t: number; sweep: number; p: number[] };

export type RadarState = {
  ok: boolean;
  demo?: boolean;
  seq: number;
  now: number;
  uptime: number;
  plan: number;
  baselineM: number;
  rangeMax: number;
  nprof: number;
  nodes: { A: NodeInfo; B: NodeInfo };
  tunnel: string;
  gpu: { torch: boolean; cuda: number; devices: string[]; cir: string; music: string; nfft: number; cir_ms: number; music_ms: number; err: string };
  stats: { done: number; skipped: number; pending: number; procMs: number; rawBytes: number; rawOn: boolean };
  last: LastSweep | null;
  profile: number[] | null;
  rows: Row[];
  errors: Record<string, number>;
  lastError: string;
  syncLossPct: number | null;
};

export type ServerDiagItem = { id: string; name: string; status: "ok" | "warn" | "fail" | "info"; detail: string };
export type ServerDiag = { ok: boolean; now: number; items: ServerDiagItem[]; events: { t: number; lv: string; msg: string }[] };

export function normUrl(s: string): string {
  let u = (s || "").trim();
  if (!u) return "";
  const m = u.match(/https?:\/\/[^\s"'<>]+/i);
  if (m) u = m[0];
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try {
    const x = new URL(u);
    return x.origin;
  } catch {
    return "";
  }
}

export function plausibleKaggleUrl(u: string): boolean {
  return /^https:\/\/[a-z0-9-]+\.(trycloudflare\.com|lhr\.life|ngrok(-free)?\.(app|io|dev)|loca\.lt)$/i.test(u) || /^http:\/\/(127\.0\.0\.1|localhost|192\.168\.|10\.)/i.test(u);
}

// ---------------- 演示数据 ----------------
function gauss(x: number, c: number, w: number) {
  const d = (x - c) / w;
  return Math.exp(-d * d);
}

export function demoRow(t: number, baseline: number, n = 128, rmax = 30): number[] {
  const p: number[] = [];
  const person = 9 + 3.2 * Math.sin(t * 0.35) + 0.6 * Math.sin(t * 1.3);
  const breathe = 0.5 + 0.5 * Math.sin(t * 1.6);
  for (let i = 0; i < n; i++) {
    const L = ((i + 0.5) * rmax) / n;
    let a = 1.0 * gauss(L, baseline, 1.5) + 0.3 * gauss(L, 6.5, 1.8) + 0.22 * gauss(L, 13, 2.0) + 0.14 * gauss(L, 19, 2.2);
    a += (0.35 + 0.12 * breathe) * gauss(L, person, 1.7);
    a += 0.01 * Math.random();
    const db = 20 * Math.log10(a + 1e-3);
    p.push(Math.max(0, Math.min(255, Math.round(((db + 45) / 45) * 255))));
  }
  return p;
}

export function demoState(t: number, seq: number, baseline: number): RadarState {
  const p = demoRow(t, baseline);
  const node = (name: string): NodeInfo => ({
    online: true,
    age: 0.4,
    uploads: 12 + seq,
    recs: seq * 104,
    boots: 0,
    uptimeMs: t * 1000,
    dropped: 0,
    info: { fw: "demo", mac: name === "A" ? "DE:MO:00:00:00:0A" : "DE:MO:00:00:00:0B", rssi: "-47", ch: "6", ip: "demo" },
  });
  const person = 9 + 3.2 * Math.sin(t * 0.35);
  const spec = Array.from({ length: 245 }, (_, i) => Math.round(150 + 80 * Math.sin(i * 0.08 + t) * Math.cos(i * 0.021) + 20 * Math.random()));
  return {
    ok: true,
    demo: true,
    seq,
    now: Date.now() / 1000,
    uptime: t,
    plan: 13,
    baselineM: baseline,
    rangeMax: 30,
    nprof: 128,
    nodes: { A: node("A"), B: node("B") },
    tunnel: "",
    gpu: { torch: false, cuda: 0, devices: [], cir: "demo", music: "demo", nfft: 8192, cir_ms: 0, music_ms: 0, err: "" },
    stats: { done: seq, skipped: 0, pending: 0, procMs: 0, rawBytes: 0, rawOn: false },
    last: {
      mode: "two-way",
      twoWay: true,
      sweep: seq,
      t,
      pairs: 101,
      channelsOk: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
      coherence: 0.99,
      refCorr: 0.98,
      overlaps: [36, 36, 36],
      bins: 245,
      bwMHz: 76.6,
      resM: 3.92,
      music: null,
      musicPeaks: [
        { r: baseline, db: 0 },
        { r: Math.max(0.5, person), db: -6 },
        { r: 13, db: -12 },
      ],
      spectrum: spec,
      peaks: [
        { r: baseline, db: 0 },
        { r: Math.max(0.5, person), db: -5 },
        { r: 13, db: -11 },
      ],
      sense: { calibrated: true, calN: 24, calNeed: 24, present: true, motion: 0.45, z: 5, breathBpm: null, breathConf: 0, activeR: person, level: "moving" },
      arrive: Date.now() / 1000,
    },
    profile: p,
    rows: [{ seq, t, sweep: seq, p }],
    errors: {},
    lastError: "",
    syncLossPct: 2.1,
  };
}
