// 端到端联调（无硬件）：用与固件完全相同的 v3 二进制协议，经真实公共 MQTT 服务器向浏览器发布 A/B/C 的状态与 B/C 的 CSI。
// 仅用于测试链路（标注为 SIM 固件）。运行：npx tsx tools/tri_e2e.ts [主题根] [秒数]
import mqtt from "mqtt";
import { encodeTriBatch } from "../src/lib/tri/protocol";
import { rng, synthCsi } from "../src/lib/tri/sim";

const root = process.argv[2] || "bzm-csi/tri-5d2e8a1c";
const secs = parseInt(process.argv[3] || "60", 10);
const host = process.env.BROKER || "mqtt://broker.hivemq.com:1883";
const c = mqtt.connect(host, { clientId: "bzm-e2e-" + Math.random().toString(16).slice(2, 8), keepalive: 15 });
const r = rng(4242);
const t0 = Date.now();
let cnt = 0;
let pub = 0;
c.on("connect", () => {
  console.log("e2e 发布端已连接", host, "root=", root);
  setInterval(() => {
    const t = (Date.now() - t0) / 1000;
    const moving = t > 12 && Math.floor((t - 12) / 10) % 2 === 0;
    for (const node of [2, 3]) {
      const recs = Array.from({ length: 10 }, (_, i) => {
        const tt = t - (9 - i) * 0.01;
        return { flags: 3, ch: 6, rssi: -45, noise: -95, seqA: cnt + i, rxCnt: cnt + i, tms: Math.round(tt * 1000), csi: synthCsi({ rand: r, t: tt, moving, pathBase: 0, node }) };
      });
      c.publish(`${root}/n${node}/csi`, Buffer.from(encodeTriBatch(node, 777, 0, recs)), { qos: 0 });
      pub++;
    }
    cnt += 10;
  }, 100);
  setInterval(() => {
    for (const id of [1, 2, 3]) c.publish(`${root}/n${id}/status`, JSON.stringify({ id, online: true, role: "ABC"[id - 1], fw: "SIM-E2E", boot: 777, up: Math.round((Date.now() - t0) / 1000), rssi: -50, ch: 6, state: "RUNNING", nowTx: cnt, paired: cnt, unpaired: 0, drop: 0 }), { qos: 0, retain: false });
  }, 2000);
  setTimeout(() => {
    console.log("e2e 结束，发布批包数", pub);
    c.end(true, () => process.exit(0));
  }, secs * 1000);
});
c.on("error", (e) => console.log("e2e 错误", e.message));
