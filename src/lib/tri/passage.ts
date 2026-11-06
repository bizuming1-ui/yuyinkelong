// 「过路成像」引擎（PassageEngine）—— 解决「物体经过时只看到一大片平板/椭圆，看不懂」的问题。
//
// 第一性原理：A→B、A→C 两条链路只给出 2 个标量（扰动强度 aB、aC），能被可靠观测的只有：
//   ① 总强度 T=aB+aC      → 物体离阵列的远近（双基地散射 ∝ 1/(R_t·R_r)）
//   ② 侧向指数 L=(aB−aC)/(aB+aC) → 物体偏向 B 侧还是 C 侧（L>0 偏 B，L<0 偏 C）
//   ③ L、T 随时间的变化     → 物体经过的方向（B→C / C→B）与靠近/远离
// 旧 Imager25D 对「公共增益」做了边缘化，距离不可观测，小基线时后验被摊成整块平板。
// 本引擎改用「名义增益」的紧凑后验：P(p) ∝ 强度似然(对数域) × 侧向似然 ，得到一个**局部的、会移动的峰**；
// 再叠加尾迹（衰减的峰值保持）、静态物体层、过路事件检测。全部确定性，无随机数。
//
// 前后镜像：三块板近似共线时前/后对称，无法由数据区分，故加入弱先验「物体在 B/C 一侧的前方（远离 A）」（权重 0.75↔1），
// 界面里的说明也写明了这一点。
// 诚实边界：高度 = 后验强度（不是物体高度）；位置是「视在位置」估计（含不确定度 spread），
// 阵列越小（<0.8 m），侧向/距离越依赖启发式方位先验，不是测量值。
import { makeGeometry, type Geometry } from "./geometry";

export const PG_N = 48;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export interface PassageInput {
  zB: number | null; // 新鲜窗口的 B 链路运动 z（无新窗口 = null）
  zC: number | null;
  sB: number | null; // 静态散射 z
  sC: number | null;
  linkB: boolean; // B 链路在线且有包率
  linkC: boolean;
  staticActive: boolean; // 融合检测器认为存在静止物体
  dt: number; // 秒
  now: number; // ms
  noData: boolean; // 离线/校准中
  sens: number; // 灵敏度 0.5..3
}

export interface PassageMarker {
  visible: boolean;
  alpha: number; // 0..1 渲染淡入淡出
  x: number;
  z: number;
  h: number; // 该点高度 0..1
  vx: number; // m/s
  vz: number;
  conf: number; // 0..1 启发式定位置信
  spread: number; // m 等效不确定半径
}

export interface PassageEvent {
  at: number; // ms
  dur: number; // s
  peak: number; // 峰值 T
  dir: string;
  sign: number; // −1: B→C ; +1: C→B ; 0: 未知
}

export interface HistSample {
  t: number;
  aB: number;
  aC: number;
  vis: boolean;
}

export class PassageEngine {
  readonly N = PG_N;
  geom: Geometry;
  W: number;
  D: number;
  cur = new Float32Array(PG_N * PG_N); // 后验「可能区域」（0..1，含距离/方位歧义，低矮半透明显示）
  blob = new Float32Array(PG_N * PG_N); // 以估计位置为中心的紧凑「物体峰」（主显示）
  wake = new Float32Array(PG_N * PG_N); // 尾迹：衰减峰值保持
  stat = new Float32Array(PG_N * PG_N); // 静态物体层
  marker: PassageMarker = { visible: false, alpha: 0, x: 0, z: 0, h: 0, vx: 0, vz: 0, conf: 0, spread: 0 };
  aB = 0;
  aC = 0;
  T = 0;
  L = 0;
  okB = false;
  okC = false;
  gate = 0;
  dirSign = 0;
  dirText = "";
  approach = 0; // +1 靠近 / −1 远离
  statLevel = 0;
  events: PassageEvent[] = [];
  hist: HistSample[] = [];
  trail: { x: number; z: number; t: number }[] = [];
  tickCount = 0;
  /** 阵列边长 < 0.8 m：B/C 两路几何几乎重合，方向/侧向在物理上不可分辨 */
  get compact() {
    return this.geom.side < 0.8;
  }

