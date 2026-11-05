// 双基地几何 + 粒子滤波（提示词第 7 章：输出「概率云」而不是伪造精确人体表面）
//
// 几何：A=发射端 t，B/C=接收端 r_i，人体散射点 p（水平面 x,z；躯干高度≈天线高度）。
// 双基地雷达方程（幅度）：反射路径相对强度  w_i(p) ∝ 1 / (|p−t|·|p−r_i|)
//   → 预测链路扰动  ẑ_i = g·w_i(p)，g 为未知增益（人体 RCS、AGC、天线增益……）。
//   观测 z_B、z_C 来自各接收端独立的运动 z 分数（非相干特征级融合）。
// 对数域残差  e_i = ln z_i − ln ẑ_i ，公共增益 ln g ~ N(0,σg²) 被解析边缘化：
//     −2·lnL = d²/(2σ²) + 2m²/(σ²+2σg²)，  d = e_B−e_C ，m = (e_B+e_C)/2
//   d 项给出「到 B / 到 C 的距离比」（Apollonius 圆 → 方位），m 项给出弱距离约束。
// 诚实边界：2 个接收端只给出 2 个标量约束，所以得到的是弧形/团状「概率云」；高度方向完全不可观测，
// 渲染时的高度只是先验（均匀分布 0~1.8m），不是测量。
import type { Geometry } from "./geometry";

export interface Obs {
  zB: number | null; // null = 该链路无有效数据
  zC: number | null;
}

export interface Estimate {
  x: number;
  z: number;
  sx: number;
  sz: number;
  spread: number; // 位置不确定度 √(sx²+sz²) 米
  ess: number; // 有效粒子数
  gain: number; // 观测自洽度 0..1（似然是否被某处很好地解释）
}

