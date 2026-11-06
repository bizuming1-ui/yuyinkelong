// Imager25D —— 网格后验成像器（提示词 v5 · 第 3、4.1 节）：真正的「2.5D 概率占据图」
//
// ★ 定义（诚实边界，UI 与代码必须一致）★
//   · 输出 P(x,z | 观测)：地面平面上的后验概率场（n×n，sum=1）。这是「估计/推断」，不是摄像头式成像。
//   · 2.5D 的「高度」= 概率密度强度（view[k]），不是人体或物体的真实高度；垂直方向 CSI 不可观测。
//   · 只有「运动」产生特征：静止的人/家具不会出现在图里（空房与静坐人无法区分）。
//
// ★ 数学（精确贝叶斯网格滤波，确定性、无随机数 → 同输入序列 ⇒ 同输出）★
//   状态：目标散射点 p=(x,z)，离散为 n×n 个 cell。
//   1) 预测（运动先验）：p_t⁻ = G_σm ⊛ p_{t-1}，σm = v·√dt（v≈1.2 m/s，可分离高斯核，边界镜像）
//      再混入均匀分布 λ=1−e^{−dt/τ}（τ=5s）→ 保证永不塌缩、可从目标丢失中恢复。
//   2) 观测似然（与 pf.ts 完全一致：双基地幅度模型 + 公共增益解析边缘化）
//      ẑ_i(p) = g0·min(1, r0²/(|p−A|·|p−R_i|))，e_i = ln z_i − ln ẑ_i
//      双路：  ln L = −½[ d²/(2σ²) + 2m²/(σ²+2σg²) ]，d=e_B−e_C，m=(e_B+e_C)/2
//      单路：  ln L = −½ e²/(σ²+σg²)    （缺测 → 约束更少 → 后验自然更弥散 → 「单路退化」）
//   3) 更新：p_t ∝ p_t⁻ · exp(β·ln L)  （β=0.6 回火，防止权重塌缩）
//   4) 每个观测窗口只允许更新一次：调用方只在「有新窗口」时传 zB/zC，否则传 null（只做预测，不重复计权）
//
// ★ 指标定义 ★
//   entropy  H = −Σ p ln p（nat）；Hnorm = H/ln(N)
//   Aeff     = exp(H)/N，后验「有效占据面积占房间比例」；sharp = 1−√Aeff（0=完全弥散，1=一个点）
//   fit      = exp(max_cell ln L)∈(0,1]：观测被几何模型解释的程度（EMA 平滑）
//   modelFit = √(fit·sharp)；dataQuality = Fused.quality·(双路?1:0.55)·(1−loss)
//   conf25d  = clamp(presenceConf · dataQuality · modelFit)   —— 启发式分数，不是校准过的概率
//   hpd50/90 = 包含 50%/90% 后验质量的最小等高线阈值（可信区域）
import type { Geometry } from "./geometry";

export interface ImagerObs {
  zB: number | null; // null = 本步没有该链路的「新」观测
  zC: number | null;
}

export interface ImagerQuality {
  presenceConf: number; // FusedDetector.conf
  dataQuality: number; // FusedDetector.quality
  linksOnline: number; // 当前在线且有效的接收链路数 0..2
  pairedPct: number; // 0..1（在线链路中最低值）
  rate: number; // 包/s（在线链路中最低值）
  lossPct: number; // 0..1（在线链路中最高值）
}

export interface GridEstimate {
  n: number;
  available: boolean; // false = 不可用（离线/校准中/无运动）：UI 必须淡出并显示 reason
  mode: "ok" | "single" | "stale" | "idle" | "nodata";
  peakX: number; // MAP 位置（米，相对阵列质心）
  peakZ: number;
  meanX: number;
  meanZ: number;
  sx: number;
  sz: number;
  rho: number; // 相关系数
  spread: number; // √(sx²+sz²) 米
  entropy: number; // nat
  entropyNorm: number; // 0..1
  sharp: number;
  fit: number;
  modelFit: number;
  dataQuality: number;
  conf25d: number;
  tier: "低" | "中" | "高";
  reason: string;
  hpd50: number; // 概率阈值（p 域）
  hpd90: number;
  pmaxDensity: number; // 峰值密度 / 均匀密度
  age: number; // 距上一次有新观测更新的秒数
}

