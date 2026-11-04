// ============================================================================
//  CSI 信号处理引擎（浏览器内运行）
//   · 多信道拼接：13 个 20MHz 信道 × 52 子载波，信道间隔 5MHz = 16 个子载波，共 245 个频点 ≈ 76MHz
//   · 相位对齐：每包去线性相位(STO/CFO) → 双向平均 → 相邻信道重叠区估计 (常数相位 + 斜率) 逐信道链式对齐
//   · 路径长度剖面：对 245 个频点做加窗 IDFT（直接求值，0.25m 步进），直达波锚定在两节点间距
//   · 运动 / 呼吸：来自路由器信道上 100Hz 的连续 CSI 流
// ============================================================================
import type { CsiFrame } from "./protocol";
import { LINK_PEER } from "./protocol";

export const C = 299792458;
export const DF = 312500; // 子载波间隔 Hz
export const NCH = 13;
export const SHIFT = 16; // 相邻信道偏移的子载波数（5MHz / 312.5kHz）
export const NB = SHIFT * (NCH - 1) + 53; // 245
export const KN = 53; // k = -26..26
export const L0 = -6; // 计算窗口起点(m)
export const DL = 0.25;
export const NL = 169; // -6 .. 36 m
export const PAD = 48; // 对齐用的两侧余量（点）
export const DISP0 = 24; // L=0 m 对应索引
export const NDISP = 121; // 0..30 m
export const NT = 48; // 地形历史行数
export const BANDWIDTH_MHZ = ((NB - 1) * DF) / 1e6;
export const RESOLUTION_M = C / ((NB - 1) * DF);

export interface Peak {
  L: number;
  amp: number;
  dyn: number;
  los: boolean;
}

interface ChanAcc {
  re: [Float64Array, Float64Array];
  im: [Float64Array, Float64Array];
  n: [number, number];
}

interface SweepAcc {
  id: number;
  chans: (ChanAcc | undefined)[];
  startedAt: number;
  lastAt: number;
}

export interface SenseState {
  calib: number;
  calibTotal: number;
  calibrated: boolean;
  motion: number; // 0..1
  motionZ: number;
  breathBpm: number;
  breathConf: number;
  fastFps: number;
}

export interface Stats {
  sweeps: number;
  pairs: number;
  lostPct: number;
  chOk: boolean[];
  chUsed: number;
  lastSweepId: number;
  lastSweepAt: number;
  frames: [number, number];
  apFrames: number;
  lastFrameAt: number;
}

const idx = (k: number) => k + 26;
const kOf = (s: number) => (s < 32 ? s : s - 64);

function normalizePacket(f: CsiFrame): { re: Float64Array; im: Float64Array } | null {
  const re = new Float64Array(KN);
  const im = new Float64Array(KN);
  for (let k = -26; k <= 26; k++) {
    if (k === 0) continue;
    const s = k < 0 ? k + 64 : k;
    re[idx(k)] = f.re[s];
    im[idx(k)] = f.im[s];
  }
  // 线性相位斜率：相邻有效子载波的相位差
  let sr = 0;
  let si = 0;
  for (let k = -26; k < 26; k++) {
    if (k === -1 || k === 0) continue;
    const a = idx(k);
    const b = a + 1;
    sr += re[a] * re[b] + im[a] * im[b];
    si += re[a] * im[b] - im[a] * re[b];
  }
  const slope = Math.atan2(si, sr);
  let cr = 0;
  let ci = 0;
  let pw = 0;
  for (let k = -26; k <= 26; k++) {
    if (k === 0) continue;
    const a = idx(k);
    const c = Math.cos(-slope * k);
    const s = Math.sin(-slope * k);
    const r2 = re[a] * c - im[a] * s;
    const i2 = re[a] * s + im[a] * c;
    re[a] = r2;
    im[a] = i2;
    cr += r2;
    ci += i2;
    pw += r2 * r2 + i2 * i2;
  }
  const rms = Math.sqrt(pw / 52);
  const mag = Math.hypot(cr, ci);
  if (rms < 0.5 || mag < 1e-6) return null;
  const pr = cr / mag;
  const pi = -ci / mag; // e^{-j arg(sum)}
  for (let k = -26; k <= 26; k++) {
    if (k === 0) continue;
    const a = idx(k);
    const r2 = (re[a] * pr - im[a] * pi) / rms;
    const i2 = (re[a] * pi + im[a] * pr) / rms;
    re[a] = r2;
    im[a] = i2;
  }
  return { re, im };
}