  private KB = new Float32Array(PG_N * PG_N);
  private KC = new Float32Array(PG_N * PG_N);
  private BP = new Float32Array(PG_N * PG_N);
  private FP = new Float32Array(PG_N * PG_N); // 前方弱先验（A 在后方，B/C 在前方；解决前后镜像歧义，权重仅 0.75↔1）
  private P = new Float32Array(PG_N * PG_N);
  private tgtB = 0;
  private tgtC = 0;
  private lastB = 0;
  private lastC = 0;
  private sbS = 0;
  private scS = 0;
  private Lsm = 0;
  private onCnt = 0;
  private offT = 0;
  private lastMarkerAt = 0;
  private ev: null | { t0: number; peak: number; xs: number[] } = null;
  private now0 = 0;

  constructor(geom: Geometry = makeGeometry(0.4), W = 6, D = 6) {
    this.geom = geom;
    this.W = W;
    this.D = D;
    this.precompute();
  }

  setLayout(g: Geometry, W: number, D: number) {
    this.geom = g;
    this.W = W;
    this.D = D;
    this.precompute();
    this.reset();
  }

  reset() {
    this.cur.fill(0);
    this.blob.fill(0);
    this.wake.fill(0);
    this.stat.fill(0);
    this.aB = this.aC = this.T = this.L = this.Lsm = 0;
    this.tgtB = this.tgtC = this.sbS = this.scS = 0;
    this.marker = { visible: false, alpha: 0, x: 0, z: 0, h: 0, vx: 0, vz: 0, conf: 0, spread: 0 };
    this.onCnt = 0;
    this.ev = null;
    this.hist = [];
    this.trail = [];
    this.dirSign = 0;
    this.dirText = "";
  }

  cellX(i: number) {
    return -this.W / 2 + (this.W * i) / (PG_N - 1);
  }
  cellZ(j: number) {
    return -this.D / 2 + (this.D * j) / (PG_N - 1);
  }

  /** 预计算每个格点的双基地灵敏度 K_B、K_C 与方位先验（阵列小时 B/C 比值几乎恒定，用方位代理） */
  private precompute() {
    const g = this.geom;
    const dB = Math.hypot(g.B[0] - g.A[0], g.B[1] - g.A[1]);
    const dC = Math.hypot(g.C[0] - g.A[0], g.C[1] - g.A[1]);
    const r0 = 0.9;
    const cx = (g.A[0] + g.B[0] + g.C[0]) / 3;
    const cz = (g.A[1] + g.B[1] + g.C[1]) / 3;
    for (let j = 0; j < PG_N; j++) {
      for (let i = 0; i < PG_N; i++) {
        const k = j * PG_N + i;
        const x = this.cellX(i);
        const z = this.cellZ(j);
        const Rt = Math.max(0.25, Math.hypot(x - g.A[0], z - g.A[1]));
        const RB = Math.max(0.25, Math.hypot(x - g.B[0], z - g.B[1]));
        const RC = Math.max(0.25, Math.hypot(x - g.C[0], z - g.C[1]));
        // 近链路路径的菲涅尔增强：超额路径 e=Rt+Rr−d
        const eB = Rt + RB - dB;
        const eC = Rt + RC - dC;
        const fB = 1 + 1.5 * Math.exp(-((eB / (0.18 + 0.12 * dB)) ** 2));
        const fC = 1 + 1.5 * Math.exp(-((eC / (0.18 + 0.12 * dC)) ** 2));
        this.KB[k] = Math.min(1, (fB / (1 + (Rt * RB) / (r0 * r0))) * 1.0);
        this.KC[k] = Math.min(1, (fC / (1 + (Rt * RC) / (r0 * r0))) * 1.0);
        const rho = Math.hypot(x - cx, z - cz);
        this.FP[k] = 0.75 + 0.25 / (1 + Math.exp(-(z - cz) / 0.4));
        this.BP[k] = Math.tanh((1.6 * (cx - x)) / (rho + 0.25)); // x<0（B 侧）→ 正
      }
    }
  }