function emptyEst(n: number, reason: string, mode: GridEstimate["mode"] = "nodata"): GridEstimate {
  return { n, available: false, mode, peakX: 0, peakZ: 0, meanX: 0, meanZ: 0, sx: 0, sz: 0, rho: 0, spread: 0, entropy: Math.log(n * n), entropyNorm: 1, sharp: 0, fit: 0, modelFit: 0, dataQuality: 0, conf25d: 0, tier: "低", reason, hpd50: 1, hpd90: 1, pmaxDensity: 1, age: 0 };
}

export class Imager25D {
  readonly n: number;
  W = 6;
  D = 6;
  // 模型常量（与 pf.ts 保持一致；无实测标定依据，UI 已声明为启发式）
  g0 = 40;
  r0 = 0.6;
  sigma = 0.55;
  sigmaG = 1.1;
  beta = 0.6;
  vMove = 1.2; // m/s 运动先验
  tau = 5; // s 均匀混入时间常数
  densityRef = 12; // 峰值密度达到均匀的 12 倍 → 显示高度 = 1

  private p: Float32Array;
  private tmp: Float32Array;
  private ll: Float32Array;
  private lwB: Float32Array;
  private lwC: Float32Array;
  private cx: Float32Array; // cell 中心 x
  private cz: Float32Array;
  /** 显示用高度场 0..1（= min(1, density/densityRef)），渲染端再做时间平滑 */
  view: Float32Array;
  version = 0;
  est: GridEstimate;
  private wasActive = false;
  private idleT = 0;
  private lastObsAt = -1;
  private fitEma = 0;
  private obsCount = 0;

  constructor(geom: Geometry, W: number, D: number, n = 64) {
    this.n = n;
    const N = n * n;
    this.p = new Float32Array(N);
    this.tmp = new Float32Array(N);
    this.ll = new Float32Array(N);
    this.lwB = new Float32Array(N);
    this.lwC = new Float32Array(N);
    this.cx = new Float32Array(N);
    this.cz = new Float32Array(N);
    this.view = new Float32Array(N);
    this.est = emptyEst(n, "等待数据");
    this.setLayout(geom, W, D);
  }