function argOf(re: number, im: number) {
  return Math.atan2(im, re);
}

/** 估计 b 相对 a 的 (常数相位 φ0, 斜率 δ)，使得 a ≈ b·e^{j(φ0+δ·k_b)}。 */
function estimateAlign(
  aRe: Float64Array,
  aIm: Float64Array,
  bRe: Float64Array,
  bIm: Float64Array,
  shift: number,
): { phi: number; slope: number; n: number } | null {
  // k_b ∈ [-26, 26-shift]，k_a = k_b + shift
  const dRe: number[] = [];
  const dIm: number[] = [];
  const ks: number[] = [];
  for (let kb = -26; kb <= 26 - shift; kb++) {
    const ka = kb + shift;
    if (kb === 0 || ka === 0) continue;
    const ia = idx(ka);
    const ib = idx(kb);
    const r = aRe[ia] * bRe[ib] + aIm[ia] * bIm[ib]; // a * conj(b)
    const i = aIm[ia] * bRe[ib] - aRe[ia] * bIm[ib];
    dRe.push(r);
    dIm.push(i);
    ks.push(kb);
  }
  if (ks.length < 8) return null;
  let sr = 0;
  let si = 0;
  for (let n = 0; n + 1 < ks.length; n++) {
    if (ks[n + 1] !== ks[n] + 1) continue;
    sr += dRe[n + 1] * dRe[n] + dIm[n + 1] * dIm[n];
    si += dIm[n + 1] * dRe[n] - dRe[n + 1] * dIm[n];
  }
  const slope = argOf(sr, si);
  let cr = 0;
  let ci = 0;
  for (let n = 0; n < ks.length; n++) {
    const c = Math.cos(-slope * ks[n]);
    const s = Math.sin(-slope * ks[n]);
    cr += dRe[n] * c - dIm[n] * s;
    ci += dRe[n] * s + dIm[n] * c;
  }
  return { phi: argOf(cr, ci), slope, n: ks.length };
}

export interface StitchResult {
  xr: Float64Array;
  xi: Float64Array;
  w: Float64Array;
  used: boolean[];
  nUsed: number;
  pairs: number;
}