function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class ParticleFilter {
  readonly N: number;
  px: Float32Array;
  pz: Float32Array;
  vx: Float32Array;
  vz: Float32Array;
  hy: Float32Array; // 渲染用高度先验
  lw: Float32Array; // 对数权重
  w: Float32Array; // 归一化权重
  private tx: Float32Array;
  private tz: Float32Array;
  private nvx: Float32Array;
  private nvz: Float32Array;
  private rnd: () => number;
  W = 6;
  D = 6;
  g0 = 40; // 参考增益：距两端各 1m 处 w=1 → z≈g0·r0²
  r0 = 0.6;
  sigma = 0.55;
  sigmaG = 1.1;
  beta = 0.6;
  est: Estimate = { x: 0, z: 0, sx: 9, sz: 9, spread: 9, ess: 0, gain: 0 };
  active = false;
  geom: Geometry;

  constructor(geom: Geometry, N = 2600, seed = 12345) {
    this.N = N;
    this.geom = geom;
    this.px = new Float32Array(N);
    this.pz = new Float32Array(N);
    this.vx = new Float32Array(N);
    this.vz = new Float32Array(N);
    this.hy = new Float32Array(N);
    this.lw = new Float32Array(N);
    this.w = new Float32Array(N);
    this.tx = new Float32Array(N);
    this.tz = new Float32Array(N);
    this.nvx = new Float32Array(N);
    this.nvz = new Float32Array(N);
    this.rnd = mulberry32(seed);
    for (let i = 0; i < N; i++) this.hy[i] = 0.02 + this.rnd() * 1.75;
    this.scatter();
  }

  setRoom(W: number, D: number) {
    this.W = W;
    this.D = D;
    this.scatter();
  }

  private gauss() {
    const u = Math.max(1e-9, this.rnd());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.rnd());
  }

  /** 全房间均匀重新散布（目标刚出现 / 几何改变） */
  scatter() {
    for (let i = 0; i < this.N; i++) {
      this.px[i] = (this.rnd() - 0.5) * this.W;
      this.pz[i] = (this.rnd() - 0.5) * this.D;
      this.vx[i] = this.vz[i] = 0;
      this.lw[i] = 0;
      this.w[i] = 1 / this.N;
    }
    this.est = { x: 0, z: 0, sx: this.W / 3.5, sz: this.D / 3.5, spread: Math.hypot(this.W, this.D) / 3.5, ess: this.N, gain: 0 };
  }

  private logLik(x: number, z: number, o: Obs, uB: number, uC: number) {
    const g = this.geom;
    const dA = Math.max(0.25, Math.hypot(x - g.A[0], z - g.A[1]));
    let e1 = 0;
    let e2 = 0;
    const s2 = this.sigma * this.sigma;
    const sg2 = this.sigmaG * this.sigmaG;
    if (o.zB !== null) {
      const dB = Math.max(0.25, Math.hypot(x - g.B[0], z - g.B[1]));
      e1 = uB - Math.log(this.g0 * Math.min(1, (this.r0 * this.r0) / (dA * dB)));
    }
    if (o.zC !== null) {
      const dC = Math.max(0.25, Math.hypot(x - g.C[0], z - g.C[1]));
      e2 = uC - Math.log(this.g0 * Math.min(1, (this.r0 * this.r0) / (dA * dC)));
    }
    if (o.zB !== null && o.zC !== null) {
      const m = 0.5 * (e1 + e2);
      const d = e1 - e2;
      return -0.5 * ((d * d) / (2 * s2) + (2 * m * m) / (s2 + 2 * sg2));
    }
    const e = o.zB !== null ? e1 : e2;
    return -0.5 * ((e * e) / (s2 + sg2));
  }

  /** dt 秒；active=融合检测器判定有运动目标。无目标时不更新（粒子保持，渲染端淡出）。 */
  step(dt: number, o: Obs, active: boolean) {
    const N = this.N;
    if (active && !this.active) this.scatter();
    this.active = active;
    if (!active) return;
    const hasObs = o.zB !== null || o.zC !== null;
    // 1) 运动模型：阻尼 + 随机加速度（行走速度 ≲ 2m/s）
    const damp = Math.exp(-dt / 1.6);
    const sa = 1.6 * Math.sqrt(dt);
    const hx = this.W / 2;
    const hz = this.D / 2;
    for (let i = 0; i < N; i++) {
      this.vx[i] = this.vx[i] * damp + sa * this.gauss();
      this.vz[i] = this.vz[i] * damp + sa * this.gauss();
      let x = this.px[i] + this.vx[i] * dt;
      let z = this.pz[i] + this.vz[i] * dt;
      if (x < -hx) {
        x = -hx;
        this.vx[i] = Math.abs(this.vx[i]) * 0.5;
      } else if (x > hx) {
        x = hx;
        this.vx[i] = -Math.abs(this.vx[i]) * 0.5;
      }
      if (z < -hz) {
        z = -hz;
        this.vz[i] = Math.abs(this.vz[i]) * 0.5;
      } else if (z > hz) {
        z = hz;
        this.vz[i] = -Math.abs(this.vz[i]) * 0.5;
      }
      this.px[i] = x;
      this.pz[i] = z;
    }
    if (!hasObs) {
      this.summarize(0);
      return;
    }
    // 2) 观测更新（回火 β 防止权重塌缩）
    const uB = o.zB !== null ? Math.log(Math.max(0.5, o.zB)) : 0;
    const uC = o.zC !== null ? Math.log(Math.max(0.5, o.zC)) : 0;
    let mx = -Infinity;
    for (let i = 0; i < N; i++) {
      const l = this.lw[i] * 0.5 + this.beta * this.logLik(this.px[i], this.pz[i], o, uB, uC); // lw*0.5：遗忘旧证据
      this.lw[i] = l;
      if (l > mx) mx = l;
    }
    let sum = 0;
    for (let i = 0; i < N; i++) {
      const e = Math.exp(this.lw[i] - mx);
      this.w[i] = e;
      sum += e;
    }
    let s2 = 0;
    const inv = 1 / sum;
    for (let i = 0; i < N; i++) {
      this.w[i] *= inv;
      s2 += this.w[i] * this.w[i];
    }
    const ess = 1 / s2;
    this.summarize(Math.exp(mx / 1)); // mx<=0：越接近 0 说明某处被观测很好地解释
    // 3) 重采样（系统重采样 + 小抖动 + 3% 随机注入以便目标丢失后恢复）
    if (ess < N * 0.5) this.resample();
  }

  private resample() {
    const N = this.N;
    const u0 = this.rnd() / N;
    let c = this.w[0];
    let j = 0;
    const nRand = Math.floor(N * 0.03);
    for (let i = 0; i < N - nRand; i++) {
      const u = u0 + i / N;
      while (u > c && j < N - 1) {
        j++;
        c += this.w[j];
      }
      this.tx[i] = this.px[j] + 0.04 * this.gauss();
      this.tz[i] = this.pz[j] + 0.04 * this.gauss();
      this.nvx[i] = this.vx[j];
      this.nvz[i] = this.vz[j];
    }
    for (let i = N - nRand; i < N; i++) {
      this.tx[i] = (this.rnd() - 0.5) * this.W;
      this.tz[i] = (this.rnd() - 0.5) * this.D;
      this.nvx[i] = this.nvz[i] = 0;
    }
    [this.px, this.tx] = [this.tx, this.px];
    [this.pz, this.tz] = [this.tz, this.pz];
    [this.vx, this.nvx] = [this.nvx, this.vx];
    [this.vz, this.nvz] = [this.nvz, this.vz];
    for (let i = 0; i < N; i++) {
      this.lw[i] = 0;
      this.w[i] = 1 / N;
    }
  }

  private summarize(gain: number) {
    const N = this.N;
    let mx = 0;
    let mz = 0;
    for (let i = 0; i < N; i++) {
      mx += this.w[i] * this.px[i];
      mz += this.w[i] * this.pz[i];
    }
    let vx = 0;
    let vz = 0;
    let s2 = 0;
    for (let i = 0; i < N; i++) {
      vx += this.w[i] * (this.px[i] - mx) ** 2;
      vz += this.w[i] * (this.pz[i] - mz) ** 2;
      s2 += this.w[i] * this.w[i];
    }
    const sx = Math.sqrt(vx);
    const sz = Math.sqrt(vz);
    this.est = { x: mx, z: mz, sx, sz, spread: Math.hypot(sx, sz), ess: 1 / s2, gain: Math.min(1, gain) };
  }

  /** 房间地面占据概率网格（n×n），供「地形」渲染；输出归一化到最大值 1 */
  occupancy(n: number, out: Float32Array) {
    out.fill(0);
    const hx = this.W;
    const hz = this.D;
    for (let i = 0; i < this.N; i++) {
      const gx = Math.floor(((this.px[i] + hx / 2) / hx) * n);
      const gz = Math.floor(((this.pz[i] + hz / 2) / hz) * n);
      if (gx < 0 || gz < 0 || gx >= n || gz >= n) continue;
      out[gz * n + gx] += this.w[i];
    }
    let m = 1e-9;
    for (let i = 0; i < out.length; i++) if (out[i] > m) m = out[i];
    for (let i = 0; i < out.length; i++) out[i] /= m;
  }
}
