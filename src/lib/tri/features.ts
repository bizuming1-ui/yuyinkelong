// 每个接收端（B / C）独立处理 CSI → 运动特征（提示词 6.2 / 6.4：先独立分析，再做非相干特征级融合）。
// 只使用「幅度」类特征：不同 ESP32 的本振/相位并不相干，且每个包都有随机的 CFO/SFO 相位项，
// 所以不做跨板相位运算，也不对单包做线性相位拟合/删除。
//
// 三个特征（AGC 增益变化只影响第三个，所以前两个更可靠）：
//   turb : 相邻包「归一化形状」的平均绝对差（子载波湍流）—— 快速运动
//   dev  : 1 − Pearson(形状, 慢背景形状) —— 偏离静态背景（行走/大幅动作）
//   pow  : |总功率(dB) − 慢滑动均值| —— 路径遮挡/接近
// 噪声底全自适应：取最近 90 秒窗口特征的 q10/q40 分位数估计 μ 与 σ（对「有人活动」这种向上的污染稳健），无需手动校准。
import { NVALID, VALID_IDX } from "./config";
import type { TriFrame } from "./protocol";

export const WIN_MS = 200; // 特征窗口
export const HIST_N = 450; // 450 × 0.2s = 90s
export const MIN_CAL = 40; // 至少 8 秒数据才输出结果

function quantile(sorted: Float32Array, n: number, q: number) {
  if (n <= 0) return 0;
  const p = (n - 1) * q;
  const i = Math.floor(p);
  const f = p - i;
  return i + 1 < n ? sorted[i] * (1 - f) + sorted[i + 1] * f : sorted[i];
}

export interface LinkMetrics {
  node: number;
  valid: boolean; // 已完成自适应校准
  calib: number; // 0..1 校准进度
  z: number; // 融合后的运动 z 分数（≥0，约 3 以上=显著）
  act: number; // 平滑后的显示用分数（快攻慢降）
  zf: [number, number, number];
  rate: number; // 近 2 秒有效 CSI 包率 /s
  pairedPct: number; // 近 2 秒与 A 序列号配对的比例 0..1
  rssi: number;
  lossPct: number; // 由 rxCnt 间断推算的包缺失比例（板内丢弃）
  lastAt: number;
  boot: number;
  win: number; // 特征窗口序号（每产生一个新的有效窗口 +1；用于「每个观测只融合一次」）
}

export class LinkAnalyzer {
  readonly node: number;
  private prev = new Float32Array(NVALID);
  private bg = new Float32Array(NVALID);
  private hasPrev = false;
  private hasBg = false;
  private pEma = 0;
  private pInit = false;
  // 窗口累加
  private aT = 0;
  private aD = 0;
  private aP = 0;
  private aN = 0;
  // 历史
  private h = [new Float32Array(HIST_N), new Float32Array(HIST_N), new Float32Array(HIST_N)];
  private hN = 0;
  private hI = 0;
  private tmp = new Float32Array(HIST_N);
  private mu = [0, 0, 0];
  private sg = [1, 1, 1];
  private lastTick = 0;
  // 速率
  private stamps: number[] = [];
  private pairedStamps: number[] = [];
  private lastCnt = -1;
  private cntSeen = 0;
  private cntLost = 0;
  private boot = -1;
  private s = new Float32Array(NVALID);
  m: LinkMetrics;

  constructor(node: number) {
    this.node = node;
    this.m = { node, valid: false, calib: 0, z: 0, act: 0, zf: [0, 0, 0], rate: 0, pairedPct: 0, rssi: 0, lossPct: 0, lastAt: 0, boot: 0, win: 0 };
  }

  reset() {
    this.hasPrev = this.hasBg = this.pInit = false;
    this.hN = this.hI = 0;
    this.aN = 0;
    this.lastCnt = -1;
    this.m = { ...this.m, valid: false, calib: 0, z: 0, act: 0, zf: [0, 0, 0] };
  }