export function stitchChannels(chans: (ChanAcc | undefined)[]): StitchResult {
  const xr = new Float64Array(NB);
  const xi = new Float64Array(NB);
  const w = new Float64Array(NB);
  const used: boolean[] = new Array(NCH).fill(false);
  const alR: (Float64Array | null)[] = new Array(NCH).fill(null);
  const alI: (Float64Array | null)[] = new Array(NCH).fill(null);
  let nUsed = 0;
  let pairs = 0;
  for (let c = 0; c < NCH; c++) {
    const acc = chans[c];
    if (!acc || (acc.n[0] === 0 && acc.n[1] === 0)) continue;
    const mA = acc.n[0] > 0 ? [acc.re[0].map((v) => v / acc.n[0]), acc.im[0].map((v) => v / acc.n[0])] : null;
    const mB = acc.n[1] > 0 ? [acc.re[1].map((v) => v / acc.n[1]), acc.im[1].map((v) => v / acc.n[1])] : null;
    let vr: Float64Array;
    let vi: Float64Array;
    if (mA && mB) {
      // 双向：把 B 的常数相位 + 斜率对齐到 A，再平均（互易性：两个方向信道相同）
      const al = estimateAlign(mA[0], mA[1], mB[0], mB[1], 0);
      vr = new Float64Array(KN);
      vi = new Float64Array(KN);
      const phi = al ? al.phi : 0;
      const sl = al ? al.slope : 0;
      for (let k = -26; k <= 26; k++) {
        if (k === 0) continue;
        const a = idx(k);
        const ang = phi + sl * k;
        const cs = Math.cos(ang);
        const sn = Math.sin(ang);
        const br = mB[0][a] * cs - mB[1][a] * sn;
        const bi = mB[0][a] * sn + mB[1][a] * cs;
        vr[a] = 0.5 * (mA[0][a] + br);
        vi[a] = 0.5 * (mA[1][a] + bi);
      }
      pairs++;
    } else {
      const m = (mA ?? mB)!;
      vr = Float64Array.from(m[0]);
      vi = Float64Array.from(m[1]);
    }
    // 与最近的已对齐信道链式对齐
    let ref = -1;
    for (let p = c - 1; p >= Math.max(0, c - 3); p--) {
      if (alR[p]) {
        ref = p;
        break;
      }
    }
    if (ref >= 0) {
      const shift = SHIFT * (c - ref);
      const al = estimateAlign(alR[ref]!, alI[ref]!, vr, vi, shift);
      if (!al) continue;
      for (let k = -26; k <= 26; k++) {
        if (k === 0) continue;
        const a = idx(k);
        const ang = al.phi + al.slope * k;
        const cs = Math.cos(ang);
        const sn = Math.sin(ang);
        const r2 = vr[a] * cs - vi[a] * sn;
        const i2 = vr[a] * sn + vi[a] * cs;
        vr[a] = r2;
        vi[a] = i2;
      }
    } else if (nUsed > 0) {
      continue; // 离已对齐信道太远，无法对齐
    }
    alR[c] = vr;
    alI[c] = vi;
    used[c] = true;
    nUsed++;
    for (let k = -26; k <= 26; k++) {
      if (k === 0) continue;
      const m = SHIFT * c + idx(k);
      const wt = Math.abs(k) <= 22 ? 1 : 0.5;
      xr[m] += wt * vr[idx(k)];
      xi[m] += wt * vi[idx(k)];
      w[m] += wt;
    }
  }
  for (let m = 0; m < NB; m++) {
    if (w[m] > 0) {
      xr[m] /= w[m];
      xi[m] /= w[m];
    }
  }
  return { xr, xi, w, used, nUsed, pairs };
}

// 预计算 IDFT 的余弦/正弦表：ext 网格 G = NL + 2*PAD 个距离点 × NB 个频点
const G = NL + 2 * PAD;
let cosT: Float32Array | null = null;
let sinT: Float32Array | null = null;
let hann: Float64Array | null = null;
function ensureTables() {
  if (cosT && sinT && hann) return;
  cosT = new Float32Array(G * NB);
  sinT = new Float32Array(G * NB);
  hann = new Float64Array(NB);
  // Tukey 窗（α=0.35）：主瓣比 Hann 窄，能分开相距更近的反射体，旁瓣仍低于约 -17dB
  const alpha = 0.35;
  const edge = (alpha * NB) / 2;
  for (let m = 0; m < NB; m++) {
    const x = m + 0.5;
    if (x < edge) hann[m] = 0.5 - 0.5 * Math.cos((Math.PI * x) / edge);
    else if (x > NB - edge) hann[m] = 0.5 - 0.5 * Math.cos((Math.PI * (NB - x)) / edge);
    else hann[m] = 1;
  }
  for (let g = 0; g < G; g++) {
    const L = L0 + (g - PAD) * DL;
    const tau = L / C;
    for (let m = 0; m < NB; m++) {
      const th = 2 * Math.PI * m * DF * tau;
      cosT[g * NB + m] = Math.cos(th);
      sinT[g * NB + m] = Math.sin(th);
    }
  }
}

export interface ExtProfile {
  mag: Float32Array;
  re: Float64Array;
  im: Float64Array;
  wts: Float64Array;
  ws: number;
}

