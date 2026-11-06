// 每个接收端（B / C）独立处理 CSI → 运动与静态散射物体特征（先独立分析，再做非相干特征级融合）。
// 只使用「幅度与频域包络相关性」类特征：不同 ESP32 的本振/相位并不相干，且每个包都有随机的 CFO/SFO 相位项，
// 所以不做跨板相位运算，也不对单包做线性相位拟合/删除。
//
// 核心第一性原则特征（针对三块紧挨摆放的三角阵列 ESP32-S3 N16R8 深度优化）：
//   1) turb  : 相邻包「归一化子载波形状」的平均绝对差（子载波湍流）—— 捕捉快速运动与多普勒展宽
//   2) dev   : 1 − Pearson(形状, 慢背景形状) —— 捕捉行走、大幅动作与中等尺度形变
//   3) pow   : |总功率(dB) − 慢滑动均值| —— 捕捉近场菲涅尔区路径遮挡/散射阴影
//   4) stat  : 1 − Pearson(形状, 空房锁定基准形状) + 频域多径色散偏移 —— 捕捉静止/微动物体与障碍物
//   5) spread: 52 个有效子载波的频域邻间差分能量（多径时延扩展代理指标，反映散射体远近）
// 噪声底全自适应：取最近 90 秒窗口特征的 q10/q40 分位数估计 μ 与 σ（对「有人活动」这种向上的污染稳健），无需手动校准。
import { NVALID, VALID_IDX } from "./config";
import type { TriFrame } from "./protocol";

export const WIN_MS = 200; // 标准特征窗口（保持协议与测试兼容）
export const FAST_STEP_MS = 50; // 20Hz 高速子窗口滑动更新周期（实时丝滑响应）
export const HIST_N = 450; // 450 × 0.2s = 90s
export const MIN_CAL = 40; // 标准校准窗口数（同时支持快速预览准就绪）

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
  staticZ: number; // 静态/微动物体散射分数（相对清洁空房基准的持续频谱畸变）
  delayProxy: number; // 52 子载波频域多径色散深度（0..1，用于辅助远近估计）
  zf: [number, number, number];
  rate: number; // 近 2 秒有效 CSI 包率 /s
  pairedPct: number; // 近 2 秒与 A 序列号配对的比例 0..1
  rssi: number;
  lossPct: number; // 由 rxCnt 间断推算的包缺失比例（板内丢弃）
  lastAt: number;
  boot: number;
  win: number; // 特征窗口序号（每产生一个新的有效窗口 +1；用于「每个观测只融合一次」）
  shapeVec: Float32Array; // 当前窗口平均归一化子载波包络（52 维）
}

