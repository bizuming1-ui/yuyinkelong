// 运动检测验证（无需硬件）：  npx tsx tools/motion_sim.ts
// 物理模型：H(f)=Σ a_i·exp(-j2πfτ_i)，叠加每包随机相位/STO、AGC 抖动、热噪声、偶发干扰，量化为 int8，
// 与固件输出的 CsiFrame 格式一致。场景：空房间、走动、"校准时就在走动"、微弱目标、强 AGC 抖动。
import { Detector } from "../src/lib/detector";
import { C, DF } from "../src/lib/dsp";
import { Rng } from "../src/lib/synth";
import type { CsiFrame } from "../src/lib/protocol";

interface Path {
  L: number;
  a: number;
}
interface Cfg {
  humanA: number; // 人体反射相对直达波幅度
  agc: number; // 每包增益抖动(比例)
  noise: number; // int8 计数噪声 σ
  base: number;
}

function genFrame(rng: Rng, node: number, link: number, paths: Path[], cfg: Cfg, cnt: number): CsiFrame {
  const fc = 2437e6;
  const theta = rng.next() * 2 * Math.PI;
  const sto = rng.gauss() * 12e-9;
  let gain = 38 * (1 + cfg.agc * rng.gauss());
  if (rng.next() < 0.01) gain *= 0.5; // 偶发干扰
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
    const rr = (r * c2 - i * s2) * gain + rng.gauss() * cfg.noise;
    const ii = (r * s2 + i * c2) * gain + rng.gauss() * cfg.noise;
    re[s] = Math.max(-127, Math.min(127, Math.round(rr)));
    im[s] = Math.max(-127, Math.min(127, Math.round(ii)));
  }
  return { node, link, ch: 6, rssi: -40, sweepId: 0, cnt, tms: 0, re, im };
}

type Scn = (t: number) => { walking: boolean; pos: number };

/** 运行一个场景；返回 [逐 50ms 的 moving 数组, 检测器] */
function run(seed: number, cfg: Cfg, seconds: number, scn: Scn) {
  const rng = new Rng(seed);
  const det = new Detector();
  det.sensitivity = 1.5;
  const wall: Path[] = [
    { L: cfg.base + 4.1, a: 0.35 },
    { L: cfg.base + 7.3, a: 0.25 },
    { L: cfg.base + 11.2, a: 0.2 },
  ];
  const apWall: Path[] = [
    { L: 7.4, a: 0.4 },
    { L: 10.1, a: 0.3 },
    { L: 13.9, a: 0.18 },
  ];
  const moving: boolean[] = [];
  const times: number[] = [];
  let cnt = 0;
  const dtp = 0.025; // 每 25ms 一个"时间片"：peer 50Hz(每 20ms)，AP 25Hz
  let nextPeer = 0;
  let nextAp = 0;
  let nextUpd = 0;
  for (let t = 0; t < seconds; t += 0.005) {
    const now = t * 1000;
    const sc = scn(t);
    const human = (base: number, k: number): Path[] => {
      if (!sc.walking) return [];
      // 走动：路径长度大范围缓变 + 肢体引起的小幅快速变化
      const L = base + 3 + sc.pos * 4 + 0.15 * Math.sin(2 * Math.PI * 1.8 * t) + 0.08 * Math.sin(2 * Math.PI * 3.1 * t + k);
      return [{ L, a: cfg.humanA * (0.8 + 0.4 * Math.sin(2 * Math.PI * 0.5 * t + k)) }];
    };
    if (t >= nextPeer) {
      nextPeer += 0.02;
      for (const node of [1, 2]) {
        const paths = [{ L: cfg.base, a: 1 }, ...wall, ...human(cfg.base, node)];
        det.push(genFrame(rng, node, 0, paths, cfg, cnt++), now);
      }
    }
    if (t >= nextAp) {
      nextAp += dtp * 1.6; // 40ms → 25Hz
      for (const node of [1, 2]) {
        const paths = [{ L: 6 + node, a: 1 }, ...apWall, ...human(6 + node, node * 2)];
        det.push(genFrame(rng, node, 1, paths, cfg, cnt++), now);
      }
    }
    if (t >= nextUpd) {
      nextUpd += 0.05;
      det.update(now);
      moving.push(det.state.moving);
      times.push(t);
    }
  }
  return { moving, times, det };
}

let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(`${c ? "  ✔" : "  ✘"} ${m}`);
  if (!c) fail++;
};
const frac = (m: boolean[], t: number[], a: number, b: number) => {
  let n = 0;
  let k = 0;
  for (let i = 0; i < m.length; i++)
    if (t[i] >= a && t[i] < b) {
      n++;
      if (m[i]) k++;
    }
  return n ? k / n : 0;
};

