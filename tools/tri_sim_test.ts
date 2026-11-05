// 三节点系统「无硬件」单元验证（合成数据仅用于测试，不是真实成像）
// 运行：npx tsx tools/tri_sim_test.ts 3      （参数 = 重复轮数，每轮不同随机种子；全部通过才返回 0）
import { FusedDetector, LinkAnalyzer } from "../src/lib/tri/features";
import { makeGeometry } from "../src/lib/tri/geometry";
import { ParticleFilter } from "../src/lib/tri/pf";
import { encodeTriBatch, parseTriBatch } from "../src/lib/tri/protocol";
import { SimPerson, rng, synthCsi, synthLinkZ } from "../src/lib/tri/sim";

let fails = 0;
const ok = (c: boolean, msg: string) => {
  console.log(`${c ? "  ✓" : "  ✗"} ${msg}`);
  if (!c) fails++;
};

// ---------- 协议往返 ----------
function testProtocol(seed: number) {
  const r = rng(seed);
  const recs = Array.from({ length: 14 }, (_, i) => {
    const csi = new Int8Array(128);
    for (let k = 0; k < 128; k++) csi[k] = Math.round((r() - 0.5) * 250);
    return { flags: 3, ch: 6, rssi: -50 - i, noise: -95, seqA: 65530 + i, rxCnt: 1000 + i, tms: 123456 + i * 10, csi };
  });
  const buf = encodeTriBatch(3, 0xabcd, 77, recs);
  const out = parseTriBatch(buf);
  let same = out.length === 14 && out[0].node === 3 && out[0].boot === 0xabcd;
  for (let i = 0; i < out.length && same; i++) {
    same = out[i].seqA === (65530 + i) % 65536 && out[i].paired && out[i].rssi === -50 - i && out[i].im[5] === recs[i].csi[10] && out[i].re[5] === recs[i].csi[11];
  }
  ok(same, `协议 v3 编解码往返一致（140B/条，${buf.length} 字节）`);
  ok(parseTriBatch(new Uint8Array([0xc5, 2, 2, 1])).length === 0, "旧版/损坏帧被拒绝");
}

// ---------- CSI 特征流水线 ----------
function testPipeline(seed: number) {
  const r = rng(seed * 101);
  const B = new LinkAnalyzer(2);
  const C = new LinkAnalyzer(3);
  const det = new FusedDetector();
  const pk = (node: number, la: LinkAnalyzer, t: number, moving: boolean, cnt: number) => {
    const csi = synthCsi({ rand: r, t, moving, pathBase: 0, node });
    const buf = encodeTriBatch(node, 1, 0, [{ flags: 3, ch: 6, rssi: -45, noise: -95, seqA: cnt, rxCnt: cnt, tms: Math.round(t * 1000), csi }]);
    la.pushFrame(parseTriBatch(buf)[0], t * 1000);
  };
  const HZ = 100;
  let cnt = 0;
  let fpEmpty = 0;
  let nEmpty = 0;
  let tp = 0;
  let nMove = 0;
  let firstDet = -1;
  const T_EMPTY = 150; // 秒
  const T_MOVE = 40;
  for (let step = 0; step < (T_EMPTY + T_MOVE) * HZ; step++) {
    const t = step / HZ;
    const moving = t >= T_EMPTY && Math.floor((t - T_EMPTY) / 10) % 2 === 0; // 走 10s、停 10s
    if (r() > 0.04) pk(2, B, t, moving, cnt);
    if (r() > 0.04) pk(3, C, t, moving, cnt);
    cnt++;
    if (step % 20 === 0) {
      const now = t * 1000;
      const mb = B.tick(now);
      const mc = C.tick(now);
      const f = det.update(mb, mc, now);
      if (t > 25 && t < T_EMPTY) {
        nEmpty++;
        if (f.state === "motion") fpEmpty++;
      }
      if (t >= T_EMPTY && moving && t - T_EMPTY > 1.5) {
        nMove++;
        if (f.state === "motion") tp++;
      }
      if (moving && firstDet < 0 && f.state === "motion") firstDet = t - T_EMPTY;
    }
  }
  const fpr = fpEmpty / nEmpty;
  const tpr = tp / nMove;
  console.log(`  空房 ${nEmpty} 个窗口误报=${fpEmpty}（${(fpr * 100).toFixed(2)}%）；运动检出 ${(tpr * 100).toFixed(1)}%；首次检出 ${firstDet.toFixed(1)}s`);
  ok(fpr < 0.01, "空房误报率 < 1%");
  ok(tpr > 0.85, "运动检出率 > 85%（合成 CSI：含随机 CFO/AGC/量化噪声）");
  ok(firstDet >= 0 && firstDet < 2.0, "首次检出延迟 < 2s");
  ok(B.m.lossPct > 0.01 && B.m.lossPct < 0.1, `丢包推算≈${(B.m.lossPct * 100).toFixed(1)}%（注入 4%）`);
}

// ---------- 粒子滤波定位 ----------
function testPF(seed: number, side: number) {
  const g = makeGeometry(side);
  const W = 6;
  const D = 6;
  const pf = new ParticleFilter(g, 2600, seed);
  pf.setRoom(W, D);
  const person = new SimPerson(W, D);
  const r = rng(seed * 7);
  const dt = 0.05;
  let se = 0;
  let sb = 0;
  let n = 0;
  let sp = 0;
  const T = 120;
  for (let k = 0; k < T / dt; k++) {
    const t = k * dt;
    const s = person.at(t);
    const o = synthLinkZ(g, s, r);
    // 真实系统每 200ms 才有一个新的特征窗口：每 4 步（4×0.05s）才融合一次观测
    const fresh = k % 4 === 0;
    pf.step(dt, fresh ? { zB: o.zB, zC: o.zC } : { zB: null, zC: null }, s.moving);
    if (s.moving && (t % 40) > 12) {
      se += (pf.est.x - s.x) ** 2 + (pf.est.z - s.z) ** 2;
      sb += s.x ** 2 + s.z ** 2; // 基线：始终猜阵列中心
      sp += pf.est.spread;
      n++;
    }
  }
  const rmse = Math.sqrt(se / n);
  const base = Math.sqrt(sb / n);
  console.log(`  边长 ${side}m：RMSE=${rmse.toFixed(2)}m（猜中心基线 ${base.toFixed(2)}m），平均不确定度 ${(sp / n).toFixed(2)}m`);
  return { rmse, base };
}

const rounds = Math.max(1, parseInt(process.argv[2] || "3", 10));
for (let i = 1; i <= rounds; i++) {
  console.log(`\n===== 第 ${i}/${rounds} 轮 =====`);
  testProtocol(i);
  testPipeline(i);
  const wide = testPF(i, 2.0);
  const compact = testPF(i, 0.3);
  ok(wide.rmse < wide.base * 0.85, "展开阵列(2m)：粒子滤波比「猜中心」误差小 ≥15%");
  ok(compact.rmse < compact.base * 1.05, "紧凑阵列(0.3m)：不比基线更差（该几何本身只能给出粗略方位）");
}
console.log(fails === 0 ? "\n全部通过 ✅" : `\n失败 ${fails} 项 ❌`);
process.exit(fails === 0 ? 0 : 1);
