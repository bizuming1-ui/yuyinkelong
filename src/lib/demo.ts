// 演示数据：合成"有人走动 / 静止"的 CSI（与真实固件二进制帧格式完全一致，走同一条检测流水线）。
// 物理模型：H(f)=Σ a_i·exp(-j2πfτ_i) + 每包随机相位/STO/AGC/噪声，量化成 int8。
import { C, DF } from "./dsp";
import { LINK_AP, LINK_PEER, type CsiFrame } from "./protocol";
import { Rng } from "./synth";

interface Path {
  L: number;
  a: number;
}

export class DemoHuman {
  private rng = new Rng(2025);
  private cnt = 0;
  base = 3;
  humanA = 0.14;
  /** 先安静 10 秒（让检测器学习环境）→ 走 12 秒 → 静止 12 秒 循环 */
  walking(t: number) {
    return t >= 10 && (t - 10) % 24 < 12;
  }
  /** 人在椭圆上的归一化位置 -1..1（供 3D 路径长度使用） */
  pos(t: number) {
    return Math.sin(t * 0.55);
  }

  private frame(node: number, link: number, paths: Path[]): CsiFrame {
    const rng = this.rng;
    const fc = 2437e6;
    const theta = rng.next() * 2 * Math.PI;
    const sto = rng.gauss() * 12e-9;
    let gain = 38 * (1 + 0.05 * rng.gauss());
    if (rng.next() < 0.01) gain *= 0.5;
    const re = new Float32Array(64);
    const im = new Float32Array(64);
    for (let s = 0; s < 64; s++) {
      const k = s < 32 ? s : s - 64;
      if (k === 0 || Math.abs(k) > 26) continue;
      const f = fc + k * DF;
      let r = 0;
      let i = 0;
      for (const p of paths) {
        const ph = -2 * Math.PI * f * (p.L / C);
        r += p.a * Math.cos(ph);
        i += p.a * Math.sin(ph);
      }
      const ph2 = theta - 2 * Math.PI * k * DF * sto;
      const c2 = Math.cos(ph2);
      const s2 = Math.sin(ph2);
      re[s] = Math.max(-127, Math.min(127, Math.round((r * c2 - i * s2) * gain + rng.gauss() * 1.3)));
      im[s] = Math.max(-127, Math.min(127, Math.round((r * s2 + i * c2) * gain + rng.gauss() * 1.3)));
    }
    return { node, link, ch: 6, rssi: -45, sweepId: 0, cnt: this.cnt++ & 0xffff, tms: 0, re, im };
  }

  /** 生成这一刻的一组连续流帧（2 条板间链路 + 2 条路由器链路） */
  tick(t: number, withAp: boolean): CsiFrame[] {
    const out: CsiFrame[] = [];
    const w = this.walking(t);
    const hum = (L0: number, k: number): Path[] =>
      w
        ? [{ L: L0 + 3 + this.pos(t) * 4 + 0.15 * Math.sin(2 * Math.PI * 1.8 * t) + 0.08 * Math.sin(2 * Math.PI * 3.1 * t + k), a: this.humanA * (0.8 + 0.4 * Math.sin(2 * Math.PI * 0.5 * t + k)) }]
        : [];
    for (const node of [1, 2]) {
      out.push(
        this.frame(node, LINK_PEER, [
          { L: this.base, a: 1 },
          { L: this.base + 4.1, a: 0.35 },
          { L: this.base + 7.3, a: 0.25 },
          { L: this.base + 11.2, a: 0.2 },
          ...hum(this.base, node),
        ]),
      );
      if (withAp)
        out.push(
          this.frame(node, LINK_AP, [
            { L: 6 + node, a: 1 },
            { L: 7.4, a: 0.4 },
            { L: 10.1, a: 0.3 },
            { L: 13.9, a: 0.18 },
            ...hum(6 + node, node * 2),
          ]),
        );
    }
    return out;
  }
}