if (process.env.DBG) {
  const r = run(5, { humanA: 0.15, agc: Number(process.env.AGC || 0.05), noise: 1.3, base: 3 }, 120, () => ({ walking: false, pos: 0 }));
  console.log("每10秒误报占比:", [0,1,2,3,4,5,6,7,8,9,10,11].map((i) => (frac(r.moving, r.times, i * 10, i * 10 + 10) * 100).toFixed(0)).join(" "));
  for (const id of ["p1", "p2", "a1", "a2"] as const) console.log(id, r.det.links[id].floors.map((x) => x.toFixed(4)).join(","), "score", r.det.links[id].smooth.toFixed(2));
  for (const id of ["p1", "a1"] as const) {
    const l = r.det.links[id];
    const cols = [0, 1, 2, 3].map((i) => {
      const a = l.hist.map((x) => x.s[i]).sort((x, y) => x - y);
      return `${a[0].toFixed(4)}/${a[Math.floor(a.length * 0.1)].toFixed(4)}/${a[Math.floor(a.length * 0.5)].toFixed(4)}/${a[Math.floor(a.length * 0.95)].toFixed(4)}/${a[a.length - 1].toFixed(4)}`;
    });
    console.log(id, "min/p10/p50/p95/max per stat:", cols.join("  |  "), "fps", l.fps.toFixed(1));
  }
}
if (process.env.DBG2) {
  const r = run(1008, { humanA: 0.15, agc: 0.05, noise: 1.3, base: 3 }, 30, (t) => ({ walking: t >= 20, pos: Math.sin(t * 0.8) }));
  for (const id of ["p1", "p2", "a1", "a2"] as const) {
    const l = r.det.links[id];
    console.log(id, "stats", l.stats.map((x) => x.toFixed(4)).join(","), "floor", l.floors.map((x) => x.toFixed(4)).join(","), "spread", l.spread.map((x) => x.toFixed(4)).join(","), "score", l.smooth.toFixed(2));
  }
}
const rounds = Number(process.argv[2] || 3);
for (let round = 1; round <= rounds; round++) {
  console.log(`\n===== 第 ${round} 轮验证 =====`);
  const seed = 1000 * round + 7;

  console.log("A. 空房间 120 秒：不应误报（含 AGC 抖动 5%、1% 干扰包）");
  {
    const cfg: Cfg = { humanA: 0.15, agc: 0.05, noise: 1.3, base: 3 };
    const r = run(seed, cfg, 120, () => ({ walking: false, pos: 0 }));
    const f = frac(r.moving, r.times, 12, 120);
    ok(f < 0.02, `误报占比 ${(f * 100).toFixed(2)}%（要求 <2%）`);
  }

  console.log("B. 20 秒安静后有人走动 20 秒再离开 20 秒（人体反射 0.15）");
  {
    const cfg: Cfg = { humanA: 0.15, agc: 0.05, noise: 1.3, base: 3 };
    const r = run(seed + 1, cfg, 60, (t) => ({ walking: t >= 20 && t < 40, pos: Math.sin(t * 0.8) }));
    const f1 = frac(r.moving, r.times, 22, 40);
    const f0 = frac(r.moving, r.times, 8, 19);
    const f2 = frac(r.moving, r.times, 44, 60);
    let lat = -1;
    for (let i = 0; i < r.times.length; i++) if (r.times[i] >= 20 && r.moving[i]) { lat = r.times[i] - 20; break; }
    ok(f1 > 0.93, `走动期检出率 ${(f1 * 100).toFixed(1)}%（要求 >93%）`);
    ok(lat >= 0 && lat < 1.0, `首次检出延迟 ${lat.toFixed(2)} 秒（要求 <1 秒）`);
    ok(f0 < 0.03 && f2 < 0.05, `走动前误报 ${(f0 * 100).toFixed(1)}% / 离开后残留 ${(f2 * 100).toFixed(1)}%`);
  }

  console.log("C. 启动时人就在走动（旧版会把走动当成基线而永远静止）");
  {
    const cfg: Cfg = { humanA: 0.15, agc: 0.05, noise: 1.3, base: 3 };
    // 0~25 秒一直走；25~55 秒离开（形成安静段）；55~75 秒再走
    const r = run(seed + 2, cfg, 80, (t) => ({ walking: t < 25 || (t >= 55 && t < 75), pos: Math.sin(t * 0.7) }));
    const f1 = frac(r.moving, r.times, 60, 75);
    const f0 = frac(r.moving, r.times, 40, 54);
    ok(f1 > 0.9, `再次走动检出率 ${(f1 * 100).toFixed(1)}%（要求 >90%）`);
    ok(f0 < 0.05, `离开期误报 ${(f0 * 100).toFixed(1)}%`);
  }

  console.log("D. 微弱目标（人体反射仅 0.06，约 -24dB）与强 AGC 抖动 25%");
  {
    const cfg: Cfg = { humanA: 0.06, agc: 0.05, noise: 1.3, base: 3 };
    const r = run(seed + 3, cfg, 60, (t) => ({ walking: t >= 20 && t < 40, pos: Math.sin(t * 0.8) }));
    const f1 = frac(r.moving, r.times, 22, 40);
    const f0 = frac(r.moving, r.times, 8, 19);
    ok(f1 > 0.85, `微弱目标检出率 ${(f1 * 100).toFixed(1)}%（要求 >85%）`);
    ok(f0 < 0.03, `误报 ${(f0 * 100).toFixed(1)}%`);
    const cfg2: Cfg = { humanA: 0.15, agc: 0.25, noise: 1.3, base: 3 };
    const r2 = run(seed + 4, cfg2, 120, () => ({ walking: false, pos: 0 }));
    ok(frac(r2.moving, r2.times, 12, 120) < 0.03, `强 AGC 抖动空房误报 ${(frac(r2.moving, r2.times, 12, 120) * 100).toFixed(2)}%`);
    const r3 = run(seed + 5, cfg2, 60, (t) => ({ walking: t >= 20 && t < 40, pos: Math.sin(t * 0.8) }));
    ok(frac(r3.moving, r3.times, 22, 40) > 0.9, `强 AGC 抖动下走动检出率 ${(frac(r3.moving, r3.times, 22, 40) * 100).toFixed(1)}%`);
  }
}
console.log(fail ? `\n✘ 共 ${fail} 项失败` : "\n✔ 全部通过");
process.exit(fail ? 1 : 0);
