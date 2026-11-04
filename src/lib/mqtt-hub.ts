// 浏览器端 MQTT：同时连接多个公共服务器（WSS），合并 ESP32 数据；任意一个断线自动重连，不影响其它连接。
import type { MqttClient } from "mqtt";
import { BROKERS, type BrokerDef } from "./config";
import { parseBatch, type CsiFrame } from "./protocol";

export type LinkState = "idle" | "connecting" | "online" | "offline" | "error";

export interface NodeStatus {
  id: number;
  online: boolean;
  fw?: string;
  up?: number;
  heap?: number;
  psram?: number;
  rssi?: number;
  ch?: number;
  ip?: string;
  csi?: number;
  drop?: number;
  pub?: number;
  pubFail?: number;
  nowRx?: number;
  nowTx?: number;
  nowTxFail?: number;
  sweeps?: number;
  peer?: boolean;
  broker?: number;
  csiOk?: boolean;
  seenAt: number; // 浏览器本地收到状态的时间
  via?: string;
}

export interface HubEvents {
  onFrames: (frames: CsiFrame[], via: string) => void;
  onStatus: (s: NodeStatus) => void;
  onLink: (name: string, state: LinkState, detail?: string) => void;
  onLog: (level: "info" | "warn" | "error", msg: string) => void;
}

export class MqttHub {
  private clients: { def: BrokerDef; client: MqttClient; state: LinkState; lastMsg: number }[] = [];
  private stopped = true;
  private watchdog: ReturnType<typeof setInterval> | null = null;

  constructor(
    private root: string,
    private ev: HubEvents,
  ) {}

  get states() {
    return this.clients.map((c) => ({ name: c.def.name, state: c.state, lastMsg: c.lastMsg }));
  }

  async connect() {
    if (!this.stopped) return;
    this.stopped = false;
    const mqtt = (await import("mqtt")).default;
    const rid = Math.random().toString(16).slice(2, 10);
    for (const def of BROKERS) {
      const client = mqtt.connect(def.url, {
        clientId: `bzm-web-${rid}-${def.name}`,
        keepalive: 20,
        reconnectPeriod: 1500,
        connectTimeout: 8000,
        clean: true,
        protocolVersion: 4,
        resubscribe: true,
      });
      const entry = { def, client, state: "connecting" as LinkState, lastMsg: 0 };
      this.clients.push(entry);
      this.ev.onLink(def.name, "connecting");
      client.on("connect", () => {
        entry.state = "online";
        this.ev.onLink(def.name, "online");
        this.ev.onLog("info", `MQTT 已连接 ${def.name}`);
        client.subscribe([`${this.root}/+/csi`, `${this.root}/+/status`], { qos: 0 }, (err) => {
          if (err) this.ev.onLog("warn", `订阅失败 ${def.name}: ${err.message}`);
        });
      });
      client.on("reconnect", () => {
        entry.state = "connecting";
        this.ev.onLink(def.name, "connecting");
      });
      client.on("close", () => {
        if (entry.state === "online") this.ev.onLog("warn", `MQTT 断开 ${def.name}，自动重连中…`);
        entry.state = this.stopped ? "idle" : "offline";
        this.ev.onLink(def.name, entry.state);
      });
      client.on("error", (e) => {
        entry.state = "error";
        this.ev.onLink(def.name, "error", e.message);
      });
      client.on("message", (topic, payload) => {
        entry.lastMsg = performance.now();
        const t = topic.slice(this.root.length + 1);
        if (t.endsWith("/csi")) {
          const frames = parseBatch(new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength));
          if (frames.length) this.ev.onFrames(frames, def.name);
        } else if (t.endsWith("/status")) {
          try {
            const j = JSON.parse(new TextDecoder().decode(payload));
            if (typeof j.id === "number") this.ev.onStatus({ ...j, seenAt: performance.now(), via: def.name });
          } catch {
            /* 忽略坏包 */
          }
        }
      });
    }
    // 看门狗：服务器连接"假活"（在线但很久没任何消息，且其它服务器有消息）→ 强制重连
    this.watchdog = setInterval(() => {
      const now = performance.now();
      for (const c of this.clients) {
        if (c.state === "online" && c.lastMsg && now - c.lastMsg > 20000) {
          this.ev.onLog("warn", `${c.def.name} 20 秒无数据，强制重连`);
          c.lastMsg = now;
          c.client.reconnect();
        }
      }
    }, 5000);
  }

  sendCmd(cmd: string) {
    for (const c of this.clients) if (c.state === "online") c.client.publish(`${this.root}/cmd`, cmd, { qos: 0 });
  }

  disconnect() {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    for (const c of this.clients) {
      c.client.removeAllListeners();
      c.client.on("error", () => {});
      c.client.end(true);
      this.ev.onLink(c.def.name, "idle");
    }
    this.clients = [];
  }
}