  private conv(z: number, sens: number, z0 = 1.6, zs = 4) {
    return 1 - Math.exp(-Math.max(0, z - z0 / sens) / (zs / Math.sqrt(sens)));
  }

  /** 后验：写入 out(0..1 峰)，返回 {gate, frac, ix, iz} */
  private posterior(aB: number, aC: number, okB: boolean, okC: boolean, out: Float32Array, G: number, prev: { x: number; z: number } | null) {
    const T = (okB ? aB : 0) + (okC ? aC : 0);
    const gate = clamp((T - 0.05) / 0.3, 0, 1);
    if (gate < 0.015 || (!okB && !okC)) {
      out.fill(0);
      return { gate: 0, frac: 0, ix: -1, iz: -1 };
    }
    const both = okB && okC;
    const lnT = Math.log(T + 0.03);
    const Lobs = both ? (aB - aC) / (aB + aC + 0.05) : 0;
    const cL = T / (T + 0.1);
    const sL = 0.45 + 0.4 * (1 - cL);
    const w = clamp(this.geom.side / 1.2, 0, 1);
    const P = this.P;
    let pmax = 1e-9;
    for (let k = 0; k < PG_N * PG_N; k++) {
      const pB = Math.min(1, G * this.KB[k]);
      const pC = Math.min(1, G * this.KC[k]);
      const Tp = both ? pB + pC : okB ? pB : pC;
      const e1 = lnT - Math.log(Tp + 0.03);
      let l = Math.exp(-(e1 * e1) / (2 * 0.75 * 0.75));
      if (both) {
        const Lp = w * ((pB - pC) / (pB + pC + 1e-3)) + (1 - w) * this.BP[k];
        const d = Lobs - Lp;
        l *= Math.exp(-(d * d) / (2 * sL * sL));
      }
      l *= this.FP[k];
      P[k] = l;
      if (l > pmax) pmax = l;
    }
    const amp = gate * (0.3 + 0.7 * Math.min(1, T));
    let cnt = 0;
    let best = -1;
    let bestS = -1;
    for (let k = 0; k < PG_N * PG_N; k++) {
      const p01 = P[k] / pmax;
      // 只显示高于峰值 45% 的区域：后验平坦（距离/方位不可分辨）时不再把整片区域抬成「平板」
      const v = p01 > 0.45 ? (p01 - 0.45) / 0.55 : 0;
      out[k] = amp * v * v;
      if (p01 > 0.6) cnt++;
      let s = p01;
      if (prev) {
        const i = k % PG_N;
        const j = (k / PG_N) | 0;
        const dx = this.cellX(i) - prev.x;
        const dz = this.cellZ(j) - prev.z;
        s *= Math.exp(-(dx * dx + dz * dz) / (2 * 1.0 * 1.0));
      }
      if (s > bestS) {
        bestS = s;
        best = k;
      }
    }
    return { gate, frac: cnt / (PG_N * PG_N), ix: best % PG_N, iz: (best / PG_N) | 0 };
  }

