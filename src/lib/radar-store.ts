// WiFi RADAR · Next.js 内置服务端（v7）
// 作用：让本站自己就是一个完整的“雷达服务器”——ESP32 可以直接 POST 到 /api/ingest，网页 3D 世界从 /api/frames 读取，
// 不再依赖 Kaggle 才能显示“真实数据”。接口与 kaggle/wifi_radar_kaggle.py 保持一致（同一份 radar.html 两边通用）。
// 状态保存在进程内存里（globalThis），服务重启后清空；这是实时数据，不需要入库。

export const VERSION = "7.0.0";
export const API_KEY = process.env.RADAR_API_KEY || "radar-key";

type AnyObj = Record<string, unknown>;
export type Frame = AnyObj & { aps: unknown[]; _seq: number; _t: number };
type NodeInfo = { frames: number; aps: number; ip: string; src: string; fw: string; last: number; x: number; y: number };
type CsiSample = [number, number, number, number]; // [t(s), rssi, 平均幅度, 湍流]
export type EventItem = { t: number; lv: string; c: string; m: string };

type Store = {
  t0: number;
  seq: number;
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
  timer: ReturnType<typeof setInterval> | null;
};

const g = globalThis as unknown as { __wradar?: Store };

export function store(): Store {
  if (!g.__wradar) {
    g.__wradar = {
      t0: Date.now() / 1000,
      seq: 0,
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
      timer: null,
    };
    evt("INFO", "server", `WiFi RADAR 内置服务端 v${VERSION} 启动（Next.js）`);
  }
  const s = g.__wradar;
  if (!s.timer) {
    s.timer = setInterval(() => {
      try {
        senseTick();
      } catch (e) {
        evtRate("sense_err", 30, "ERR", "csi", "CSI 分析出错：" + String(e));
      }
    }, 1000);
    (s.timer as unknown as { unref?: () => void }).unref?.();
  }
  return s;
}

export function evt(lv: string, c: string, m: string, t?: number) {
  const s = g.__wradar!;
  s.events.push({ t: t ?? Date.now() / 1000, lv, c, m });
  if (s.events.length > 600) s.events.splice(0, s.events.length - 600);
}

export function evtRate(key: string, secs: number, lv: string, c: string, m: string) {
  const s = g.__wradar!;
  const now = Date.now() / 1000;
  if (now - (s.rate[key] || 0) < secs) return;
  s.rate[key] = now;
  evt(lv, c, m);
}

/** 同源（网页 USB 转发）免密钥；ESP32 直传需要 X-Key / ?key= 与 API_KEY 一致 */
export function authInfo(req: Request) {
  const url = new URL(req.url);
  const key = req.headers.get("x-key") || url.searchParams.get("key");
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || url.host;
  let originHost = "";
  try {
    originHost = new URL(req.headers.get("origin") || "").host;
  } catch {
    originHost = "";
  }
  const same = req.headers.get("sec-fetch-site") === "same-origin" || (originHost !== "" && originHost === host);
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
  return { ok: same || key === API_KEY, same, key, ip };
}

export function cors(h: Record<string, string> = {}) {
  return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Cache-Control": "no-store", ...h };
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
  n.x = Number(f.x) || 0;
  n.y = Number(f.y) || 0;
  n.last = t;
  n.frames += 1;
  n.aps = f.aps.length;
  n.ip = ip;
  n.src = src;
  n.fw = String(f.fw ?? "");
  const ncsi = csiFromFrame(f, t, nid);
  if (n.frames === 1 || n.frames % 20 === 0) {
    const st = Array.isArray(f.st) ? f.st.length : 0;
    evt("OK", "ingest", `收到 ${src} 帧 #${s.seq}：node=${nid} 来自 ${ip} · AP=${f.aps.length} · 设备=${st} · CSI=${ncsi} · 累计 ${n.frames} 帧`);
  }
  return s.seq;
}

