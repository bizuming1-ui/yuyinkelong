// 浏览器 MQTT 中枢（三节点版）：同时连接多个 WSS 服务器并合并数据，任何一个断线都不影响其余连接。
// 稳定性措施：
//  1) 多服务器并联 + 批级去重（ESP32 换服务器/浏览器多连时不会重复计数）
//  2) 自动重连（1.5s）+ MQTT keepalive 15s 检测死连接；页面可见/网络恢复时立即补连并询问状态
//  3) 页面重新可见 / 网络恢复(online 事件) / 窗口聚焦 时立即检查并重连（浏览器后台会冻结 WebSocket）
//  4) 用户可追加自己的 WSS 服务器（保存在 localStorage），公共服务器不可用时的最终兜底
import type { MqttClient } from "mqtt";
import { TRI_BROKERS, type TriBroker } from "./config";
import { parseTriBatch, type TriFrame } from "./protocol";

export type LinkState = "idle" | "connecting" | "online" | "offline" | "error";

export interface TriStatus {
  id: number;
  online: boolean;
  role?: string;
  fw?: string;
  boot?: number;
  up?: number;
  heap?: number;
  psram?: number;
  rssi?: number;
  ch?: number;
  ip?: string;
  state?: string;
  csi?: number;
  drop?: number;
  pub?: number;
  pubFail?: number;
  nowTx?: number;
  nowTxFail?: number;
  paired?: number;
  unpaired?: number;
  reconnects?: number;
  seqA?: number;
  broker?: number;
  csiOk?: boolean;
  seenAt: number;
  via?: string;
}

export interface HubEvents {
  onFrames: (frames: TriFrame[], via: string) => void;
  onStatus: (s: TriStatus) => void;
  onLink: (name: string, state: LinkState, detail?: string) => void;
  onLog: (level: "info" | "warn" | "error", msg: string) => void;
}

interface Entry {
  def: TriBroker;
  client: MqttClient;
  state: LinkState;
  lastMsg: number;
  msgs: number;
}

export function loadCustomBrokers(): TriBroker[] {
  try {
    const arr = JSON.parse(localStorage.getItem("bzm-tri-brokers") || "[]");
    if (Array.isArray(arr)) return arr.filter((b) => b && typeof b.url === "string" && /^wss?:\/\//.test(b.url));
  } catch {
    /* ignore */
  }
  return [];
}

export class TriHub {
  private clients: Entry[] = [];
  private stopped = true;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private seen = new Set<string>();
  private seenQ: string[] = [];
  private onVis: (() => void) | null = null;
  totalMsgs = 0;

  constructor(
    private root: string,
    private ev: HubEvents,
  ) {}

  get states() {
    return this.clients.map((c) => ({ name: c.def.name, state: c.state, lastMsg: c.lastMsg, msgs: c.msgs }));
  }

  async connect() {
    if (!this.stopped) return;
    this.stopped = false;
    const mqtt = (await import("mqtt")).default;
    if (this.stopped) return;
    const rid = Math.random().toString(16).slice(2, 10);
    const defs = [...TRI_BROKERS, ...loadCustomBrokers()];
    for (const def of defs) {
      const client = mqtt.connect(def.url, {
        clientId: `bzm-tri-web-${rid}-${def.name.replace(/\W/g, "")}`,
        keepalive: 15,
        reconnectPeriod: 1500,
        connectTimeout: 8000,
        clean: true,
        protocolVersion: 4,
        resubscribe: true,
      });
      const entry: Entry = { def, client, state: "connecting", lastMsg: 0, msgs: 0 };
      this.clients.push(entry);
      this.ev.onLink(def.name, "connecting");
      client.on("connect", () => {
        entry.state = "online";
        entry.lastMsg = performance.now();
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
        entry.msgs++;
        this.totalMsgs++;
        const t = topic.slice(this.root.length + 1);
        if (t.endsWith("/csi")) {
          const frames = parseTriBatch(new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength));
          if (!frames.length) return;
          const f0 = frames[0];
          const key = `${f0.node}:${f0.boot}:${f0.rxCnt}:${f0.tms}:${frames.length}`;
          if (this.seen.has(key)) return;
          this.seen.add(key);
          this.seenQ.push(key);
          if (this.seenQ.length > 400) this.seen.delete(this.seenQ.shift()!);
          this.ev.onFrames(frames, def.name);
        } else if (t.endsWith("/status")) {
          try {
            const j = JSON.parse(new TextDecoder().decode(payload));
            if (typeof j.id === "number" && j.id >= 1 && j.id <= 3) this.ev.onStatus({ ...j, seenAt: performance.now(), via: def.name });
          } catch {
            /* 忽略坏包 */
          }
        }
      });
    }
    this.watchdog = setInterval(() => this.check(false), 4000);
    this.onVis = () => {
      if (document.visibilityState === "visible") this.check(true);
    };
    document.addEventListener("visibilitychange", this.onVis);
    window.addEventListener("online", this.onVis);
    window.addEventListener("focus", this.onVis);
  }

  private check(force: boolean) {
    // 注意：ESP32 同一时刻只发布到「一个」服务器，其余服务器没有流量是正常的，所以不能按「无消息」强制重连
    // （那样会造成无谓的重连抖动）。连接死活由 MQTT keepalive(15s) + mqtt.js 自动重连负责；
    // 这里只处理：页面重新可见 / 网络恢复时，把 offline/error 的连接立刻拉起来，并发一个状态询问。
    if (!force) return;
    for (const c of this.clients) {
      if ((c.state === "offline" || c.state === "error") && !c.client.reconnecting) c.client.reconnect();
      else if (c.state === "online") c.client.publish(`${this.root}/cmd`, "hello", { qos: 0 });
    }
  }

  sendCmd(cmd: string) {
    for (const c of this.clients) if (c.state === "online") c.client.publish(`${this.root}/cmd`, cmd, { qos: 0 });
  }

  disconnect() {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    if (this.onVis) {
      document.removeEventListener("visibilitychange", this.onVis);
      window.removeEventListener("online", this.onVis);
      window.removeEventListener("focus", this.onVis);
      this.onVis = null;
    }
    for (const c of this.clients) {
      c.client.removeAllListeners();
      c.client.on("error", () => {});
      c.client.end(true);
      this.ev.onLink(c.def.name, "idle");
    }
    this.clients = [];
    this.seen.clear();
    this.seenQ = [];
  }
}