export function extendedProfile(xr: Float64Array, xi: Float64Array, w: Float64Array): ExtProfile {
  ensureTables();
  const mag = new Float32Array(G);
  const re = new Float64Array(G);
  const im = new Float64Array(G);
  const wr = new Float64Array(NB);
  const wi = new Float64Array(NB);
  const wts = new Float64Array(NB);
  let ws = 0;
  for (let m = 0; m < NB; m++) {
    const wt = hann![m] * Math.min(1, w[m]);
    wts[m] = wt;
    wr[m] = xr[m] * wt;
    wi[m] = xi[m] * wt;
    ws += wt;
  }
  if (ws < 1e-9) return { mag, re, im, wts, ws: 1 };
  for (let g = 0; g < G; g++) {
    let sr = 0;
    let si = 0;
    const o = g * NB;
    for (let m = 0; m < NB; m++) {
      const c = cosT![o + m];
      const s = sinT![o + m];
      sr += wr[m] * c - wi[m] * s;
      si += wr[m] * s + wi[m] * c;
    }
    re[g] = sr / ws;
    im[g] = si / ws;
    mag[g] = Math.hypot(re[g], im[g]);
  }
  return { mag, re, im, wts, ws };
}

export interface CleanComp {
  g: number; // ext 网格索引
  a: number; // 复幅度模
}

/**
 * CLEAN 反卷积（复数域）：反复找最强点 → 减去它的点扩散函数(PSF)。
 * 作用：把"挤在直达波主瓣肩膀上"的弱反射体分离出来（单纯看幅度剖面会漏检）。
 */
export function cleanComponents(e: ExtProfile, lo: number, hi: number, maxIter = 7, stopRatio = 0.25): CleanComp[] {
  const res = { re: Float64Array.from(e.re), im: Float64Array.from(e.im) };
  const psfN = G;
  // psf[Δ] = Σ w_m e^{j2π m DF Δ DL / C} / ws， Δ ∈ [-(G-1), G-1]
  const pr = new Float64Array(2 * psfN - 1);
  const pi = new Float64Array(2 * psfN - 1);
  const k0 = (2 * Math.PI * DF * DL) / C;
  for (let d = -(psfN - 1); d <= psfN - 1; d++) {
    let sr = 0;
    let si = 0;
    for (let m = 0; m < NB; m++) {
      const th = k0 * m * d;
      sr += e.wts[m] * Math.cos(th);
      si += e.wts[m] * Math.sin(th);
    }
    pr[d + psfN - 1] = sr / e.ws;
    pi[d + psfN - 1] = si / e.ws;
  }
  const comps: CleanComp[] = [];
  let first = 0;
  for (let it = 0; it < maxIter; it++) {
    let bg = -1;
    let bv = 0;
    for (let g = lo; g < hi; g++) {
      const v = Math.hypot(res.re[g], res.im[g]);
      if (v > bv) {
        bv = v;
        bg = g;
      }
    }
    if (bg < 0) break;
    if (it === 0) first = bv;
    else if (bv < stopRatio * first) break;
    const ar = res.re[bg];
    const ai = res.im[bg];
    const p0r = pr[psfN - 1];
    const p0i = pi[psfN - 1];
    // 复幅度 a = res[bg] / psf[0]
    const den = p0r * p0r + p0i * p0i || 1;
    const cr = (ar * p0r + ai * p0i) / den;
    const ci = (ai * p0r - ar * p0i) / den;
    const gain = 0.9;
    for (let g = 0; g < G; g++) {
      const di = g - bg + psfN - 1;
      res.re[g] -= gain * (cr * pr[di] - ci * pi[di]);
      res.im[g] -= gain * (cr * pi[di] + ci * pr[di]);
    }
    const ex = comps.find((c) => Math.abs(c.g - bg) <= 1);
    if (ex) ex.a += gain * Math.hypot(cr, ci);
    else comps.push({ g: bg, a: gain * Math.hypot(cr, ci) });
  }
  return comps;
}

