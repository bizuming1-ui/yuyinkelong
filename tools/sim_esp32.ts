// 无硬件仿真器：在电脑上假装"两块 ESP32"，经真实 MQTT 服务器向浏览器模拟器推送与固件完全相同格式的数据。
// 用法：npx tsx tools/sim_esp32.ts [主题根] [服务器 mqtt://broker.emqx.io:1883]
import mqtt from "mqtt";
import { DEFAULT_ROOT } from "../src/lib/config";
import { encodeBatch } from "../src/lib/protocol";
import { SynthScene } from "../src/lib/synth";

const root = process.argv[2] || DEFAULT_ROOT;
const url = process.argv[3] || "mqtt://broker.hivemq.com:1883";
const sc = new SynthScene(3, 6, 99);
const t0 = Date.now();
const rid = Math.random().toString(16).slice(2, 8);

function node(id: number) {
  const c = mqtt.connect(url, {
    clientId: `sim-n${id}-${rid}`,
    will: { topic: `${root}/n${id}/status`, payload: Buffer.from(JSON.stringify({ id, online: false })), qos: 0, retain: true },
    reconnectPeriod: 1000,
  });
  const status = () =>
    c.publish(
      `${root}/n${id}/status`,
      JSON.stringify({ id, online: true, fw: "sim", up: Math.round((Date.now() - t0) / 1000), rssi: -50, ch: 6, ip: "0.0.0.0", csi: 0, peer: true, csiOk: true }),
      { retain: true },
    );
  c.on("connect", () => {
    console.log(`[sim] ESP32-${id} 已连接 ${url}`);
    status();
  });
  c.on("error", (e) => console.log(`[sim] ESP32-${id} 错误 ${e.message}`));
  setInterval(() => c.connected && status(), 4000);
  return c;
}
const n1 = node(1);
const n2 = node(2);
const clients: Record<number, ReturnType<typeof node>> = { 1: n1, 2: n2 };

// 与固件一致：50Hz 连续流，每 130ms 合并成一条消息（公共服务器限流约 10 条/秒）
setInterval(() => {
  const t = (Date.now() - t0) / 1000;
  const tms = Date.now() - t0;
  for (const id of [1, 2]) {
    const recs = [];
    for (let i = 0; i < 6; i++) recs.push(sc.rec(id, 6, 0, t + i * 0.02, tms + i * 20));
    clients[id].publish(`${root}/n${id}/csi`, Buffer.from(encodeBatch(id, recs)));
  }
}, 130);

let sid = 0;
setInterval(() => {
  sid = (sid % 254) + 1;
  const t = (Date.now() - t0) / 1000;
  const all = sc.sweep(sid, t, Date.now() - t0, 5);
  for (const id of [1, 2]) {
    const recs = all.filter((x) => x.node === id).map((x) => x.rec);
    // 每 130ms 发一条（≤14 条记录），和固件限速一致
    for (let i = 0, k = 0; i < recs.length; i += 14, k++) {
      const chunk = recs.slice(i, i + 14);
      setTimeout(() => clients[id].publish(`${root}/n${id}/csi`, Buffer.from(encodeBatch(id, chunk))), k * 130);
    }
  }
  console.log(`[sim] 扫频 #${sid} 已发送`);
}, 2500);
console.log(`[sim] 主题根 ${root}`);
