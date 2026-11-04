// 合成 CSI 场景：用于「启动演示数据」和命令行 e2e 测试（与真实固件输出的二进制帧格式完全相同）
// 物理模型：H(f) = Σ a_i · exp(-j2π f τ_i)，再叠加每包随机相位 / 定时偏移(STO) / AGC / 噪声，并量化成 int8。
import { C, DF } from "./dsp";
import type { RawRec } from "./protocol";

export interface Reflector {
  L: number; // 路径长度 (m)
  a: number; // 幅度
}

export class Rng {
  private s: number;
  constructor(seed = 12345) {
    this.s = seed >>> 0;
  }
  next() {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  gauss() {
    const u = Math.max(1e-9, this.next());
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

export class SynthScene {
  baseline: number;
  homeCh: number;
  reflectors: Reflector[];
  person = { L: 19, swing: 2.2, freq: 0.07, a: 0.38, breath: 0.004, breathHz: 0.27, on: true };
  noise = 1.3;
  stoNs = 14;
  private rng: Rng;
  private cnt = [0, 0];

  constructor(baseline = 3, homeCh = 6, seed = 7) {
    this.baseline = baseline;
    this.homeCh = homeCh;
    this.rng = new Rng(seed);
    this.reflectors = [
      { L: 9.5, a: 0.5 },
      { L: 15.2, a: 0.36 },
      { L: 24.5, a: 0.24 },
    ];
  }

  paths(t: number): Reflector[] {
    const p: Reflector[] = [{ L: this.baseline, a: 1 }, ...this.reflectors];
    if (this.person.on) {
      const pr = this.person;
      p.push({
        L: pr.L + pr.swing * Math.sin(2 * Math.PI * pr.freq * t) + pr.breath * Math.sin(2 * Math.PI * pr.breathHz * t),
        a: pr.a,
      });
    }
    return p;
  }

  /** 生成一条 CSI 记录（接收节点 node 收到对端帧）。t 为秒。 */
  rec(node: number, ch: number, sweepId: number, t: number, tms: number): RawRec {
    const paths = this.paths(t);
    const fc = (2412 + 5 * (ch - 1)) * 1e6;
    const theta = this.rng.next() * 2 * Math.PI;
    const sto = (this.rng.gauss() * this.stoNs * 1e-9) % 1e-6;
    const gain = 38 * (0.75 + 0.5 * this.rng.next());
    const csi = new Int8Array(128);
    for (let s = 0; s < 64; s++) {
      const k = s < 32 ? s : s - 64;
      let re = 0;
      let im = 0;
      if (k !== 0 && Math.abs(k) <= 26) {
        const f = fc + k * DF;
        for (const p of paths) {
          const ph = -2 * Math.PI * f * (p.L / C);
          re += p.a * Math.cos(ph);
          im += p.a * Math.sin(ph);
        }
        const ph2 = theta - 2 * Math.PI * k * DF * sto;
        const c2 = Math.cos(ph2);
        const s2 = Math.sin(ph2);
        const r = re * c2 - im * s2;
        const i = re * s2 + im * c2;
        re = r * gain + this.rng.gauss() * this.noise;
        im = i * gain + this.rng.gauss() * this.noise;
      }
      csi[2 * s] = Math.max(-127, Math.min(127, Math.round(im)));
      csi[2 * s + 1] = Math.max(-127, Math.min(127, Math.round(re)));
    }
    const d = node - 1;
    return { link: 0, ch, rssi: -48 + Math.round(this.rng.gauss() * 2), sweepId, cnt: this.cnt[d]++, tms, csi };
  }

  /** 一轮扫频：1..13 信道，每信道每方向 perCh 条 */
  sweep(sweepId: number, t: number, tms: number, perCh = 7): { node: number; rec: RawRec }[] {
    const out: { node: number; rec: RawRec }[] = [];
    for (let ch = 1; ch <= 13; ch++) {
      for (let i = 0; i < perCh; i++) {
        const tt = t + ((ch - 1) * 30 + i * 3) / 1000;
        out.push({ node: 1, rec: this.rec(1, ch, sweepId, tt, tms + (ch - 1) * 30 + i * 3) });
        out.push({ node: 2, rec: this.rec(2, ch, sweepId, tt, tms + (ch - 1) * 30 + i * 3) });
      }
    }
    return out;
  }
}
