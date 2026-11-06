// Imager25D 量化验证（提示词 v5 · 4.5）。★ 全部为 SIMULATION_ONLY：只证明代码在该仿真假设下的行为，不证明实机精度 ★
// 运行：npx tsx tools/tri_imager_test.ts 3      （参数 = 重复轮数；全部通过才 exit 0，失败 exit(1)）
//
// 覆盖：
//  A) 同模型仿真（实现自洽测试）：RMSE / 中位数 / 对比「猜中心」基线 / 熵与误差相关性
//  B) 模型失配仿真（不同 r0、指数、对数正态阴影、突发离群值）：不得显著差于基线（诚实，不夸大）
//  C) 空房 / 无运动：active=false 时不得凭空出峰（available=false）
//  D) 单路退化：spread 变大、mode=single、reason 含「单路」、conf 更低
//  E) 重复观测不重复计权：只做预测（null 观测）时熵不得下降
//  F) 完整流水线：synthCsi → LinkAnalyzer → FusedDetector → Imager25D
//  G) 确定性：同一输入序列两次运行输出完全一致
import { FusedDetector, LinkAnalyzer } from "../src/lib/tri/features";
import { makeGeometry } from "../src/lib/tri/geometry";
import { Imager25D, type ImagerQuality } from "../src/lib/tri/imager25d";
import { SimPerson, linkW, rng, synthCsi, synthLinkZ } from "../src/lib/tri/sim";
import type { TriFrame } from "../src/lib/tri/protocol";

import type { Geometry } from "../src/lib/tri/geometry";
// 参数覆盖仅用于调参实验（DBG_* 环境变量）；默认值即产品值
function newIm(g: Geometry, W: number, D: number, n = 64) {
  const im = new Imager25D(g, W, D, n);
  const e = process.env;
  if (e.IM_SIGMA) im.sigma = +e.IM_SIGMA;
  if (e.IM_SIGMAG) im.sigmaG = +e.IM_SIGMAG;
  if (e.IM_BETA) im.beta = +e.IM_BETA;
  if (e.IM_V) im.vMove = +e.IM_V;
  return im;
}
let fails = 0;
const ok = (c: boolean, msg: string) => {
  console.log(`${c ? "  ✓" : "  ✗"} ${msg}`);
  if (!c) fails++;
};
const Q2: ImagerQuality = { presenceConf: 0.9, dataQuality: 0.95, linksOnline: 2, pairedPct: 0.95, rate: 90, lossPct: 0.02 };
const pct = (a: number[], q: number) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const corr = (x: number[], y: number[]) => {
  const n = x.length;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  return sxy / Math.sqrt(sxx * syy + 1e-12);
};

type ZGen = (s: { x: number; z: number; moving: boolean }, r: () => number) => { zB: number; zC: number };

function runFeatureLevel(seed: number, side: number, gen: ZGen, opts: { dropC?: boolean; T?: number } = {}) {
  const W = 6;
  const D = 6;
  const g = makeGeometry(side);
  const im = newIm(g, W, D, 64);
  const person = new SimPerson(W, D);
  const r = rng(seed * 13 + 5);
  const dt = 0.05;
  const errs: number[] = [];
  const base: number[] = [];
  const ent: number[] = [];
  const spreads: number[] = [];
  const confs: number[] = [];
  let ghost = 0;
  let idleN = 0;
  let lastModes = "";
  const T = opts.T ?? 120;
  for (let k = 0; k < T / dt; k++) {
    const t = k * dt;
    const s = person.at(t);
    const fresh = k % 4 === 0; // 5Hz 窗口
    const z = gen(s, r);
    const est = im.update(fresh ? { zB: z.zB, zC: opts.dropC ? null : z.zC } : { zB: null, zC: null }, s.moving, { ...Q2, linksOnline: opts.dropC ? 1 : 2 }, dt, t * 1000);
    if (!s.moving) {
      idleN++;
      if (est.available) ghost++;
    } else if (est.available && t % 40 > 11) {
      errs.push(Math.hypot(est.peakX - s.x, est.peakZ - s.z));
      base.push(Math.hypot(s.x, s.z));
      ent.push(est.entropy);
      spreads.push(est.spread);
      confs.push(est.conf25d);
      lastModes = est.mode;
    }
  }
  const rmse = Math.sqrt(errs.reduce((a, b) => a + b * b, 0) / errs.length);
  const rmseBase = Math.sqrt(base.reduce((a, b) => a + b * b, 0) / base.length);
  return { rmse, rmseBase, median: pct(errs, 0.5), p90: pct(errs, 0.9), corrEntErr: corr(ent, errs), spread: spreads.reduce((a, b) => a + b, 0) / spreads.length, conf: confs.reduce((a, b) => a + b, 0) / confs.length, ghost, idleN, mode: lastModes };
}