export class RadarEngine {
  baseline = 3;

  // ---- 剖面结果
  profile = new Float32Array(NDISP); // 0..30m，归一化 0..1
  dyn = new Float32Array(NDISP);
  peaks: Peak[] = [];
  spectrum = new Float32Array(NB);
  spectrumCh = new Uint8Array(NB);
  rows: Float32Array[] = [];
  rowDyn: Float32Array[] = [];
  version = 0;
  sweepSerial = 0;

  stats: Stats = {
    sweeps: 0,
    pairs: 0,
    lostPct: 0,
    chOk: new Array(NCH).fill(false),
    chUsed: 0,
    lastSweepId: 0,
    lastSweepAt: 0,
    frames: [0, 0],
    apFrames: 0,
    lastFrameAt: 0,
  };
  sense: SenseState = {
    calib: 0,
    calibTotal: 24,
    calibrated: false,
    motion: 0,
    motionZ: 0,
    breathBpm: 0,
    breathConf: 0,
    fastFps: 0,
  };

  private sweeps = new Map<number, SweepAcc>();
  private anchor: number | null = null;
  private ref: Float32Array | null = null;
  private bg: Float32Array | null = null;
  private bgN = 0;
  private pmax = 1e-6;
  private slotTotal = 0;
  private slotLost = 0;

  // ---- 快速流
  private ema: (Float64Array | null)[] = [null, null];
  private mEma = [0, 0];
  private mInst = [0, 0];
  private calibVals: number[] = [];
  private mu = 0;
  private sigma = 1;
  private lastTick = 0;
  private fastCount = 0;
  private fastCountAt = 0;
  private bSeries: number[] = [];
  private bAcc = 0;
  private bN = 0;
  private bBinAt = 0;
  private lastBreathAt = 0;
  private motionSm = 0;

  resetCalibration() {
    this.calibVals = [];
    this.sense.calib = 0;
    this.sense.calibrated = false;
    this.sense.motion = 0;
    this.sense.motionZ = 0;
    this.sense.breathBpm = 0;
    this.sense.breathConf = 0;
    this.bSeries = [];
    this.ema = [null, null];
    this.bg = null;
    this.bgN = 0;
  }

  resetAll() {
    this.resetCalibration();
    this.sweeps.clear();
    this.anchor = null;
    this.ref = null;
    this.pmax = 1e-6;
    this.rows = [];
    this.rowDyn = [];
    this.profile.fill(0);
    this.dyn.fill(0);
    this.peaks = [];
    this.stats.sweeps = 0;
    this.stats.pairs = 0;
    this.slotTotal = 0;
    this.slotLost = 0;
    this.stats.lostPct = 0;
    this.version++;
  }

  setBaseline(d: number) {
    if (Math.abs(d - this.baseline) > 1e-6) {
      this.baseline = d;
      this.anchor = null; // 重新锚定直达波
      this.ref = null;
    }
  }

  pushFrame(f: CsiFrame, now: number) {
    this.stats.lastFrameAt = now;
    if (f.link !== LINK_PEER) {
      this.stats.apFrames++;
      return;
    }
    this.stats.frames[f.node - 1]++;
    if (f.ch < 1 || f.ch > NCH) return;
    const nv = normalizePacket(f);
    if (f.sweepId > 0) {
      if (!nv) return;
      let sw = this.sweeps.get(f.sweepId);
      if (!sw) {
        sw = { id: f.sweepId, chans: new Array(NCH).fill(undefined), startedAt: now, lastAt: now };
        this.sweeps.set(f.sweepId, sw);
      }
      sw.lastAt = now;
      let acc = sw.chans[f.ch - 1];
      if (!acc) {
        acc = {
          re: [new Float64Array(KN), new Float64Array(KN)],
          im: [new Float64Array(KN), new Float64Array(KN)],
          n: [0, 0],
        };
        sw.chans[f.ch - 1] = acc;
      }
      const d = f.node - 1;
      for (let i = 0; i < KN; i++) {
        acc.re[d][i] += nv.re[i];
        acc.im[d][i] += nv.im[i];
      }
      acc.n[d]++;
    } else {
      this.pushFast(f, nv, now);
    }
  }