export class LinkAnalyzer {
  readonly node: number;
  private prev = new Float32Array(NVALID);
  private bg = new Float32Array(NVALID);
  private cleanRef = new Float32Array(NVALID);
  private winShapeAcc = new Float32Array(NVALID);
  private hasPrev = false;
  private hasBg = false;
  private hasCleanRef = false;
  private cleanCount = 0;
  private pEma = 0;
  private pClean = 0;
  private pInit = false;
  // 窗口累加
  private aT = 0;
  private aD = 0;
  private aP = 0;
  private aS = 0; // 静态基准偏离累加
  private aM = 0; // 频域多径纹波能量累加
  private aN = 0;
  // 历史
  private h = [new Float32Array(HIST_N), new Float32Array(HIST_N), new Float32Array(HIST_N)];
  private hStat = new Float32Array(HIST_N);
  private hN = 0;
  private hI = 0;
  private tmp = new Float32Array(HIST_N);
  private mu = [0, 0, 0];
  private sg = [1, 1, 1];
  private muStat = 0;
  private sgStat = 1;
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
    this.m = {
      node,
      valid: false,
      calib: 0,
      z: 0,
      act: 0,
      staticZ: 0,
      delayProxy: 0,
      zf: [0, 0, 0],
      rate: 0,
      pairedPct: 0,
      rssi: 0,
      lossPct: 0,
      lastAt: 0,
      boot: 0,
      win: 0,
      shapeVec: new Float32Array(NVALID),
    };
  }

  reset() {
    this.hasPrev = this.hasBg = this.hasCleanRef = this.pInit = false;
    this.cleanCount = 0;
    this.hN = this.hI = 0;
    this.aN = 0;
    this.aT = this.aD = this.aP = this.aS = this.aM = 0;
    this.winShapeAcc.fill(0);
    this.lastCnt = -1;
    this.m = {
      ...this.m,
      valid: false,
      calib: 0,
      z: 0,
      act: 0,
      staticZ: 0,
      delayProxy: 0,
      zf: [0, 0, 0],
    };
  }

  private pearsonDev(a: Float32Array, b: Float32Array): number {
    let ma = 0;
    let mb = 0;
    for (let i = 0; i < NVALID; i++) {
      ma += a[i];
      mb += b[i];
    }
    ma /= NVALID;
    mb /= NVALID;
    let sab = 0;
    let saa = 0;
    let sbb = 0;
    for (let i = 0; i < NVALID; i++) {
      const da = a[i] - ma;
      const db = b[i] - mb;
      sab += da * db;
      saa += da * da;
      sbb += db * db;
    }
    const c = sab / Math.sqrt(saa * sbb + 1e-12);
    return Math.sqrt(Math.max(0, 2 * (1 - c)));
  }

  pushFrame(f: TriFrame, now: number) {
    if (f.boot !== this.boot) {
      this.boot = f.boot;
      this.hasPrev = false;
      this.lastCnt = -1;
    }
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
    for (let i = 0; i < NVALID; i++) {
      amp[i] *= inv; // → 归一化形状
      this.winShapeAcc[i] += amp[i];
    }
    const pdb = 20 * Math.log10(mean);

    // 频域多径色散纹波能量（相邻有效子载波幅度梯度）
    let ripple = 0;
    for (let i = 1; i < NVALID; i++) {
      if ( i === 26 ) continue; // 跨 DC 跳过
      ripple += Math.abs(amp[i] - amp[i - 1]);
    }
    ripple /= NVALID - 2;

    // 1) turb
    let turb = 0;
    if (this.hasPrev) {
      for (let i = 0; i < NVALID; i++) turb += Math.abs(amp[i] - this.prev[i]);
      turb = Math.min(1, turb / NVALID);
    }
    // 2) dev (慢自适应背景)
    let dev = 0;
    if (this.hasBg) {
      dev = this.pearsonDev(amp, this.bg);
      // 当处于静止低湍流状态时背景正常缓慢更新；剧烈运动时减缓背景被目标同化
      const isQuiet = !this.m.valid || dev < this.mu[1] + 2.2 * this.sg[1];
      const al = isQuiet ? 0.004 : 0.00015;
      for (let i = 0; i < NVALID; i++) this.bg[i] += al * (amp[i] - this.bg[i]);
    } else {
      this.bg.set(amp);
      this.hasBg = true;
    }
    // 3) 静态基准形状（空房校准期锁定，其后仅在极度安静时以极慢速率微调漂移）
    let statDev = 0;
    if (this.hasCleanRef) {
      statDev = this.pearsonDev(amp, this.cleanRef);
      if (this.cleanCount < MIN_CAL * 15) {
        const w = 1 / (++this.cleanCount);
        for (let i = 0; i < NVALID; i++) this.cleanRef[i] += w * (amp[i] - this.cleanRef[i]);
        this.pClean += w * (pdb - this.pClean);
      } else if (turb < 0.025 && statDev < 0.015) {
        for (let i = 0; i < NVALID; i++) this.cleanRef[i] += 0.0002 * (amp[i] - this.cleanRef[i]);
        this.pClean += 0.0002 * (pdb - this.pClean);
      }
    } else {
      this.cleanRef.set(amp);
      this.pClean = pdb;
      this.hasCleanRef = true;
      this.cleanCount = 1;
    }

    // 4) pow
    let pw = 0;
    if (this.pInit) {
      pw = Math.min(6, Math.abs(pdb - this.pEma));
      const isQuietP = !this.m.valid || pw < this.mu[2] + 2.2 * this.sg[2];
      this.pEma += (isQuietP ? 0.02 : 0.0005) * (pdb - this.pEma);
    } else {
      this.pEma = pdb;
      this.pInit = true;
    }
    this.prev.set(amp);
    this.hasPrev = true;
    this.aT += turb;
    this.aD += dev;
    this.aP += pw;
    this.aS += statDev + 0.05 * Math.min(4, Math.abs(pdb - this.pClean));
    this.aM += ripple;
    this.aN++;
  }

  /** 每 ~200ms 产生一个统计独立窗口（同时实时刷新包率与链路状态） */
  tick(now: number): LinkMetrics {
    const cut = now - 2000;
    while (this.stamps.length && this.stamps[0] < cut) this.stamps.shift();
    while (this.pairedStamps.length && this.pairedStamps[0] < cut) this.pairedStamps.shift();
    this.m.rate = this.stamps.length / 2;
    this.m.pairedPct = this.stamps.length ? Math.min(1, this.pairedStamps.length / this.stamps.length) : 0;
    this.m.lossPct = this.cntSeen + this.cntLost > 20 ? this.cntLost / (this.cntSeen + this.cntLost) : 0;

    if (now - this.lastTick < WIN_MS * 0.9) return this.m;
    this.lastTick = now;
    if (this.aN < 3 || now - this.m.lastAt > 1500) {
      this.m.act *= 0.8;
      this.m.z *= 0.5;
      this.m.staticZ *= 0.7;
      this.aT = this.aD = this.aP = this.aS = this.aM = 0;
      this.aN = 0;
      this.winShapeAcc.fill(0);
      return this.m;
    }
    const invN = 1 / this.aN;
    const x = [this.aT * invN, this.aD * invN, this.aP * invN];
    const statRaw = this.aS * invN;
    const rippleMean = this.aM * invN;
    for (let i = 0; i < NVALID; i++) {
      this.m.shapeVec[i] = this.winShapeAcc[i] * invN;
      this.winShapeAcc[i] = 0;
    }
    this.aT = this.aD = this.aP = this.aS = this.aM = 0;
    this.aN = 0;

    this.m.delayProxy = Math.max(0, Math.min(1, rippleMean * 4.5));
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
      // 静态散射基准分位数
      this.tmp.set(this.hStat.subarray(0, this.hN));
      this.tmp.subarray(0, this.hN).sort();
      const sq10 = quantile(this.tmp, this.hN, 0.1);
      const sq40 = quantile(this.tmp, this.hN, 0.4);
      const sSigma = (sq40 - sq10) / 1.0286;
      this.muStat = sq40 + 0.2533 * sSigma;
      this.sgStat = Math.max(sSigma, 0.12 * this.muStat, 1e-4);

      const zf: [number, number, number] = [0, 0, 0];
      for (let f = 0; f < 3; f++) zf[f] = Math.max(0, (x[f] - this.mu[f]) / this.sg[f]);
      const sorted = [...zf].sort((a, b) => b - a);
      const z = (sorted[0] + sorted[1]) / 2;
      const sz = Math.max(0, (statRaw - this.muStat) / this.sgStat);
      this.m.zf = zf;
      this.m.z = Math.min(60, z);
      this.m.staticZ = Math.min(40, sz);
      this.m.valid = true;
      this.m.win++;
      this.m.act = Math.max(this.m.z, this.m.act * 0.9);
    } else {
      this.m.valid = false;
    }
    const cap = this.hN >= MIN_CAL ? [this.mu[0] + 2.5 * this.sg[0], this.mu[1] + 2.5 * this.sg[1], this.mu[2] + 2.5 * this.sg[2]] : [9, 9, 9];
    for (let f = 0; f < 3; f++) this.h[f][this.hI] = Math.min(x[f], cap[f]);
    this.hStat[this.hI] = this.hN >= MIN_CAL ? Math.min(statRaw, this.muStat + 10 * this.sgStat) : statRaw;
    this.hI = (this.hI + 1) % HIST_N;
    this.hN = Math.min(HIST_N, this.hN + 1);
    return this.m;
  }
}