  /** 预计算每个 cell 到 A/B/C 的几何项（避免每帧重复 hypot） */
  setLayout(geom: Geometry, W: number, D: number) {
    this.W = W;
    this.D = D;
    const n = this.n;
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        const x = ((i + 0.5) / n - 0.5) * W;
        const z = ((j + 0.5) / n - 0.5) * D;
        this.cx[k] = x;
        this.cz[k] = z;
        const dA = Math.max(0.25, Math.hypot(x - geom.A[0], z - geom.A[1]));
        const dB = Math.max(0.25, Math.hypot(x - geom.B[0], z - geom.B[1]));
        const dC = Math.max(0.25, Math.hypot(x - geom.C[0], z - geom.C[1]));
        this.lwB[k] = Math.log(this.g0 * Math.min(1, (this.r0 * this.r0) / (dA * dB)));
        this.lwC[k] = Math.log(this.g0 * Math.min(1, (this.r0 * this.r0) / (dA * dC)));
      }
    this.reset();
  }

  reset() {
    this.p.fill(1 / (this.n * this.n));
    this.view.fill(0);
    this.wasActive = false;
    this.idleT = 0;
    this.lastObsAt = -1;
    this.fitEma = 0;
    this.obsCount = 0;
    this.est = emptyEst(this.n, "等待数据");
    this.version++;
  }

  getGrid(): Float32Array {
    return this.p;
  }

  /** 可分离高斯模糊（运动先验的预测步），边界镜像；σ 以 cell 为单位 */
  private blur(sigmaCells: number) {
    if (sigmaCells < 0.08) return;
    const n = this.n;
    const R = Math.min(4, Math.max(1, Math.ceil(sigmaCells * 2.5)));
    const ker = new Float32Array(2 * R + 1);
    let s = 0;
    for (let a = -R; a <= R; a++) {
      ker[a + R] = Math.exp(-(a * a) / (2 * sigmaCells * sigmaCells));
      s += ker[a + R];
    }
    for (let a = 0; a < ker.length; a++) ker[a] /= s;
    const p = this.p;
    const t = this.tmp;
    const refl = (v: number) => (v < 0 ? -v - 1 : v >= n ? 2 * n - v - 1 : v);
    for (let j = 0; j < n; j++) {
      const row = j * n;
      for (let i = 0; i < n; i++) {
        let acc = 0;
        for (let a = -R; a <= R; a++) acc += ker[a + R] * p[row + refl(i + a)];
        t[row + i] = acc;
      }
    }
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        let acc = 0;
        for (let a = -R; a <= R; a++) acc += ker[a + R] * t[refl(j + a) * n + i];
        p[j * n + i] = acc;
      }
  }

  /**
   * 一步更新。
   * @param obs     本步「新」观测（无新窗口 → 传 null，只做预测，不重复计权）
   * @param active  FusedDetector 是否判定有运动目标
   * @param quality 数据质量摘要
   * @param dt      秒
   * @param now     ms（单调时钟，用于观测新鲜度）
   * @param noData  离线/校准中 → 地图不可用且不更新
   */
  update(obs: ImagerObs, active: boolean, quality: ImagerQuality, dt: number, now: number, noData = false): GridEstimate {
    const n = this.n;
    const N = n * n;
    if (noData) {
      if (this.est.mode !== "nodata") this.reset();
      this.est = emptyEst(n, quality.presenceConf > 0 || quality.dataQuality > 0 ? "校准中 / 数据不足" : "等待数据（设备离线）");
      return this.est;
    }
    if (!active) {
      // 无运动目标：冻结（不更新、不凭空出峰），渲染端淡出；3 秒后清空为均匀分布
      this.idleT += dt;
      if (this.idleT > 3 && this.wasActive) this.reset();
      this.wasActive = false;
      this.est = { ...emptyEst(n, "无运动目标（静止的人/物体不可观测，空房与静坐无法区分）", "idle"), dataQuality: quality.dataQuality };
      return this.est;
    }
    this.idleT = 0;
    if (!this.wasActive) {
      this.p.fill(1 / N);
      this.fitEma = 0;
      this.obsCount = 0;
      this.lastObsAt = -1;
    }
    this.wasActive = true;
    const p = this.p;

    // 1) 预测
    const cell = Math.min(this.W, this.D) / n;
    this.blur((this.vMove * Math.sqrt(dt)) / cell);
    const lam = 1 - Math.exp(-dt / this.tau);
    const u = lam / N;
    for (let k = 0; k < N; k++) p[k] = p[k] * (1 - lam) + u;

    // 2) 观测更新
    let llMax = -Infinity;
    const hasB = obs.zB !== null;
    const hasC = obs.zC !== null;
    if (hasB || hasC) {
      const uB = hasB ? Math.log(Math.max(0.5, obs.zB as number)) : 0;
      const uC = hasC ? Math.log(Math.max(0.5, obs.zC as number)) : 0;
      const s2 = this.sigma * this.sigma;
      const sg2 = this.sigmaG * this.sigmaG;
      const ll = this.ll;
      const c1 = 1 / (2 * s2);
      const c2 = 2 / (s2 + 2 * sg2);
      const c3 = 1 / (s2 + sg2);
      for (let k = 0; k < N; k++) {
        let l: number;
        if (hasB && hasC) {
          const e1 = uB - this.lwB[k];
          const e2 = uC - this.lwC[k];
          const m = 0.5 * (e1 + e2);
          const d = e1 - e2;
          l = -0.5 * (d * d * c1 + m * m * c2);
        } else if (hasB) {
          const e = uB - this.lwB[k];
          l = -0.5 * e * e * c3;
        } else {
          const e = uC - this.lwC[k];
          l = -0.5 * e * e * c3;
        }
        ll[k] = l;
        if (l > llMax) llMax = l;
      }
      let sum = 0;
      for (let k = 0; k < N; k++) {
        const v = p[k] * Math.exp(this.beta * (ll[k] - llMax));
        p[k] = v;
        sum += v;
      }
      const inv = 1 / sum;
      for (let k = 0; k < N; k++) p[k] *= inv;
      const fitNow = Math.exp(llMax);
      this.fitEma = this.obsCount === 0 ? fitNow : this.fitEma * 0.8 + fitNow * 0.2;
      this.obsCount++;
      this.lastObsAt = now;
    } else {
      // 没有新观测：只预测；归一化保险
      let sum = 0;
      for (let k = 0; k < N; k++) sum += p[k];
      const inv = 1 / sum;
      for (let k = 0; k < N; k++) p[k] *= inv;
    }

    // 3) 统计量
    let H = 0;
    let pmax = 0;
    let kmax = 0;
    let mx = 0;
    let mz = 0;
    for (let k = 0; k < N; k++) {
      const v = p[k];
      if (v > 1e-12) H -= v * Math.log(v);
      if (v > pmax) {
        pmax = v;
        kmax = k;
      }
      mx += v * this.cx[k];
      mz += v * this.cz[k];
    }
    let vx = 0;
    let vz = 0;
    let vxz = 0;
    for (let k = 0; k < N; k++) {
      const dx = this.cx[k] - mx;
      const dz = this.cz[k] - mz;
      vx += p[k] * dx * dx;
      vz += p[k] * dz * dz;
      vxz += p[k] * dx * dz;
    }
    const sx = Math.sqrt(vx);
    const sz = Math.sqrt(vz);
    const rho = sx > 1e-6 && sz > 1e-6 ? Math.max(-1, Math.min(1, vxz / (sx * sz))) : 0;
    // MAP 亚格点：沿 x、z 做抛物线插值
    const ci = kmax % n;
    const cj = (kmax / n) | 0;
    const par = (a: number, b: number, c: number) => {
      const den = a - 2 * b + c;
      return Math.abs(den) < 1e-15 ? 0 : Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den));
    };
    const px = ci > 0 && ci < n - 1 ? par(p[kmax - 1], p[kmax], p[kmax + 1]) : 0;
    const pz = cj > 0 && cj < n - 1 ? par(p[kmax - n], p[kmax], p[kmax + n]) : 0;
    const peakX = this.cx[kmax] + (px * this.W) / n;
    const peakZ = this.cz[kmax] + (pz * this.D) / n;

    // 可信区域阈值（二分法找包含 50% / 90% 质量的密度阈值）
    const mass = (th: number) => {
      let m = 0;
      for (let k = 0; k < N; k++) if (p[k] >= th) m += p[k];
      return m;
    };
    const hpd = (target: number) => {
      let lo = 0;
      let hi = pmax;
      for (let it = 0; it < 18; it++) {
        const mid = 0.5 * (lo + hi);
        if (mass(mid) >= target) lo = mid;
        else hi = mid;
      }
      return lo;
    };
    const hpd50 = hpd(0.5);
    const hpd90 = hpd(0.9);

    // 显示高度场
    const k1 = N / this.densityRef;
    for (let k = 0; k < N; k++) this.view[k] = Math.min(1, p[k] * k1);
    this.version++;

    // 4) 置信度（启发式分数）与降级原因
    const Hnorm = H / Math.log(N);
    const Aeff = Math.exp(H) / N;
    const sharp = Math.max(0, 1 - Math.sqrt(Aeff));
    const fit = Math.min(1, this.fitEma);
    const modelFit = Math.sqrt(Math.max(0, fit * sharp));
    const single = quality.linksOnline < 2;
    const dataQuality = Math.max(0, Math.min(1, quality.dataQuality * (single ? 0.55 : 1) * (1 - Math.min(0.8, quality.lossPct))));
    const conf25d = Math.max(0, Math.min(1, quality.presenceConf * dataQuality * modelFit));
    const age = this.lastObsAt < 0 ? 99 : (now - this.lastObsAt) / 1000;
    const reasons: string[] = [];
    let mode: GridEstimate["mode"] = "ok";
    if (single) {
      reasons.push("单路退化（仅 1 条接收链路 → 只有 1 个标量约束，方位不可分辨）");
      mode = "single";
    }
    if (age > 2) {
      reasons.push("观测过期（>2s 无新窗口，地图只在扩散）");
      mode = "stale";
    }
    if (quality.pairedPct < 0.5) reasons.push(`配对率低 ${(quality.pairedPct * 100).toFixed(0)}%`);
    if (quality.rate < 20) reasons.push(`包率低 ${quality.rate.toFixed(0)}/s`);
    if (quality.lossPct > 0.1) reasons.push(`缺失率高 ${(quality.lossPct * 100).toFixed(0)}%`);
    if (this.obsCount > 3 && fit < 0.35) reasons.push("模型不收敛（观测与几何模型不一致，可能是多径/几何填写错误）");
    if (Hnorm > 0.93) reasons.push("后验弥散（位置不确定）");
    const reason = reasons.length ? reasons.join("；") : "数据质量与模型自洽度良好（仍为估计，不是测量）";
    const tier: GridEstimate["tier"] = conf25d >= 0.45 ? "高" : conf25d >= 0.2 ? "中" : "低";

    this.est = {
      n,
      available: true,
      mode,
      peakX,
      peakZ,
      meanX: mx,
      meanZ: mz,
      sx,
      sz,
      rho,
      spread: Math.hypot(sx, sz),
      entropy: H,
      entropyNorm: Hnorm,
      sharp,
      fit,
      modelFit,
      dataQuality,
      conf25d,
      tier,
      reason,
      hpd50,
      hpd90,
      pmaxDensity: pmax * N,
      age,
    };
    return this.est;
  }
}