  tick(now: number) {
    for (const [id, sw] of this.sweeps) {
      let complete = true;
      for (let c = 0; c < NCH; c++) {
        const a = sw.chans[c];
        if (!a || a.n[0] === 0 || a.n[1] === 0) {
          complete = false;
          break;
        }
      }
      if (complete || now - sw.lastAt > 1000) {
        this.sweeps.delete(id);
        this.finalize(sw, now);
      }
    }
    if (now - this.lastTick >= 250) {
      this.lastTick = now;
      this.senseTick(now);
    }
  }

  // ------------------------------------------------------------------ 快速流（运动 / 呼吸）
  private pushFast(f: CsiFrame, nv: { re: Float64Array; im: Float64Array } | null, now: number) {
    if (!nv) return;
    this.fastCount++;
    if (now - this.fastCountAt >= 1000) {
      this.sense.fastFps = (this.fastCount * 1000) / Math.max(1, now - this.fastCountAt);
      this.fastCount = 0;
      this.fastCountAt = now;
    }
    const d = f.node - 1;
    const amp = new Float64Array(KN);
    let rawSum = 0;
    for (let k = -26; k <= 26; k++) {
      if (k === 0) continue;
      amp[idx(k)] = Math.hypot(nv.re[idx(k)], nv.im[idx(k)]);
      const s = k < 0 ? k + 64 : k;
      rawSum += Math.hypot(f.re[s], f.im[s]);
    }
    let e = this.ema[d];
    if (!e) {
      this.ema[d] = Float64Array.from(amp);
      return;
    }
    let diff = 0;
    for (let i = 0; i < KN; i++) {
      if (i === idx(0)) continue;
      diff += Math.abs(amp[i] - e[i]);
      e[i] += 0.04 * (amp[i] - e[i]);
    }
    diff /= 52;
    this.mInst[d] = diff;
    this.mEma[d] += 0.08 * (diff - this.mEma[d]);
    // 呼吸用原始幅度：100ms 一格
    this.bAcc += rawSum / 52;
    this.bN++;
    if (now - this.bBinAt >= 100) {
      if (this.bN > 0) {
        this.bSeries.push(this.bAcc / this.bN);
        if (this.bSeries.length > 300) this.bSeries.shift();
      }
      this.bAcc = 0;
      this.bN = 0;
      this.bBinAt = now;
    }
    e = null;
  }

  private senseTick(now: number) {
    const s = this.sense;
    const active = now - this.stats.lastFrameAt < 1500 && (this.mEma[0] > 0 || this.mEma[1] > 0);
    if (!active) {
      s.motion *= 0.9;
      return;
    }
    const m = Math.max(this.mEma[0], this.mEma[1]);
    if (!s.calibrated) {
      this.calibVals.push(m);
      s.calib = this.calibVals.length;
      if (this.calibVals.length >= s.calibTotal) {
        const v = this.calibVals;
        const mean = v.reduce((a, b) => a + b, 0) / v.length;
        const varr = v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length;
        this.mu = mean;
        this.sigma = Math.max(Math.sqrt(varr), 0.004, mean * 0.08);
        s.calibrated = true;
      }
      return;
    }
    const z = (m - this.mu) / this.sigma;
    s.motionZ = z;
    const target = Math.max(0, Math.min(1, (z - 1.5) / 9));
    this.motionSm += 0.35 * (target - this.motionSm);
    s.motion = this.motionSm;
    if (now - this.lastBreathAt >= 1000) {
      this.lastBreathAt = now;
      this.breath();
    }
  }