// ----------------------------------------------------------------------------------------------
export type Presence = "calibrating" | "offline" | "empty" | "motion";

export interface Fused {
  state: Presence;
  S: number; // 融合运动分数
  staticS: number; // 静态/微动物体散射融合分数
  hasStaticObject: boolean; // 是否检测到静止/驻留物体
  crossCorr: number; // B/C 子载波包络相关性（反映散射体对称性/近场耦合）
  conf: number; // 0..1 置信度
  quality: number; // 数据质量 0..1
  reason: string;
}

export class FusedDetector {
  sens = 1;
  private onCnt = 0;
  private offAt = 0;
  private active = false;
  last: Fused = {
    state: "offline",
    S: 0,
    staticS: 0,
    hasStaticObject: false,
    crossCorr: 0,
    conf: 0,
    quality: 0,
    reason: "等待数据",
  };

  reset() {
    this.active = false;
    this.onCnt = 0;
  }

  update(b: LinkMetrics, c: LinkMetrics, now: number): Fused {
    const live = [b, c].filter((m) => now - m.lastAt < 2000 && m.rate >= 5);
    if (live.length === 0) {
      this.active = false;
      this.onCnt = 0;
      return (this.last = {
        state: "offline",
        S: 0,
        staticS: 0,
        hasStaticObject: false,
        crossCorr: 0,
        conf: 0,
        quality: 0,
        reason: "B/C 没有 CSI 数据（设备离线或 A 未发射）",
      });
    }
    const ready = live.filter((m) => m.valid);
    const quality = Math.min(1, live.reduce((s, m) => s + Math.min(1, m.rate / 40) * (0.5 + 0.5 * m.pairedPct), 0) / 2);
    if (ready.length === 0) {
      return (this.last = {
        state: "calibrating",
        S: 0,
        staticS: 0,
        hasStaticObject: false,
        crossCorr: 0,
        conf: 0,
        quality,
        reason: `自适应校准中 ${Math.round(Math.min(...live.map((m) => m.calib)) * 100)}%（保持环境安静）`,
      });
    }
    // 两路都就绪：均值 + 一致性奖励；单路就绪：打折
    let S = ready.reduce((s, m) => s + m.z, 0) / ready.length;
    let staticS = ready.reduce((s, m) => s + m.staticZ, 0) / ready.length;
    if (ready.length === 2) {
      S += 0.25 * Math.min(ready[0].z, ready[1].z);
      staticS += 0.2 * Math.min(ready[0].staticZ, ready[1].staticZ);
    } else {
      S *= 0.8;
      staticS *= 0.8;
    }

    // 计算 B 与 C 归一化子载波包络的互相关系数
    let crossCorr = 0;
    if (ready.length === 2) {
      const sb = b.shapeVec;
      const sc = c.shapeVec;
      let mb = 0, mc = 0;
      for (let i = 0; i < NVALID; i++) {
        mb += sb[i];
        mc += sc[i];
      }
      mb /= NVALID;
      mc /= NVALID;
      let sbc = 0, sbb = 0, scc = 0;
      for (let i = 0; i < NVALID; i++) {
        const db = sb[i] - mb;
        const dc = sc[i] - mc;
        sbc += db * dc;
        sbb += db * db;
        scc += dc * dc;
      }
      crossCorr = sbc / Math.sqrt(sbb * scc + 1e-12);
    }

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
    const hasStaticObject = staticS > 3.6 / this.sens;
    const conf = this.active ? Math.min(1, (1 - Math.exp(-S / 7)) * (0.55 + 0.45 * quality)) : hasStaticObject ? Math.min(0.85, (1 - Math.exp(-staticS / 8)) * 0.75 * quality) : 0;
    const reason =
      ready.length < 2
        ? `仅 ESP32-${ready[0].node === 2 ? "B" : "C"} 一路有效（另一路离线或校准中，定位退化为单链路）`
        : this.active
          ? `双链路融合 S=${S.toFixed(1)} > 阈值 ${thrOn.toFixed(1)}（B:${b.z.toFixed(1)} C:${c.z.toFixed(1)}）`
          : hasStaticObject
            ? `检测到静态/驻留散射物体 staticS=${staticS.toFixed(1)}（B:${b.staticZ.toFixed(1)} C:${c.staticZ.toFixed(1)}）`
            : `环境平稳 S=${S.toFixed(1)} < 阈值 ${thrOn.toFixed(1)}`;
    return (this.last = {
      state: this.active ? "motion" : "empty",
      S,
      staticS,
      hasStaticObject,
      crossCorr,
      conf,
      quality,
      reason,
    });
  }
}