  update(inp: PassageInput) {
    const dt = clamp(inp.dt, 0.005, 0.2);
    const now = inp.now;
    if (this.now0 === 0) this.now0 = now;
    this.tickCount++;
    const sens = clamp(inp.sens, 0.5, 3);

    // ---- 链路活动：快攻慢降 ----
    this.okB = inp.linkB && !inp.noData;
    this.okC = inp.linkC && !inp.noData;
    if (inp.zB !== null) {
      this.tgtB = this.conv(inp.zB, sens);
      this.lastB = now;
    } else if (now - this.lastB > 300) this.tgtB = 0;
    if (inp.zC !== null) {
      this.tgtC = this.conv(inp.zC, sens);
      this.lastC = now;
    } else if (now - this.lastC > 300) this.tgtC = 0;
    if (!this.okB) this.tgtB = 0;
    if (!this.okC) this.tgtC = 0;
    const up = 1 - Math.exp(-dt / 0.05);
    const dn = 1 - Math.exp(-dt / 0.4);
    this.aB += (this.tgtB - this.aB) * (this.tgtB > this.aB ? up : dn);
    this.aC += (this.tgtC - this.aC) * (this.tgtC > this.aC ? up : dn);
    this.T = (this.okB ? this.aB : 0) + (this.okC ? this.aC : 0);
    this.L = this.okB && this.okC ? (this.aB - this.aC) / (this.aB + this.aC + 0.05) : 0;
    this.Lsm += (this.L - this.Lsm) * (1 - Math.exp(-dt / 0.25));

    // ---- 运动后验 ----
    const prev = this.marker.visible ? { x: this.marker.x, z: this.marker.z } : null;
    const r = this.posterior(this.aB, this.aC, this.okB, this.okC, this.cur, 1.6, prev);
    this.gate = r.gate;

    // ---- 静态物体层（慢）----
    const sb = inp.sB !== null ? this.conv(inp.sB, sens, 2.6, 6) : this.sbS;
    const sc = inp.sC !== null ? this.conv(inp.sC, sens, 2.6, 6) : this.scS;
    const tg = inp.staticActive ? 1 : 0;
    const k1 = 1 - Math.exp(-dt / 1.0);
    this.sbS += (sb * tg - this.sbS) * k1;
    this.scS += (sc * tg - this.scS) * k1;
    const rs = this.posterior(this.sbS, this.scS, this.okB, this.okC, this.stat, 1.6, null);
    this.statLevel = rs.gate;
    for (let k = 0; k < this.stat.length; k++) this.stat[k] *= 0.55;

    // ---- 标记（目标）----
    const m = this.marker;
    const wantOn = r.gate > 0.35;
    if (wantOn) {
      this.onCnt++;
      this.offT = 0;
    } else {
      this.onCnt = 0;
      if (r.gate < 0.15) this.offT += dt;
    }
    if (!m.visible && this.onCnt >= 2 && r.ix >= 0) {
      m.visible = true;
      m.x = this.cellX(r.ix);
      m.z = this.cellZ(r.iz);
      m.vx = m.vz = 0;
      this.trail = [];
    } else if (m.visible && this.offT > 0.4) {
      m.visible = false;
    }
    if (m.visible && r.ix >= 0 && r.gate > 0.15) {
      const tx = this.cellX(r.ix);
      const tz = this.cellZ(r.iz);
      const al = 1 - Math.exp(-dt / 0.12);
      const nx = m.x + (tx - m.x) * al;
      const nz = m.z + (tz - m.z) * al;
      const kv = 1 - Math.exp(-dt / 0.3);
      m.vx += ((nx - m.x) / dt - m.vx) * kv;
      m.vz += ((nz - m.z) / dt - m.vz) * kv;
      m.x = nx;
      m.z = nz;
      m.conf = r.gate * (1 - Math.min(1, r.frac * 2.5));
      m.spread = Math.sqrt(Math.max(0.0004, r.frac) * this.W * this.D / Math.PI);
      if (now - this.lastMarkerAt > 50) {
        this.trail.push({ x: m.x, z: m.z, t: now });
        this.lastMarkerAt = now;
        while (this.trail.length > 80 || (this.trail.length && now - this.trail[0].t > 4000)) this.trail.shift();
      }
    } else if (!m.visible) {
      m.vx *= 0.9;
      m.vz *= 0.9;
    }
    m.alpha += ((m.visible ? 1 : 0) - m.alpha) * (1 - Math.exp(-dt / (m.visible ? 0.1 : 0.35)));
    if (m.alpha < 0.01) m.alpha = 0;
    // ---- 紧凑物体峰 + 尾迹脊 ----
    const A = m.alpha * Math.min(1, 0.4 + 0.6 * Math.min(1, this.T));
    m.h = A;
    const sig = clamp(m.spread * 0.55, 0.22 * Math.max(0.5, this.W / 6), 0.7 * Math.max(0.5, this.W / 6));
    const inv = 1 / (2 * sig * sig);
    const dec = Math.exp(-dt / 1.6);
    for (let j = 0; j < PG_N; j++) {
      const dz = this.cellZ(j) - m.z;
      for (let i = 0; i < PG_N; i++) {
        const k = j * PG_N + i;
        const dx = this.cellX(i) - m.x;
        const v = A > 0.003 ? A * Math.exp(-(dx * dx + dz * dz) * inv) : 0;
        this.blob[k] = v;
        const w = this.wake[k] * dec;
        const vv = v * 0.8;
        this.wake[k] = vv > w ? vv : w;
      }
    }

    // ---- 历史（HUD 时间轴）----
    this.hist.push({ t: now, aB: this.okB ? this.aB : 0, aC: this.okC ? this.aC : 0, vis: m.visible });
    while (this.hist.length > 320 || (this.hist.length && now - this.hist[0].t > 16000)) this.hist.shift();

    // ---- 方向 / 靠近远离（0.8s 差分）----
    let ref: HistSample | null = null;
    for (let i = this.hist.length - 1; i >= 0; i--) {
      if (now - this.hist[i].t >= 800) {
        ref = this.hist[i];
        break;
      }
    }
    if (ref && this.T > 0.12 && this.okB && this.okC) {
      const Lr = (ref.aB - ref.aC) / (ref.aB + ref.aC + 0.05);
      const dL = this.Lsm - Lr;
      this.dirSign = Math.abs(dL) > 0.3 ? (dL < 0 ? -1 : 1) : 0;
      const Tr = ref.aB + ref.aC;
      this.approach = this.T > Tr * 1.4 + 0.05 ? 1 : this.T < Tr * 0.7 - 0.02 ? -1 : 0;
    } else if (this.T < 0.1) {
      this.dirSign = 0;
      this.approach = 0;
    }
    if (this.compact) this.dirSign = 0;
    const side = this.compact ? "" : this.Lsm > 0.25 ? "偏 B 侧" : this.Lsm < -0.25 ? "偏 C 侧" : "居中（A 方向/两侧均衡）";
    const mv = this.dirSign < 0 ? "正从 B 侧向 C 侧经过" : this.dirSign > 0 ? "正从 C 侧向 B 侧经过" : "";
    const ap = this.approach > 0 ? "，正在靠近" : this.approach < 0 ? "，正在远离" : "";
    this.dirText = this.T > 0.1 ? (mv || side || (this.compact ? "有物体经过（阵列过小，方向不可分辨）" : "")) + ap : "";

    // ---- 过路事件 ----
    if (m.visible && !this.ev) {
      this.ev = { t0: now, peak: this.T, xs: [] };
    }
    if (this.ev) {
      this.ev.peak = Math.max(this.ev.peak, this.T);
      if (r.gate > 0.35) this.ev.xs.push(m.x);
      if (!m.visible && this.offT > 0.4) {
        const dur = (now - this.ev.t0) / 1000 - 0.4;
        if (dur > 0.25) {
          const xs = this.ev.xs;
          const n = Math.max(1, Math.min(6, Math.floor(xs.length / 3)));
          const avg = (a: number[]) => (a.length ? a.reduce((q, v) => q + v, 0) / a.length : 0);
          const x0 = avg(xs.slice(0, n));
          const x1 = avg(xs.slice(-n));
          const dx = x1 - x0; // x 增大 = 从 B(左) 走向 C(右)
          const thr = Math.max(0.5, this.W * 0.1);
          const sign = Math.abs(dx) > thr ? (dx > 0 ? -1 : 1) : 0;
          const xm = avg(xs);
          const dir =
            sign < 0 ? "B 侧 → C 侧" : sign > 0 ? "C 侧 → B 侧" : this.compact ? "经过（阵列过小，方向不可分辨）" : xm < -thr ? "停留/掠过 B 侧" : xm > thr ? "停留/掠过 C 侧" : "居中经过";
          this.events.unshift({ at: Date.now(), dur, peak: this.ev.peak, dir, sign });
          if (this.events.length > 8) this.events.pop();
        }
        this.ev = null;
      }
    }
  }
}