  private breath() {
    const s = this.sense;
    const x = this.bSeries;
    const n = x.length;
    if (n < 150 || s.motion > 0.35) {
      s.breathConf *= 0.8;
      if (s.breathConf < 0.2) s.breathBpm = 0;
      return;
    }
    const mean = x.reduce((a, b) => a + b, 0) / n;
    // 去线性趋势
    let sxx = 0;
    let sxy = 0;
    for (let i = 0; i < n; i++) {
      const dx = i - (n - 1) / 2;
      sxx += dx * dx;
      sxy += dx * (x[i] - mean);
    }
    const slope = sxy / sxx;
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const dx = i - (n - 1) / 2;
      y[i] = (x[i] - mean - slope * dx) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
    }
    let best = 0;
    let bestF = 0;
    let sum = 0;
    let cnt = 0;
    for (let f = 0.1; f <= 0.5001; f += 0.01) {
      let re = 0;
      let im = 0;
      for (let i = 0; i < n; i++) {
        const th = 2 * Math.PI * f * i * 0.1;
        re += y[i] * Math.cos(th);
        im += y[i] * Math.sin(th);
      }
      const p = Math.hypot(re, im);
      sum += p;
      cnt++;
      if (p > best) {
        best = p;
        bestF = f;
      }
    }
    const ratio = best / Math.max(1e-9, sum / cnt);
    const conf = Math.max(0, Math.min(1, (ratio - 1.8) / 3));
    s.breathConf += 0.4 * (conf - s.breathConf);
    if (s.breathConf > 0.35) s.breathBpm = bestF * 60;
    else if (s.breathConf < 0.2) s.breathBpm = 0;
  }

  // ------------------------------------------------------------------ 一轮扫频 → 剖面
  private finalize(sw: SweepAcc, now: number) {
    const st = this.stats;
    this.slotTotal += NCH;
    let both = 0;
    const chOk: boolean[] = [];
    for (let c = 0; c < NCH; c++) {
      const a = sw.chans[c];
      const ok = !!a && a.n[0] > 0 && a.n[1] > 0;
      chOk.push(ok);
      if (ok) both++;
    }
    this.slotLost += NCH - both;
    st.chOk = chOk;
    st.lastSweepId = sw.id;
    st.lostPct = (100 * this.slotLost) / Math.max(1, this.slotTotal);
    const stitched = stitchChannels(sw.chans);
    st.pairs += stitched.pairs;
    st.chUsed = stitched.nUsed;
    if (stitched.nUsed < 4) return;

    const extP = extendedProfile(stitched.xr, stitched.xi, stitched.w);
    const ext = extP.mag;
    const target = PAD + Math.round((this.baseline - L0) / DL);
    if (this.anchor === null || !this.ref) {
      let gi = 0;
      let gv = -1;
      for (let g = PAD; g < ext.length - PAD / 2; g++) {
        if (ext[g] > gv) {
          gv = ext[g];
          gi = g;
        }
      }
      this.anchor = gi - target;
    } else {
      let bestA = this.anchor;
      let bestV = -1;
      for (let a = this.anchor - 8; a <= this.anchor + 8; a++) {
        let v = 0;
        for (let j = 0; j < NL; j++) {
          const g = j + PAD + a;
          if (g < 0 || g >= ext.length) continue;
          v += ext[g] * this.ref[j];
        }
        if (v > bestV) {
          bestV = v;
          bestA = a;
        }
      }
      this.anchor = bestA;
    }
    const p = new Float32Array(NL);
    for (let j = 0; j < NL; j++) {
      const g = j + PAD + this.anchor;
      p[j] = g >= 0 && g < ext.length ? ext[g] : 0;
    }
    if (!this.ref) this.ref = Float32Array.from(p);
    else for (let j = 0; j < NL; j++) this.ref[j] = 0.85 * this.ref[j] + 0.15 * p[j];

    let mx = 0;
    for (let j = DISP0; j < DISP0 + NDISP; j++) mx = Math.max(mx, p[j]);
    this.pmax = Math.max(mx, this.pmax * 0.985);
    // 动态分量：与慢速背景的差
    if (!this.bg) {
      this.bg = Float32Array.from(p);
      this.bgN = 1;
    }
    const prof = new Float32Array(NDISP);
    const dyn = new Float32Array(NDISP);
    const warm = this.bgN >= 3;
    for (let j = 0; j < NDISP; j++) {
      const v = p[j + DISP0];
      prof[j] = Math.min(1, v / this.pmax);
      dyn[j] = warm ? Math.min(1, Math.abs(v - this.bg[j + DISP0]) / this.pmax) : 0;
    }
    for (let j = 0; j < NL; j++) this.bg[j] += (this.bgN < 6 ? 0.3 : 0.06) * (p[j] - this.bg[j]);
    this.bgN++;

    this.profile = prof;
    this.dyn = dyn;
    const aOff = this.anchor ?? 0;
    const comps = cleanComponents(extP, Math.max(0, PAD + aOff), Math.min(G, PAD + aOff + NL));
    this.peaks = componentsToPeaks(comps, aOff, dyn, this.baseline);
    this.rows.push(prof);
    this.rowDyn.push(dyn);
    if (this.rows.length > NT) {
      this.rows.shift();
      this.rowDyn.shift();
    }
    // 频谱柱状图
    for (let m = 0; m < NB; m++) {
      this.spectrum[m] = Math.hypot(stitched.xr[m], stitched.xi[m]);
      this.spectrumCh[m] = Math.min(NCH - 1, Math.floor(m / SHIFT));
    }
    st.sweeps++;
    st.lastSweepAt = now;
    this.sweepSerial = st.sweeps;
    this.version++;
  }
}