const matched: ZGen = (s, r) => synthLinkZ(makeGeometry(2), s, r);
// 失配模型：不同 r0 与路径指数，对数正态阴影，5% 突发离群值（合成数据，与 Imager 的前向模型不同）
const mismatched: ZGen = (s, r) => {
  const g = makeGeometry(2);
  const noise = () => Math.exp(0.6 * (r() + r() + r() - 1.5) * 2);
  const base = () => Math.abs(0.35 * (r() + r() + r() - 1.5) * 2) * 1.2;
  if (!s.moving) return { zB: base(), zC: base() };
  const f = (rx: "B" | "C") => {
    const w = linkW(g, rx, s.x, s.z, 0.9) ** 0.8;
    const out = r() < 0.05 ? 3 : 1;
    return base() + 25 * w * noise() * out;
  };
  return { zB: f("B"), zC: f("C") };
};

function round(seed: number) {
  console.log(`\n===== SIMULATION_ONLY · 第 ${seed} 轮 =====`);

  // A
  const A = runFeatureLevel(seed, 2, matched);
  console.log(`  [A 同模型 SIMULATION_ONLY] 边长 2m：RMSE=${A.rmse.toFixed(2)}m 中位=${A.median.toFixed(2)}m P90=${A.p90.toFixed(2)}m 基线(猜中心)=${A.rmseBase.toFixed(2)}m 熵-误差相关=${A.corrEntErr.toFixed(2)} 平均 spread=${A.spread.toFixed(2)}m conf25d=${A.conf.toFixed(2)}`);
  ok(A.rmse < A.rmseBase * 0.85, "A: 2m 阵列 Imager25D 比「猜中心」误差小 ≥15%");
  ok(A.corrEntErr > -0.2, "A: 熵与误差不呈负相关（熵越大不应越准）");

  // B
  const B = runFeatureLevel(seed + 50, 2, mismatched);
  console.log(`  [B 模型失配 SIMULATION_ONLY] RMSE=${B.rmse.toFixed(2)}m 基线=${B.rmseBase.toFixed(2)}m P90=${B.p90.toFixed(2)}m conf25d=${B.conf.toFixed(2)}`);
  ok(B.rmse < B.rmseBase * 1.1, "B: 模型失配下不显著差于基线（不夸大精度）");

  // C
  ok(A.ghost === 0, `C: 无运动期间 ${A.idleN} 步，grid 凭空出峰次数 = ${A.ghost}`);

  // D
  const D1 = runFeatureLevel(seed, 2, matched, { dropC: true });
  console.log(`  [D 单路退化] spread ${D1.spread.toFixed(2)}m（双路 ${A.spread.toFixed(2)}m）conf25d ${D1.conf.toFixed(2)}（双路 ${A.conf.toFixed(2)}）`);
  ok(D1.spread > A.spread, "D: 单路退化后验更弥散（spread 变大）");
  ok(D1.conf < A.conf, "D: 单路退化 conf25d 下降");
  ok(D1.mode === "single", "D: 单路退化 mode=single");
  {
    const im = newIm(makeGeometry(2), 6, 6);
    const e = im.update({ zB: 12, zC: null }, true, { ...Q2, linksOnline: 1 }, 0.05, 0);
    ok(e.reason.includes("单路"), "D: reason 含「单路退化」");
  }

  // E：重复/缺失观测不得让后验变尖
  {
    const g = makeGeometry(2);
    const im = newIm(g, 6, 6);
    const person = new SimPerson(6, 6);
    const r = rng(seed);
    let e = im.update({ zB: 1, zC: 1 }, true, Q2, 0.05, 0);
    for (let k = 0; k < 8; k++) {
      const z = synthLinkZ(g, { ...person.at(15), moving: true }, r);
      e = im.update({ zB: z.zB, zC: z.zC }, true, Q2, 0.2, 1000 * (k + 1));
    }
    const H0 = e.entropy;
    let mono = true;
    let prev = H0;
    for (let k = 0; k < 50; k++) {
      e = im.update({ zB: null, zC: null }, true, Q2, 0.05, 9000 + 50 * k);
      if (e.entropy < prev - 1e-4) mono = false;
      prev = e.entropy;
    }
    ok(mono && e.entropy >= H0 - 1e-4, `E: 无新观测时熵不下降（${H0.toFixed(3)} → ${e.entropy.toFixed(3)}）→ 不会重复计权`);
    ok(e.mode === "stale" && e.reason.includes("观测过期"), "E: 无新观测超过 2s → mode=stale 且 reason 正确");
  }

  // F：完整流水线
  {
    const side = 2;
    const g = makeGeometry(side);
    const r = rng(seed * 101);
    const B = new LinkAnalyzer(2);
    const C = new LinkAnalyzer(3);
    const det = new FusedDetector();
    const im = newIm(g, 6, 6, 64);
    const person = new SimPerson(6, 6);
    const mk = (node: number, csi: Int8Array, cnt: number): TriFrame => {
      const re = new Float32Array(64);
      const imv = new Float32Array(64);
      for (let s = 0; s < 64; s++) {
        imv[s] = csi[2 * s];
        re[s] = csi[2 * s + 1];
      }
      return { node, boot: 1, paired: true, ch: 6, rssi: -45, noise: -95, seqA: cnt & 0xffff, rxCnt: cnt & 0xffff, tms: 0, droppedTotal: 0, re, im: imv };
    };
    let cnt = 0;
    let lastB = 0;
    let lastC = 0;
    const errs: number[] = [];
    const errsMean: number[] = [];
    const zs: number[][] = [];
    const base: number[] = [];
    let ghost = 0;
    let idle = 0;
    let avail = 0;
    let mov = 0;
    const T = 240;
    for (let step = 0; step < T * 100; step++) {
      const t = step / 100;
      const tt = t - 60; // 前 60s 空房校准
      const s = tt < 0 ? { x: 0, z: 0, moving: false } : person.at(tt);
      for (const node of [2, 3]) {
        const w = linkW(g, node === 2 ? "B" : "C", s.x, s.z);
        const csi = synthCsi({ rand: r, t, moving: s.moving, pathBase: 0, node, moveAmp: Math.min(0.8, 0.02 + 0.9 * w) });
        (node === 2 ? B : C).pushFrame(mk(node, csi, cnt), t * 1000);
      }
      cnt++;
      if (step % 5 === 0) {
        const now = t * 1000;
        const mb = B.tick(now);
        const mc = C.tick(now);
        const f = det.update(mb, mc, now);
        const okB = mb.valid && now - mb.lastAt < 1500 && mb.rate >= 5;
        const okC = mc.valid && now - mc.lastAt < 1500 && mc.rate >= 5;
        const fresh = (okB && mb.win !== lastB) || (okC && mc.win !== lastC);
        lastB = mb.win;
        lastC = mc.win;
        const q: ImagerQuality = { presenceConf: f.conf, dataQuality: f.quality, linksOnline: (okB ? 1 : 0) + (okC ? 1 : 0), pairedPct: Math.min(mb.pairedPct, mc.pairedPct), rate: Math.min(mb.rate, mc.rate), lossPct: Math.max(mb.lossPct, mc.lossPct) };
        const e = im.update(fresh ? { zB: okB ? mb.z : null, zC: okC ? mc.z : null } : { zB: null, zC: null }, f.state === "motion", q, 0.05, now, f.state === "offline" || f.state === "calibrating");
        if (t > 30 && tt < 0) {
          idle++;
          if (e.available) ghost++;
        }
        if (tt >= 0 && s.moving && tt % 40 > 12) {
          mov++;
          if (e.available) {
            avail++;
            errs.push(Math.hypot(e.peakX - s.x, e.peakZ - s.z));
            errsMean.push(Math.hypot(e.meanX - s.x, e.meanZ - s.z));
            zs.push([mb.z, mc.z, linkW(g, "B", s.x, s.z), linkW(g, "C", s.x, s.z)]);
            base.push(Math.hypot(s.x, s.z));
          }
        }
      }
    }
    if (process.env.DBG) console.log(zs.slice(0, 400).filter((_, i) => i % 40 === 0).map((a) => a.map((v) => v.toFixed(2)).join(",")).join(" | "));
    const rmseMean = Math.sqrt(errsMean.reduce((a, b) => a + b * b, 0) / Math.max(1, errsMean.length));
    console.log(`  [F] 后验均值 RMSE=${rmseMean.toFixed(2)}m`);
    const rmse = Math.sqrt(errs.reduce((a, b) => a + b * b, 0) / Math.max(1, errs.length));
    const rb = Math.sqrt(base.reduce((a, b) => a + b * b, 0) / Math.max(1, base.length));
    console.log(`  [F 完整流水线 SIMULATION_ONLY] 空房 ${idle} 步 grid 误报=${ghost}；运动 ${mov} 步中 grid 可用 ${((avail / Math.max(1, mov)) * 100).toFixed(0)}%；RMSE=${rmse.toFixed(2)}m（猜中心 ${rb.toFixed(2)}m）`);
    ok(ghost === 0, "F: 空房校准后 grid 不凭空出峰");
    ok(avail / Math.max(1, mov) > 0.8, "F: 运动时 grid 可用率 > 80%");
    console.log(`  [F 诚实结论] MAP 峰值在「2 个标量约束」下呈弧形歧义，RMSE(峰值)=${rmse.toFixed(2)}m 不可靠；后验均值 RMSE=${rmseMean.toFixed(2)}m≈基线 ${rb.toFixed(2)}m。完整流水线（未标定 z）只承诺「有无运动 + 粗略方位概率」，UI 以后验云 + 不确定度表达，不把 MAP 当精确位置。`);
    ok(rmseMean < rb * 1.15, "F: 完整流水线后验均值不显著差于「猜中心」基线（≤1.15×；合成 CSI，含 CFO/AGC/量化噪声）");
  }

  // G：确定性
  {
    const h = () => {
      const g = makeGeometry(2);
      const im = newIm(g, 6, 6, 32);
      const person = new SimPerson(6, 6);
      const r = rng(4242);
      let acc = 0;
      for (let k = 0; k < 600; k++) {
        const s = person.at(k * 0.05);
        const z = synthLinkZ(g, s, r);
        const e = im.update(k % 4 === 0 ? z : { zB: null, zC: null }, s.moving, Q2, 0.05, k * 50);
        acc = (acc * 31 + Math.round(e.peakX * 1e4) + Math.round(e.entropy * 1e4) * 7) % 1000000007;
      }
      return acc;
    };
    ok(h() === h(), "G: 同输入序列两次运行输出完全一致（确定性，无随机数污染）");
  }
}

const rounds = Math.max(1, parseInt(process.argv[2] || "1", 10));
for (let i = 1; i <= rounds; i++) round(i);
if (fails) {
  console.log(`\n❌ 失败 ${fails} 项（SIMULATION_ONLY）`);
  process.exit(1);
}
console.log("\n全部通过 ✅（SIMULATION_ONLY：仿真假设下的实现自洽，不代表实机精度）");
