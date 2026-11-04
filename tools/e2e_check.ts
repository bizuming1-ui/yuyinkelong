// 端到端自检（无需硬件）：  npx tsx tools/e2e_check.ts
//  A. 协议：编码 → 解析 往返一致
//  B. 多信道拼接：已知反射体路径长度，检验 13 信道拼接 + IDFT 能否把它们找出来并区分开（含随机相位/STO/AGC/噪声）
//  C. 运动检测：静止校准后目标运动 → 运动强度上升
//  D. MQTT 往返：真实公共服务器上发布二进制帧并收回（网络不通时只警告）
import mqtt from "mqtt";
import { RadarEngine, RESOLUTION_M, BANDWIDTH_MHZ, NB } from "../src/lib/dsp";
import { encodeBatch, parseBatch } from "../src/lib/protocol";
import { SynthScene } from "../src/lib/synth";

let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(`${c ? "  ✔" : "  ✘"} ${m}`);
  if (!c) fail++;
};

function feedSweep(eng: RadarEngine, sc: SynthScene, sid: number, t: number, nowMs: number) {
  const all = sc.sweep(sid, t, nowMs);
  for (const node of [1, 2]) {
    const recs = all.filter((x) => x.node === node).map((x) => x.rec);
    for (let i = 0; i < recs.length; i += 6) for (const f of parseBatch(encodeBatch(node, recs.slice(i, i + 6)))) eng.pushFrame(f, nowMs);
  }
  eng.tick(nowMs + 1);
}

async function main() {
  console.log(`参数：${NB} 个频点，带宽 ${BANDWIDTH_MHZ.toFixed(1)}MHz，理论分辨率 ${RESOLUTION_M.toFixed(2)}m`);

  console.log("A. 协议往返");
  const sc0 = new SynthScene(3, 6, 1);
  const r = sc0.rec(2, 7, 5, 0.1, 123456);
  const f = parseBatch(encodeBatch(2, [r]))[0];
  ok(!!f && f.node === 2 && f.ch === 7 && f.sweepId === 5 && f.tms === 123456, "头部字段一致");
  ok(f.im[3] === r.csi[6] && f.re[3] === r.csi[7] && f.re[40] === r.csi[81], "CSI 虚部/实部顺序一致");

  console.log("B. 多信道拼接 + 剖面（静态反射体 9.5 / 15.2 / 24.5 m，基线 3 m）");
  for (let round = 1; round <= 3; round++) {
    const sc = new SynthScene(3, 6, 100 + round);
    sc.person.on = false;
    const eng = new RadarEngine();
    eng.setBaseline(3);
    let now = 1000;
    for (let s = 1; s <= 4; s++) {
      feedSweep(eng, sc, s, s * 2.5, now);
      now += 2500;
    }
    const pk = eng.peaks;
    const near = (L: number, tol: number) => pk.some((p) => Math.abs(p.L - L) <= tol);
    console.log(`  第 ${round} 次：峰值 = ${pk.map((p) => p.L.toFixed(1)).join(", ")}  使用信道=${eng.stats.chUsed}/13 丢失=${eng.stats.lostPct.toFixed(1)}%`);
    ok(eng.stats.chUsed === 13, "13 个信道全部参与拼接");
    ok(near(3, 1.0), "直达波锚定在基线 3m");
    ok(near(9.5, 1.2), "检出 9.5m 反射体");
    ok(near(15.2, 1.3), "检出 15.2m 反射体");
    ok(near(24.5, 1.8), "检出 24.5m 反射体");
  }

  console.log("C. 运动检测（100Hz 连续流，静止校准 → 运动）");
  for (let round = 1; round <= 3; round++) {
    const sc = new SynthScene(3, 6, 200 + round);
    const eng = new RadarEngine();
    sc.person.on = false;
    let now = 0;
    let t = 0;
    const step = (secs: number) => {
      for (let i = 0; i < secs * 100; i++) {
        t += 0.01;
        now += 10;
        for (const node of [1, 2]) for (const fr of parseBatch(encodeBatch(node, [sc.rec(node, 6, 0, t, now)]))) eng.pushFrame(fr, now);
        eng.tick(now);
      }
    };
    step(9);
    const quiet = eng.sense.motion;
    ok(eng.sense.calibrated, `校准完成（${eng.sense.calib}/${eng.sense.calibTotal}）`);
    sc.person.on = true;
    sc.person.freq = 0.5;
    step(6);
    console.log(`  第 ${round} 次：静止 motion=${quiet.toFixed(2)}  运动 motion=${eng.sense.motion.toFixed(2)} z=${eng.sense.motionZ.toFixed(1)}`);
    ok(quiet < 0.2, "静止时运动强度低");
    ok(eng.sense.motion > 0.3, "目标运动后运动强度明显升高");
  }

  console.log("D. MQTT 真实往返（二进制帧）");
  await new Promise<void>((resolve) => {
    const topic = `bzm-selftest/${Math.random().toString(16).slice(2)}/n1/csi`;
    const c = mqtt.connect("mqtt://broker.hivemq.com:1883", { connectTimeout: 8000, reconnectPeriod: 0 });
    const timer = setTimeout(() => {
      console.log("  ⚠ 无法在 12 秒内完成往返（网络/防火墙），跳过");
      c.end(true);
      resolve();
    }, 12000);
    c.on("error", () => {});
    c.on("connect", () => {
      c.subscribe(topic, () => c.publish(topic, Buffer.from(encodeBatch(1, [sc0.rec(1, 3, 2, 0.5, 777)]))));
    });
    c.on("message", (_t, payload) => {
      const g = parseBatch(new Uint8Array(payload))[0];
      ok(!!g && g.ch === 3 && g.sweepId === 2 && g.tms === 777, "MQTT 收到并解析正确");
      clearTimeout(timer);
      c.end(true);
      resolve();
    });
  });

  console.log(fail === 0 ? "\n全部通过 ✅" : `\n失败 ${fail} 项 ❌`);
  process.exit(fail === 0 ? 0 : 1);
}
main();