export function componentsToPeaks(comps: CleanComp[], anchor: number, dyn: Float32Array, baseline: number): Peak[] {
  let mx = 0;
  for (const c of comps) mx = Math.max(mx, c.a);
  if (mx <= 0) return [];
  const out: Peak[] = [];
  for (const c of comps) {
    const j = c.g - PAD - anchor; // 窗口内索引
    const L = L0 + j * DL;
    if (L < 0 || L > 30) continue;
    const di = Math.round(L / DL);
    let d = 0;
    for (let k = Math.max(0, di - 3); k <= Math.min(NDISP - 1, di + 3); k++) d = Math.max(d, dyn[k]);
    out.push({ L, amp: c.a / mx, dyn: d, los: Math.abs(L - baseline) < RESOLUTION_M * 0.5 });
  }
  out.sort((x, y) => y.amp - x.amp);
  return out.slice(0, 7);
}

export function findPeaks(prof: Float32Array, dyn: Float32Array, baseline: number): Peak[] {
  const out: Peak[] = [];
  const n = prof.length;
  const sm = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = prof[Math.max(0, i - 1)];
    const b = prof[i];
    const c = prof[Math.min(n - 1, i + 1)];
    sm[i] = 0.25 * a + 0.5 * b + 0.25 * c;
  }
  let mx = 0;
  for (let i = 0; i < n; i++) mx = Math.max(mx, sm[i]);
  const thr = Math.max(0.12, 0.15 * mx);
  const minSep = Math.round(RESOLUTION_M / DL / 2);
  for (let i = 1; i < n - 1; i++) {
    if (sm[i] >= thr && sm[i] > sm[i - 1] && sm[i] >= sm[i + 1]) {
      const a = sm[i - 1];
      const b = sm[i];
      const c = sm[i + 1];
      const den = a - 2 * b + c;
      const off = den !== 0 ? (0.5 * (a - c)) / den : 0;
      const L = (i + off) * DL;
      let d = 0;
      for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) d = Math.max(d, dyn[j]);
      out.push({ L, amp: b, dyn: d, los: Math.abs(L - baseline) < RESOLUTION_M * 0.45 });
    }
  }
  out.sort((x, y) => y.amp - x.amp);
  const keep: Peak[] = [];
  for (const p of out) {
    if (keep.every((q) => Math.abs(q.L - p.L) >= minSep * DL)) keep.push(p);
    if (keep.length >= 7) break;
  }
  return keep;
}

export { kOf };
