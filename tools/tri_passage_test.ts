// SIMULATION_ONLY —— 「过路成像」引擎（src/lib/tri/passage.ts）的无硬件验证。
// 用 sim.ts 的双基地前向模型生成两路链路 z（含乘性噪声），驱动 PassageEngine，检查：
//   1) 空房 120s 不出现任何假目标；
//   2) 物体从 B 侧走到 C 侧：只产生 1 次过路事件、方向判为 B→C、反向判为 C→B；
//   3) 标记出现的延迟 ≤ 0.6s；标记 x 与真实 x 的相关性（宽阵列 ≥0.6）；
//   4) 单链路掉线时不崩溃且仍能检出；
//   5) 确定性（同种子两次结果完全一致）。
// 运行： npx tsx tools/tri_passage_test.ts
import { PassageEngine, type PassageInput } from "../src/lib/tri/passage";
import { makeGeometry } from "../src/lib/tri/geometry";
import { linkW, rng } from "../src/lib/tri/sim";

let fails = 0;
const ok = (c: boolean, msg: string) => {
  console.log((c ? "  ✔ " : "  ✘ ") + msg);
  if (!c) fails++;
};

function corr(a: number[], b: number[]) {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  return sab / Math.sqrt(saa * sbb + 1e-12);
}

interface Run {
  falseVisible: number;
  events: number;
  evSign: number;
  latency: number;
  corrX: number;
  visFrac: number;
  sig: string;
}

function run(side: number, mode: "empty" | "LR" | "RL", seed = 5, offC = false): Run {
  const g = makeGeometry(side);
  const W = 6, D = 6;
  const eng = new PassageEngine(g, W, D);
  const rand = rng(seed);
  const noise = () => Math.exp(0.35 * (rand() + rand() + rand() - 1.5) * 2);
  const base = () => Math.abs(0.35 * (rand() + rand() + rand() - 1.5) * 2) * 1.2;
  const dt = 0.05;
  const total = mode === "empty" ? 120 : 14;
  let t = 0;
  let falseVis = 0;
  const tx: number[] = [], mx: number[] = [];
  let firstVisible = -1, firstStrong = -1;
  let visCnt = 0, passCnt = 0;
  const zRow = 1.2; // 在阵列「前方」1.2m 处横穿
  let sig = "";
  for (let i = 0; i < total / dt; i++) {
    t = i * dt;
    let x = 0, z = 0, on = false;
    if (mode !== "empty" && t > 3 && t < 9) {
      const u = (t - 3) / 6;
      x = (mode === "LR" ? -1 : 1) * (-2.4 + 4.8 * u) * -1; // LR: −2.4→+2.4
      x = mode === "LR" ? -2.4 + 4.8 * u : 2.4 - 4.8 * u;
      z = zRow;
      on = true;
    }
    const wB = on ? linkW(g, "B", x, z) : 0;
    const wC = on ? linkW(g, "C", x, z) : 0;
    const zB = base() + (on ? 40 * wB * noise() : 0);
    const zC = base() + (on ? 40 * wC * noise() : 0);
    const inp: PassageInput = { zB, zC: offC ? null : zC, sB: 0, sC: 0, linkB: true, linkC: !offC, staticActive: false, dt, now: 1000 + t * 1000, noData: false, sens: 1.2 };
    eng.update(inp);
    sig += eng.marker.x.toFixed(3) + (eng.marker.visible ? "v" : "n") + ";";
    if (mode === "empty") {
      if (eng.marker.visible) falseVis++;
    } else {
      if (on) {
        passCnt++;
        if (eng.marker.visible) visCnt++;
        if (firstStrong < 0 && Math.max(zB, zC) > 6) firstStrong = t;
        if (eng.marker.visible && firstVisible < 0) firstVisible = t;
        if (eng.marker.visible) {
          tx.push(x);
          mx.push(eng.marker.x);
        }
      }
    }
  }
  const e = eng.events[0];
  return {
    falseVisible: falseVis,
    events: eng.events.length,
    evSign: e ? e.sign : 99,
    latency: firstVisible >= 0 && firstStrong >= 0 ? firstVisible - firstStrong : 99,
    corrX: tx.length > 10 ? corr(tx, mx) : 0,
    visFrac: passCnt ? visCnt / passCnt : 0,
    sig,
  };
}

const rounds = Number(process.argv[2] ?? 1);
for (let r = 0; r < rounds; r++) {
  console.log(`\n=== 第 ${r + 1} 轮 (SIMULATION_ONLY) ===`);
  for (const side of [0.4, 1.8]) {
    console.log(`\n阵列边长 ${side} m`);
    const e = run(side, "empty", 11 + r);
    ok(e.falseVisible === 0, `空房 120s 假目标帧数 = ${e.falseVisible}`);
    const lr = run(side, "LR", 21 + r);
    console.log(`   LR: 事件=${lr.events} 方向=${lr.evSign} 延迟=${lr.latency.toFixed(2)}s 相关=${lr.corrX.toFixed(2)} 可见率=${(lr.visFrac * 100).toFixed(0)}%`);
    ok(lr.events === 1, "B→C 过路只产生 1 次事件");
    if (side >= 0.8) ok(lr.evSign === -1, "B→C 方向判定正确");
    else ok(lr.evSign !== 1, "小阵列：方向不可分辨时不得给出相反方向（不瞎猜）");
    ok(lr.latency <= 0.6, "出现延迟 ≤ 0.6s");
    ok(lr.visFrac > 0.6, "经过期间可见率 > 60%");
    if (side >= 1.5) ok(lr.corrX >= 0.6, "宽阵列：标记 x 与真值相关 ≥ 0.6");
    const rl = run(side, "RL", 31 + r);
    console.log(`   RL: 事件=${rl.events} 方向=${rl.evSign} 延迟=${rl.latency.toFixed(2)}s 相关=${rl.corrX.toFixed(2)}`);
    if (side >= 0.8) ok(rl.events === 1 && rl.evSign === 1, "C→B 方向判定正确");
    else ok(rl.events === 1 && rl.evSign !== -1, "小阵列：反向同样不得给出相反方向");
    const one = run(side, "LR", 41 + r, true);
    ok(one.visFrac > 0.3 && one.events >= 1, `单链路(C 掉线)仍可检出，可见率 ${(one.visFrac * 100).toFixed(0)}%`);
    const d1 = run(side, "LR", 77).sig;
    const d2 = run(side, "LR", 77).sig;
    ok(d1 === d2, "确定性：同种子两次完全一致");
  }
}
console.log(fails === 0 ? "\n全部通过 ✔  (SIMULATION_ONLY)" : `\n失败 ${fails} 项 ✘`);
process.exit(fails === 0 ? 0 : 1);