function csiFromFrame(f: AnyObj, t: number, nid: string) {
  const s = store();
  const cs = f.cs as { v?: unknown[]; now?: unknown } | undefined;
  if (!cs || !Array.isArray(cs.v)) return 0;
  const nowFw = Number(cs.now);
  if (!Number.isFinite(nowFw)) return 0;
  let last = s.csiLast[nid] ?? -1;
  const first = cs.v[0] as number[] | undefined;
  if (first && first[0] < last - 1000) last = -1;
  const dq = (s.csi[nid] ||= []);
  let n = 0;
  for (const raw of cs.v) {
    const v = raw as number[];
    const fw = Number(v[0]);
    if (!Number.isFinite(fw) || fw <= last) continue;
    const tt = t - (nowFw - fw) / 1000;
    if (dq.length && tt <= dq[dq.length - 1][0]) continue;
    dq.push([tt, Number(v[1]), Number(v[2]) / 10, Number(v[3]) / 1000]);
    last = fw;
    n++;
  }
  s.csiLast[nid] = last;
  trim(dq);
  if (n) {
    s.csiStat.samples += n;
    s.csiStat.from_wifi += n;
    s.csiStat.last = t;
  }
  return n;
}

function trim(dq: CsiSample[]) {
  if (dq.length > 36000) dq.splice(0, dq.length - 36000);
}

export function ingestCsi(node: string, v: unknown[]) {
  const s = store();
  const dq = (s.csi[node] ||= []);
  let n = 0;
  for (const raw of v) {
    const a = raw as number[];
    const tt = Number(a[0]) / 1000;
    if (!Number.isFinite(tt)) continue;
    if (dq.length && tt <= dq[dq.length - 1][0]) continue;
    dq.push([tt, Number(a[1]), Number(a[2]), Number(a[3])]);
    n++;
  }
  trim(dq);
  s.csiStat.batches += 1;
  s.csiStat.samples += n;
  s.csiStat.from_usb += n;
  s.csiStat.last = Date.now() / 1000;
  if (s.csiStat.batches === 1) evt("OK", "csi", `收到第一批 CSI（网页 USB 转发）：node=${node} ${n} 条`);
  return n;
}

/** Goertzel：在 [f0,f1] 扫频，返回 (峰频, 峰/中位数 SNR, 峰幅)。x 为等间隔序列，fs 采样率 */
function band(x: number[], fs: number, f0: number, f1: number): [number, number, number] {
  const n = x.length;
  if (n < 16) return [0, 0, 0];
  const k = n > 120 ? 51 : 11;
  const half = k >> 1;
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + x[i];
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half), b = Math.min(n - 1, i + half);
    const tr = (pre[b + 1] - pre[a]) / (b - a + 1);
    y[i] = (x[i] - tr) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  }
  const amps: number[] = [];
  const freqs: number[] = [];
  for (let f = f0; f <= f1 + 1e-9; f += 0.01) {
    const w = (2 * Math.PI * f) / fs, c = 2 * Math.cos(w);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < n; i++) {
      const s0 = y[i] + c * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    amps.push(Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2)) / n);
    freqs.push(f);
  }
  if (!amps.length) return [0, 0, 0];
  let bi = 0;
  amps.forEach((a, i) => {
    if (a > amps[bi]) bi = i;
  });
  const sorted = [...amps].sort((a, b) => a - b);
  const med = sorted[sorted.length >> 1] || 1e-9;
  return [freqs[bi], amps[bi] / med, amps[bi]];
}

function interp(t: number[], v: number[], tt: number) {
  if (tt <= t[0]) return v[0];
  if (tt >= t[t.length - 1]) return v[v.length - 1];
  let lo = 0, hi = t.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t[mid] <= tt) lo = mid;
    else hi = mid;
  }
  const r = (tt - t[lo]) / (t[hi] - t[lo] || 1);
  return v[lo] + (v[hi] - v[lo]) * r;
}

