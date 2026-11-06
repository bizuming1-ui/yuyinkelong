// 三节点系统全局常量（浏览器 ↔ 固件 config.h 必须一致）
//   ESP32-1 (ESP32-A) = 探测发射端 TX（节点号 1）
//   ESP32-B           = CSI 接收端 RX1（节点号 2）
//   ESP32-C           = CSI 接收端 RX2（节点号 3）
// 主题根与旧版双节点系统（bzm-csi/s3r-7f3a9c2e）刻意不同，两套系统互不串扰。
export const TRI_ROOT = "bzm-csi/tri-5d2e8a1c";

export interface TriBroker {
  name: string;
  url: string; // 浏览器：WebSocket(WSS)
  tcp: string; // ESP32：同一服务器的 TCP 1883
}

export const TRI_BROKERS: TriBroker[] = [
  { name: "HiveMQ", url: "wss://broker.hivemq.com:8884/mqtt", tcp: "broker.hivemq.com:1883" },
  { name: "EMQX", url: "wss://broker.emqx.io:8084/mqtt", tcp: "broker.emqx.io:1883" },
  { name: "Mosquitto", url: "wss://test.mosquitto.org:8081", tcp: "test.mosquitto.org:8083" },
];

export const NODE_ROLE: Record<number, string> = { 1: "A", 2: "B", 3: "C" };
export const NODE_TITLE: Record<number, string> = {
  1: "ESP32-1 (ESP32-A) · 发射端 TX",
  2: "ESP32-B · 接收端 RX1",
  3: "ESP32-C · 接收端 RX2",
};

// LLTF 64 子载波排列：下标 0..31 → k=0..31；32..63 → k=-32..-1
// 有效子载波（802.11n 20MHz L-LTF）：k∈[-26,-1]∪[1,26]，共 52 个；0 号(DC)与 ±27..±32 是保护/空子载波
export const VALID_IDX: number[] = (() => {
  const a: number[] = [];
  for (let k = -26; k <= 26; k++) if (k !== 0) a.push(k < 0 ? 64 + k : k);
  return a;
})();
export const NVALID = VALID_IDX.length; // 52

export const C_LIGHT = 299792458;
export const WIFI_FC = 2.437e9; // 信道 6 中心频率（仅用于波长估算）
export const WAVELENGTH_M = C_LIGHT / WIFI_FC; // ≈ 0.123 m
