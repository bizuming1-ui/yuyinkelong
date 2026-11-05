// ★ SIMULATION（仅演示/单元测试，界面上始终带有醒目的「SIMULATION」标识，绝不冒充真实成像）★
// 1) SimPerson：行走轨迹（停留—行走循环）
// 2) synthLinkZ：按「双基地雷达方程」前向模型生成两路链路 z 分数 + 乘性噪声（特征级仿真）
// 3) synthCsi：生成物理上合理的合成 CSI（多径 + 运动反射体 + 随机 CFO/相位 + AGC 抖动 + int8 量化），
//    用来测试 features.ts 的整条特征流水线（tools/tri_sim_test.ts）
import type { Geometry } from "./geometry";

export function rng(seed: number) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SimState {
  x: number;
  z: number;
  moving: boolean;
}

/** 周期 40s：静止空房 8s → 沿椭圆路线行走 22s → 离开 10s */
export class SimPerson {
  constructor(
    public W: number,
    public D: number,
  ) {}
  at(t: number): SimState {
    const T = 40;
    const u = ((t % T) + T) % T;
    if (u < 8 || u >= 30) return { x: 0, z: 0, moving: false };
    const ph = ((u - 8) / 22) * Math.PI * 2;
    return { x: Math.sin(ph) * this.W * 0.3, z: Math.sin(ph * 2 + 0.7) * this.D * 0.28 - this.D * 0.05, moving: true };
  }
}

export function linkW(g: Geometry, rx: "B" | "C", x: number, z: number, r0 = 0.6) {
  const r = rx === "B" ? g.B : g.C;
  const dA = Math.max(0.25, Math.hypot(x - g.A[0], z - g.A[1]));
  const dR = Math.max(0.25, Math.hypot(x - r[0], z - r[1]));
  return Math.min(1, (r0 * r0) / (dA * dR));
}

export function synthLinkZ(g: Geometry, s: SimState, rand: () => number, gain = 40): { zB: number; zC: number } {
  const noise = () => Math.exp(0.35 * (rand() + rand() + rand() - 1.5) * 2);
  const base = () => Math.abs(0.35 * (rand() + rand() + rand() - 1.5) * 2) * 1.2; // 空房时的噪声 z
  if (!s.moving) return { zB: base(), zC: base() };
  return { zB: base() + gain * linkW(g, "B", s.x, s.z) * noise(), zC: base() + gain * linkW(g, "C", s.x, s.z) * noise() };
}

// ---- 合成 CSI -------------------------------------------------------------------------------
export function synthCsi(opts: { rand: () => number; t: number; moving: boolean; pathBase: number; node: number; moveAmp?: number }): Int8Array {
  const { rand, t, moving, node } = opts;
  const df = 312500; // 子载波间隔 Hz
  const out = new Int8Array(128);
  // 静态多径（每个节点不同但固定）
  const taus = [20e-9 + node * 3e-9, 55e-9, 110e-9, 190e-9];
  const amps = [1.0, 0.45, 0.3, 0.18];
  const ph0 = [0.3 * node, 1.1, 2.3, 4.0];
  // 运动反射体：时延随运动缓慢变化，约 0.7 Hz 步频
  const tauM = 70e-9 + (moving ? 22e-9 * Math.sin(2 * Math.PI * 0.9 * t) + 10e-9 * Math.sin(2 * Math.PI * 2.3 * t) : 0);
  const ampM = moving ? (opts.moveAmp ?? 0.35) : 0;
  // 每包随机公共相位（CFO/STO 残差）、线性相位斜率（SFO）、AGC 增益
  const cp = rand() * 2 * Math.PI;
  const slope = (rand() - 0.5) * 0.25;
  const agc = 38 * Math.exp((rand() - 0.5) * 0.12);
  for (let idx = 0; idx < 64; idx++) {
    const k = idx < 32 ? idx : idx - 64;
    if (k === 0 || Math.abs(k) > 26) continue;
    const f = k * df;
    let re = 0;
    let im = 0;
    for (let l = 0; l < 4; l++) {
      const a = amps[l];
      const th = -2 * Math.PI * f * taus[l] + ph0[l];
      re += a * Math.cos(th);
      im += a * Math.sin(th);
    }
    const thm = -2 * Math.PI * f * tauM + 1.7;
    re += ampM * Math.cos(thm);
    im += ampM * Math.sin(thm);
    const th2 = cp + slope * k;
    const cr = Math.cos(th2);
    const ci = Math.sin(th2);
    const rr = re * cr - im * ci + 0.012 * (rand() - 0.5) * 2;
    const ii = re * ci + im * cr + 0.012 * (rand() - 0.5) * 2;
    out[2 * idx] = Math.max(-127, Math.min(127, Math.round(ii * agc)));
    out[2 * idx + 1] = Math.max(-127, Math.min(127, Math.round(rr * agc)));
  }
  return out;
}