  pushFrame(f: TriFrame, now: number) {
    if (f.boot !== this.boot) {
      // 设备重启：旧的相邻包关系作废，但保留自适应噪声底（环境没变）
      this.boot = f.boot;
      this.hasPrev = false;
      this.lastCnt = -1;
    }
    // 丢包统计（回调计数连续性）
    if (this.lastCnt >= 0) {
      const gap = (f.rxCnt - this.lastCnt) & 0xffff;
      if (gap >= 1 && gap < 1000) {
        this.cntSeen += 1;
        this.cntLost += gap - 1;
      }
    }
    this.lastCnt = f.rxCnt;
    if (this.cntSeen + this.cntLost > 2000) {
      this.cntSeen *= 0.5;
      this.cntLost *= 0.5;
    }
    this.stamps.push(now);
    if (f.paired) this.pairedStamps.push(now);
    this.m.rssi = f.rssi;
    this.m.lastAt = now;
    this.m.boot = f.boot;

    // 幅度与总功率
    let sum = 0;
    const amp = this.s;
    for (let i = 0; i < NVALID; i++) {
      const k = VALID_IDX[i];
      const a = Math.hypot(f.re[k], f.im[k]);
      amp[i] = a;
      sum += a;
    }
    const mean = sum / NVALID;
    if (mean < 0.8) return; // 全零/饱和异常包
    const inv = 1 / mean;
    for (let i = 0; i < NVALID; i++) amp[i] *= inv; // → 归一化形状
    const pdb = 20 * Math.log10(mean);

    // turb
    let turb = 0;
    if (this.hasPrev) {
      for (let i = 0; i < NVALID; i++) turb += Math.abs(amp[i] - this.prev[i]);
      turb = Math.min(1, turb / NVALID);
    }
    // dev
    let dev = 0;
    if (this.hasBg) {
      let ma = 0;
      let mb = 0;
      for (let i = 0; i < NVALID; i++) {
        ma += amp[i];
        mb += this.bg[i];
      }
      ma /= NVALID;
      mb /= NVALID;
      let sab = 0;
      let saa = 0;
      let sbb = 0;
      for (let i = 0; i < NVALID; i++) {
        const da = amp[i] - ma;
        const db = this.bg[i] - mb;
        sab += da * db;
        saa += da * da;
        sbb += db * db;
      }
      const c = sab / Math.sqrt(saa * sbb + 1e-12);
      dev = Math.max(0, 1 - c);
      const al = 0.004;
      for (let i = 0; i < NVALID; i++) this.bg[i] += al * (amp[i] - this.bg[i]);
    } else {
      this.bg.set(amp);
      this.hasBg = true;
    }
    // pow
    let pw = 0;
    if (this.pInit) {
      pw = Math.min(6, Math.abs(pdb - this.pEma));
      this.pEma += 0.02 * (pdb - this.pEma);
    } else {
      this.pEma = pdb;
      this.pInit = true;
    }
    this.prev.set(amp);
    this.hasPrev = true;
    this.aT += turb;
    this.aD += dev;
    this.aP += pw;
    this.aN++;
  }

  /** 每 ~200ms 调用一次；返回最新指标 */
  tick(now: number): LinkMetrics {
    // 包率
    const cut = now - 2000;
    while (this.stamps.length && this.stamps[0] < cut) this.stamps.shift();
    while (this.pairedStamps.length && this.pairedStamps[0] < cut) this.pairedStamps.shift();
    this.m.rate = this.stamps.length / 2;
    this.m.pairedPct = this.stamps.length ? Math.min(1, this.pairedStamps.length / this.stamps.length) : 0;
    this.m.lossPct = this.cntSeen + this.cntLost > 20 ? this.cntLost / (this.cntSeen + this.cntLost) : 0;

    if (now - this.lastTick < WIN_MS * 0.9) return this.m;
    this.lastTick = now;
    if (this.aN < 3 || now - this.m.lastAt > 1500) {
      // 数据不足 / 链路中断：分数快速衰减，不输出貌似可信的结果
      this.m.act *= 0.8;
      this.m.z *= 0.5;
      this.aT = this.aD = this.aP = 0;
      this.aN = 0;
      return this.m;
    }
    const x = [this.aT / this.aN, this.aD / this.aN, this.aP / this.aN];
    this.aT = this.aD = this.aP = 0;
    this.aN = 0;

    // 估计噪声底（用当前窗口之前的历史）
    this.m.calib = Math.min(1, this.hN / MIN_CAL);
    if (this.hN >= MIN_CAL) {
      for (let f = 0; f < 3; f++) {
        this.tmp.set(this.h[f].subarray(0, this.hN));
        const view = this.tmp.subarray(0, this.hN);
        view.sort();
        const q10 = quantile(this.tmp, this.hN, 0.1);
        const q40 = quantile(this.tmp, this.hN, 0.4);
        const sigma0 = (q40 - q10) / 1.0286;
        const mu = q40 + 0.2533 * sigma0;
        this.mu[f] = mu;
        this.sg[f] = Math.max(sigma0, 0.1 * mu, 1e-4);
      }
      const zf: [number, number, number] = [0, 0, 0];
      for (let f = 0; f < 3; f++) zf[f] = Math.max(0, (x[f] - this.mu[f]) / this.sg[f]);
      const sorted = [...zf].sort((a, b) => b - a);
      const z = (sorted[0] + sorted[1]) / 2;
      this.m.zf = zf;
      this.m.z = Math.min(60, z);
      this.m.valid = true;
      this.m.win++;
      this.m.act = Math.max(this.m.z, this.m.act * 0.9);
    } else {
      this.m.valid = false;
    }
    // 写入历史（正在运动的窗口也写入：分位数对其稳健；极端值截断防止污染）
    const cap = this.hN >= MIN_CAL ? [this.mu[0] + 12 * this.sg[0], this.mu[1] + 12 * this.sg[1], this.mu[2] + 12 * this.sg[2]] : [9, 9, 9];
    for (let f = 0; f < 3; f++) this.h[f][this.hI] = Math.min(x[f], cap[f]);
    this.hI = (this.hI + 1) % HIST_N;
    this.hN = Math.min(HIST_N, this.hN + 1);
    // 环形缓冲在写满后顺序无关（只用分位数），但 subarray(0,hN) 需要整块有效：写满后 hN=HIST_N 即整块
    return this.m;
  }
}

