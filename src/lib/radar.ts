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

export type Peak = { r: number; db: number };

export type ObjectKind = "router" | "human_moving" | "human_breathing" | "static_object" | "wifi_device";

export type DetectedObject = {
  id: string;
  kind: ObjectKind;
  label: string;
  rangeM: number;       // 距 ESP32 雷达等效距离 R (m)
  pathLenM: number;     // 双基地/多径总路径长度 L (m)
  angleDeg: number;     // 空间方位角 (-180..180 deg)
  db: number;           // 散射/信号强度 (dB)
  confidence: number;   // 置信度 (0..1)
  velocityMs: number;   // 径向速度/运动指数 (m/s)
  rcs: "small" | "medium" | "large";
  breathBpm?: number | null;
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
  scan?: { bpm: number; r: number; conf: number };
  level: "calibrating" | "none" | "still" | "moving";
};

export type LastSweep = {
  mode: "two-way" | "one-way" | "single-node";
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
  musicPeaks: Peak[];
  spectrum: number[];
  peaks: Peak[];
  sense: Sense;
  objects?: DetectedObject[];
  macCount?: number;
  arrive: number;
};

export type Row = { seq: number; t: number; sweep: number; p: number[] };
export type TunnelItem = { name: string; url: string; ok: boolean; ms?: number | null; age?: number };

export type GpuInfo = {
  torch: boolean;
  cuda: number;
  devices: string[];
  cir: string;
  music: string;
  nfft: number;
  cir_ms: number;
  music_ms: number;
  err: string;
  engine?: string;
  afMs?: number;
  afGain?: number;
  afRuns?: number;
  vramHeldMB?: number[];
  util?: number[];
  memUsedMB?: number[];
  memTotalMB?: number[];
  ramGB?: number;
  ramTotalGB?: number;
  ramRingMB?: number;
  diskFreeGB?: number;
  diskTotalGB?: number;
};

export type RadarState = {
  ok: boolean;
  seq: number;
  now: number;
  uptime: number;
  plan: number;
  baselineM: number;
  rangeMax: number;
  nprof: number;
  singleNode?: boolean;
  nodes: { A: NodeInfo; B: NodeInfo };
  tunnel: string;
  tunnels?: TunnelItem[];
  gpu: GpuInfo;
  version: string;
  stats: { done: number; skipped: number; pending: number; procMs: number; rawBytes?: number; rawOn?: boolean };
  last: LastSweep | null;
  profile: number[] | null;
  rows: Row[];
  errors: Record<string, number>;
  lastError: string;
  syncLossPct: number | null;
};

export type DiagItem = { id: string; name: string; status: "ok" | "warn" | "fail" | "info"; detail: string };
export type ServerDiag = {
  ok: boolean;
  now: number;
  items: DiagItem[];
  events: { t: number; lv: string; msg: string }[];
};

export function normUrl(u: string): string {
  const s = (u || "").trim().replace(/\/+$/, "");
  if (!s) return "";
  return /^https?:\/\//i.test(s) ? s : "https://" + s;
}

