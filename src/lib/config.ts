// 全局常量：浏览器模拟器与固件(config.h)必须保持一致
export const DEFAULT_ROOT = "bzm-csi/s3r-7f3a9c2e"; // = firmware config.h 的 MQTT_ROOT

export interface BrokerDef {
  name: string;
  url: string; // 浏览器用 WebSocket(WSS)；ESP32 用同一服务器的 TCP 1883
  tcp: string;
}

// 浏览器会"同时"连接下面所有服务器，所以 ESP32 无论落在哪个服务器上都能被收到
export const BROKERS: BrokerDef[] = [
  { name: "HiveMQ", url: "wss://broker.hivemq.com:8884/mqtt", tcp: "broker.hivemq.com:1883" },
  { name: "EMQX", url: "wss://broker.emqx.io:8084/mqtt", tcp: "broker.emqx.io:1883" },
  { name: "Mosquitto", url: "wss://test.mosquitto.org:8081", tcp: "test.mosquitto.org:1883" },
];

export const GITHUB_REPO = "bizuming1-ui/yuyinkelong";
export const GITHUB_BRANCH = "main";