// ----------------------------------------------------------------------------------------------
export type Presence = "calibrating" | "offline" | "empty" | "motion";

export interface Fused {
  state: Presence;
  S: number; // 融合分数
  conf: number; // 0..1 置信度（仅表示「检测」的可靠程度，不是定位精度）
  quality: number; // 数据质量 0..1（包率/配对率/在线）
  reason: string;
}

export class FusedDetector {
  sens = 1;
  private onCnt = 0;
  private offAt = 0;
  private active = false;
  last: Fused = { state: "offline", S: 0, conf: 0, quality: 0, reason: "等待数据" };

  reset() {
    this.active = false;
    this.onCnt = 0;
  }

  update(b: LinkMetrics, c: LinkMetrics, now: number): Fused {
    const live = [b, c].filter((m) => now - m.lastAt < 2000 && m.rate >= 5);
    if (live.length === 0) {
      this.active = false;
      this.onCnt = 0;
      return (this.last = { state: "offline", S: 0, conf: 0, quality: 0, reason: "B/C 没有 CSI 数据（设备离线或 A 未发射）" });
    }
    const ready = live.filter((m) => m.valid);
    const quality = Math.min(1, live.reduce((s, m) => s + Math.min(1, m.rate / 40) * (0.5 + 0.5 * m.pairedPct), 0) / 2);
    if (ready.length === 0) {
      return (this.last = { state: "calibrating", S: 0, conf: 0, quality, reason: `自适应校准中 ${Math.round(Math.min(...live.map((m) => m.calib)) * 100)}%（保持环境安静）` });
    }
    // 两路都就绪：均值 + 一致性奖励；单路就绪：打折
    let S = ready.reduce((s, m) => s + m.z, 0) / ready.length;
    if (ready.length === 2) S += 0.25 * Math.min(ready[0].z, ready[1].z);
    else S *= 0.8;
    const thrOn = 3.2 / this.sens;
    const thrOff = 1.6 / this.sens;
    if (S > thrOn) this.onCnt++;
    else if (S < thrOn * 0.6) this.onCnt = 0;
    if (!this.active && this.onCnt >= 3) {
      this.active = true;
      this.offAt = now;
    }
    if (this.active) {
      if (S > thrOff) this.offAt = now;
      else if (now - this.offAt > 2500) {
        this.active = false;
        this.onCnt = 0;
      }
    }
    const conf = this.active ? Math.min(1, (1 - Math.exp(-S / 7)) * (0.55 + 0.45 * quality)) : 0;
    return (this.last = {
      state: this.active ? "motion" : "empty",
      S,
      conf,
      quality,
      reason: this.active ? "检测到运动目标（幅度类特征）" : "未检测到运动（注意：静止的人不会产生运动特征）",
    });
  }
}