// Hampel 去野值：只剔除孤立尖峰（与 Kaggle 版 GPU 实现一致）
function hampel(x: number[], k = 7, nsig = 3, floor = 2e-3) {
  const n = x.length;
  if (n < 2 * k + 1) return x;
  const h = k >> 1;
  const med = (a: number[]) => {
    const b = [...a].sort((p, q) => p - q);
    return b[b.length >> 1];
  };
  return x.map((v, i) => {
    const w: number[] = [];
    for (let j = i - h; j <= i + h; j++) w.push(x[Math.min(n - 1, Math.max(0, j))]);
    const m = med(w);
    const mad = med(w.map((a) => Math.abs(a - m))) * 1.4826;
    return Math.abs(v - m) > nsig * Math.max(mad, floor) ? m : v;
  });
}

export function ruleScene(sense: AnyObj | null): string {
  if (!sense) return "";
  const act = String(sense.act);
  if (!sense.present && act === "empty") return "房间无人（静止空场）";
  if (act === "walking") return `检测到有人在走动（运动指数 ${Number(sense.level).toFixed(1)}×）`;
  if (act === "moving") return `检测到有人有小幅动作（运动指数 ${Number(sense.level).toFixed(1)}×）`;
  if (act === "still") return "检测到有人静止" + (Number(sense.breath) ? `，呼吸约 ${Number(sense.breath).toFixed(0)} 次/分` : "");
  return "状态不明";
}

const ACT_TXT: Record<string, string> = { empty: "无人/无明显活动", still: "静止（呼吸级）", moving: "小幅动作", walking: "走动/大幅动作" };

function senseTick() {
  const s = g.__wradar!;
  const now = Date.now() / 1000;
  let best: [string, CsiSample[]] | null = null;
  for (const [nid, dq] of Object.entries(s.csi)) {
    if (dq.length && now - dq[dq.length - 1][0] < 8 && (!best || dq[dq.length - 1][0] > best[1][best[1].length - 1][0])) best = [nid, dq];
  }
  if (!best) {
    s.sense = null;
    return;
  }
  const arr = best[1].slice(-1500).filter((x) => now - x[0] < 45);
  if (arr.length < 20) return;
  const t = arr.map((x) => x[0]), m = arr.map((x) => x[2]), d = hampel(arr.map((x) => x[3]));
  const age = now - t[t.length - 1];
  const mean = (a: number[]) => (a.length ? a.reduce((p, c) => p + c, 0) / a.length : 0);
  const sel = (th: number) => d.filter((_, i) => t[i] > now - th);
  const w2 = sel(2.5), w1 = sel(1.2);
  const mv = mean(w2), mv1 = w1.length ? mean(w1) : mv;
  if (age < 3) {
    s.floor.push(mv1);
    if (s.floor.length > 180) s.floor.shift();
  }
  let floor = 0;
  if (s.floor.length >= 8) {
    const srt = [...s.floor].sort((a, b) => a - b);
    floor = Math.max(0.004, srt[Math.floor(srt.length * 0.2)] * 1.1);
  }
  const level = floor ? mv / floor : 0;
  const dd: number[] = [];
  for (let tt = now - 6; tt < now; tt += 0.05) dd.push(interp(t, d, tt));
  const [dom] = band(dd, 20, 0.5, 8);
  let breath = 0, snr = 0;
  if (t[0] < now - 26 && age < 3) {
    const mm: number[] = [];
    for (let tt = now - 32; tt < now; tt += 0.1) mm.push(interp(t, m, tt));
    const [bf, sn, bp] = band(mm, 10, 0.1, 0.55);
    snr = sn;
    if (sn >= 5 && bp > 0.02) breath = bf * 60;
  }
  const P = s.present;
  if (floor && age < 3) {
    if (!P.on && level > 2.6) {
      P.since = P.since || now;
      if (now - P.since > 0.9) {
        P.on = true;
        P.off = 0;
      }
    } else if (!P.on) P.since = 0;
    if (P.on && level < 1.7) {
      P.off = P.off || now;
      if (now - P.off > 5) {
        P.on = false;
        P.since = 0;
      }
    } else if (P.on) P.off = 0;
  } else if (age >= 3) {
    P.on = false;
    P.since = 0;
  }
  let act: string;
  if (P.on) act = level >= 7 && dom >= 0.5 ? "walking" : level >= 3.5 ? "moving" : breath ? "still" : "moving";
  else if (breath && level < 1.7) act = "still";
  else act = "empty";
  s.sense = {
    node: best[0], n: arr.length, age: +age.toFixed(1), rate: +(w2.length / 2.5).toFixed(1), level: +level.toFixed(2), floor: +floor.toFixed(4),
    present: P.on || act === "still", act, act_txt: ACT_TXT[act], breath: +breath.toFixed(1), snr: +snr.toFixed(2), dom: +dom.toFixed(2),
    gpu: "CPU（Next.js 内置）", t: +now.toFixed(1),
  };
}