/** 支持从输入框/剪贴板一次提取多个候选隧道网址（空格、换行、逗号分隔），按顺序自动选通的 */
export function parseUrls(raw: string): string[] {
  const m = (raw || "").match(/https?:\/\/[^\s,"'<>]+/gi) || [];
  const list = m.length ? m : (raw || "").split(/[\s,]+/).filter(Boolean);
  const out: string[] = [];
  for (const x of list) {
    const u = normUrl(x);
    if (u && !out.includes(u)) out.push(u);
  }
  return out;
}

/** 演示/仿真数据生成器：完整模拟 1 块 ESP32-S3 单节点全能雷达 + 多物体检测（路由器基站、移动人体、静止呼吸、静态障碍物、无线终端） */
export function demoState(t: number, seq: number, baselineM: number): RadarState {
  const N = 128;
  const R = 30;
  const d0 = Math.max(0.5, baselineM);
  const walkL = 7.5 + 2.2 * Math.sin(t * 0.45);
  const walkVel = 2.2 * 0.45 * Math.cos(t * 0.45);
  const breathMod = 0.08 * Math.sin((2 * Math.PI * 16) / 60 * t);
  const obj1L = 5.2;
  const obj2L = 11.8;
  const obj3L = 16.5;

  const prof: number[] = [];
  const mus: number[] = [];
  for (let i = 0; i < N; i++) {
    const r = ((i + 0.5) * R) / N;
    const g = (c: number, w: number, a: number) => a * Math.exp(-((r - c) ** 2) / (2 * w * w));
    const v =
      g(d0, 0.85, 248) +
      g(obj1L, 0.9, 172) +
      g(walkL + breathMod, 1.05, 196) +
      g(obj2L, 1.0, 148) +
      g(obj3L, 1.1, 118) +
      10 +
      4 * Math.sin(i * 0.3 + t);
    const m =
      g(d0, 0.3, 252) +
      g(obj1L, 0.32, 195) +
      g(walkL, 0.35, 224) +
      g(obj2L, 0.36, 175) +
      g(obj3L, 0.4, 142) +
      5;
    prof.push(Math.max(0, Math.min(255, Math.round(v))));
    mus.push(Math.max(0, Math.min(255, Math.round(m))));
  }
  const spec = Array.from({ length: 245 }, (_, i) => Math.round(185 + 45 * Math.cos(i * 0.09 + t * 0.6)));
  const moving = Math.abs(Math.cos(t * 0.45)) > 0.28;
  const motion = moving ? +(0.38 + 0.48 * Math.abs(Math.cos(t * 0.45))).toFixed(2) : 0.12;

  const objects: DetectedObject[] = [
    {
      id: "obj-router",
      kind: "router",
      label: "WiFi 路由器/热点基站 (LOS直达径)",
      rangeM: +d0.toFixed(2),
      pathLenM: +d0.toFixed(2),
      angleDeg: 0,
      db: -1.2,
      confidence: 0.99,
      velocityMs: 0,
      rcs: "medium",
    },
    {
      id: "obj-human-1",
      kind: moving ? "human_moving" : "human_breathing",
      label: moving ? "动态目标 (走动人体/移动物体)" : "静止人体 (检出呼吸微动 16.0 BPM)",
      rangeM: +Math.max(0.4, (walkL - d0) / 2 + d0 * 0.35).toFixed(2),
      pathLenM: +walkL.toFixed(2),
      angleDeg: +(28 * Math.sin(t * 0.35)).toFixed(1),
      db: -6.8,
      confidence: 0.95,
      velocityMs: +walkVel.toFixed(2),
      rcs: "large",
      breathBpm: 16.0,
    },
    {
      id: "obj-static-1",
      kind: "static_object",
      label: "近距强反射物体 #1 (桌面显示器/金属物)",
      rangeM: +Math.max(0.5, (obj1L - d0) / 2 + 0.4).toFixed(2),
      pathLenM: obj1L,
      angleDeg: -38,
      db: -9.4,
      confidence: 0.92,
      velocityMs: 0,
      rcs: "medium",
    },
    {
      id: "obj-static-2",
      kind: "static_object",
      label: "中距静态障碍物 #2 (墙体/家具反射面)",
      rangeM: +((obj2L - d0) / 2 + 0.6).toFixed(2),
      pathLenM: obj2L,
      angleDeg: 45,
      db: -13.5,
      confidence: 0.88,
      velocityMs: 0,
      rcs: "large",
    },
    {
      id: "obj-static-3",
      kind: "static_object",
      label: "远距多径散射体 #3 (房间边界结构)",
      rangeM: +((obj3L - d0) / 2 + 0.8).toFixed(2),
      pathLenM: obj3L,
      angleDeg: -62,
      db: -17.2,
      confidence: 0.82,
      velocityMs: 0,
      rcs: "large",
    },
    {
      id: "obj-device-1",
      kind: "wifi_device",
      label: "活跃无线终端 (手机/电脑 OFDM 辐射源)",
      rangeM: 2.35,
      pathLenM: +(d0 + 2.35).toFixed(2),
      angleDeg: 72,
      db: -11.0,
      confidence: 0.90,
      velocityMs: 0,
      rcs: "small",
    },
  ];

  const last: LastSweep = {
    mode: "single-node",
    twoWay: true,
    sweep: seq,
    t: +t.toFixed(2),
    pairs: 96,
    channelsOk: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
    coherence: 0.985,
    refCorr: 0.912,
    overlaps: [36, 36, 36, 36, 36, 36, 36, 36, 36, 36, 36, 36],
    bins: 245,
    bwMHz: 76.6,
    resM: 1.96,
    music: mus,
    musicPeaks: [
      { r: +d0.toFixed(2), db: -1.2 },
      { r: obj1L, db: -9.4 },
      { r: +walkL.toFixed(2), db: -6.8 },
      { r: obj2L, db: -13.5 },
      { r: obj3L, db: -17.2 },
    ],
    spectrum: spec,
    peaks: [
      { r: +d0.toFixed(2), db: -1.2 },
      { r: obj1L, db: -9.4 },
      { r: +walkL.toFixed(2), db: -6.8 },
      { r: obj2L, db: -13.5 },
      { r: obj3L, db: -17.2 },
    ],
    sense: {
      calibrated: true,
      calN: 12,
      calNeed: 12,
      present: true,
      motion,
      z: +(3.8 + motion * 6).toFixed(2),
      breathBpm: 16.0,
      breathConf: 8.6,
      breathPow: 0.78,
      activeR: +walkL.toFixed(2),
      activeConf: 5.4,
      scan: { bpm: 16.0, r: +walkL.toFixed(2), conf: 8.9 },
      level: moving ? "moving" : "still",
    },
    objects,
    macCount: 4,
    arrive: Date.now() / 1000,
  };
  const nd = (mac: string, modeStr: string): NodeInfo => ({
    online: true,
    age: 0.4,
    uploads: seq,
    recs: seq * 96,
    boots: 0,
    uptimeMs: Math.round(t * 1000),
    dropped: 0,
    info: {
      fw: "11.0.0-demo",
      mode: modeStr,
      mac,
      rssi: "-36",
      ch: "6",
      ip: "172.20.10.3",
      plan: "13",
      macs: "4",
      rst: "poweron",
      last: "none",
      lnk: `sync:${seq}/${seq},probe:${seq * 65},reply:${seq * 64},csi:${seq * 64},data:${seq * 64},stat:${seq},txerr:0`,
      pwr: "15",
    },
  });
  return {
    ok: true,
    seq,
    now: Date.now() / 1000,
    uptime: t,
    plan: 13,
    baselineM: d0,
    rangeMax: R,
    nprof: N,
    singleNode: true,
    nodes: { A: nd("24:6F:28:AA:00:01", "single"), B: nd("24:6F:28:AA:00:01", "single") },
    tunnel: "demo://local",
    tunnels: [{ name: "demo", url: "demo://local", ok: true, ms: 1 }],
    gpu: {
      torch: true,
      cuda: 2,
      devices: ["cuda:0 Tesla T4 15.0GiB (演示)", "cuda:1 Tesla T4 15.0GiB (演示)"],
      cir: "cuda:0",
      music: "cuda:1",
      nfft: 65536,
      cir_ms: 0.9,
      music_ms: 1.8,
      err: "",
      engine: "gpu-fft64k+music+svd+tomography",
      vramHeldMB: [12288, 12288],
      util: [38, 44],
      memUsedMB: [12450, 12520],
      memTotalMB: [15360, 15360],
      ramGB: 14.8,
      ramTotalGB: 30.0,
      ramRingMB: 6144,
      diskFreeGB: 48.2,
      diskTotalGB: 57.6,
    },
    version: "11.0-demo",
    stats: { done: seq, skipped: 0, pending: 0, procMs: 2.7, rawBytes: seq * 14400, rawOn: true },
    last,
    profile: prof,
    rows: [{ seq, t: +t.toFixed(2), sweep: seq, p: prof }],
    errors: {},
    lastError: "",
    syncLossPct: 0.0,
  };
}