export function framesResponse(since: number) {
  const s = store();
  const now = Date.now() / 1000;
  let out: Frame[];
  if (since <= 0 || since > s.seq) {
    const last: Record<string, Frame> = {};
    for (const f of s.frames) last[String(f.node)] = f;
    out = Object.values(last);
  } else out = s.frames.filter((f) => f._seq > since).slice(-60);
  const outAge = out.map((x) => ({ ...x, age: +(now - (x._t || now)).toFixed(1) }));
  const nodes: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s.nodes)) nodes[k] = { frames: v.frames, aps: v.aps, ip: v.ip, age: +(now - v.last).toFixed(1) };
  return {
    seq: s.seq,
    frames: outAge,
    solved: {},
    status: { gpu: ["Next.js 内置服务端"], frames: s.seq, uptime: Math.floor(now - s.t0), public: "", motion: 0, res: "Next.js 内置（无 GPU）", sense: s.sense, ai: { state: "规则（无 GPU）", model: "", scene: ruleScene(s.sense), vram: [] }, nodes },
  };
}

export function serverDiag(nEvents = 80) {
  const s = store();
  const now = Date.now() / 1000;
  const nodes: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s.nodes)) nodes[k] = { frames: v.frames, aps: v.aps, ip: v.ip, src: v.src, fw: v.fw, age: +(now - v.last).toFixed(1) };
  const csiNodes: Record<string, number> = {};
  for (const [k, v] of Object.entries(s.csi)) csiNodes[k] = v.length;
  const mem = process.memoryUsage();
  return {
    version: VERSION, time: new Date().toISOString().replace("T", " ").slice(0, 19), runtime: `node ${process.version}`, python: `node ${process.version}`, uptime: Math.floor(now - s.t0),
    public_url: "", tunnel: {}, frames: s.seq, gpu: ["Next.js 内置服务端（无 GPU）"], res: `RSS ${(mem.rss / 1048576).toFixed(0)}MB heap ${(mem.heapUsed / 1048576).toFixed(0)}MB`,
    torch: null, cuda: false, budgets: {}, series: 0, nodes, solved: 0, motion: 0,
    csi: { ...s.csiStat, nodes: csiNodes, sense: s.sense },
    recent: s.events.slice(-nEvents),
  };
}

export function diagText() {
  const d = serverDiag(400);
  const L = [
    `===== WiFi RADAR 服务端检测日志 v${d.version}（Next.js 内置）=====`,
    `时间: ${d.time}  运行 ${d.uptime}s  ${d.runtime}`,
    `资源: ${d.res}`,
    `总帧数: ${d.frames}  节点: ${JSON.stringify(d.nodes)}`,
    `CSI: ${JSON.stringify(d.csi)}`,
    "",
    "--- 事件 ---",
  ];
  for (const e of d.recent) L.push(`${new Date(e.t * 1000).toISOString().slice(11, 19)} ${e.lv} [${e.c}] ${e.m}`);
  return L.join("\n");
}

export function resetStore() {
  const s = store();
  s.frames = [];
  s.nodes = {};
  s.csi = {};
  s.csiLast = {};
  s.sense = null;
  s.seq = 0;
  s.floor = [];
  evt("INFO", "server", "已清空帧缓存/节点/CSI（/api/reset）");
}
