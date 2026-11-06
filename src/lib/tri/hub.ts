// 浏览器 MQTT + WebSerial 双模中枢（三节点版）：同时连接多个 WSS 服务器并合并数据，且支持 USB 串口直连兜底，任何单一链路断线都不影响系统连续运行。
// 稳定性措施：
//  1) 多服务器并联 + 批级去重（ESP32 换服务器/浏览器多连/USB直连同开时不会重复计数）
//  2) 自动重连（1.2s）+ MQTT keepalive 15s + 周期性 NAT 保活询问；页面可见/网络恢复时立即补连
//  3) 支持 WebSerial USB 串口直连（即使无外网也能通过 USB 线直读 ESP32-B/C 的 @CSI 帧与 @STAT 状态）
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

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  const len = clean.length >> 1;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16) || 0;
  }
  return out;
}

export class TriHub {
  private clients: Entry[] = [];
  private stopped = true;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private seen = new Set<string>();
  private seenQ: string[] = [];
  private onVis: (() => void) | null = null;
  private tickCount = 0;
  totalMsgs = 0;
  serialCount = 0;

  constructor(
    private root: string,
    private ev: HubEvents,
  ) {}

  get states() {
    return this.clients.map((c) => ({ name: c.def.name, state: c.state, lastMsg: c.lastMsg, msgs: c.msgs }));
  }

  private ingestBatch(bytes: Uint8Array, via: string) {
    const frames = parseTriBatch(bytes);
    if (!frames.length) return;
    const f0 = frames[0];
    const key = `${f0.node}:${f0.boot}:${f0.rxCnt}:${f0.tms}:${frames.length}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.seenQ.push(key);
    if (this.seenQ.length > 500) this.seen.delete(this.seenQ.shift()!);
    this.ev.onFrames(frames, via);
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
        reconnectPeriod: 1200,
        connectTimeout: 7000,
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
          else client.publish(`${this.root}/cmd`, "hello", { qos: 0 });
        });
      });
      client.on("reconnect", () => {
        entry.state = "connecting";
        this.ev.onLink(def.name, "connecting");
      });
      client.on("close", () => {
        if (entry.state === "online") this.ev.onLog("warn", `MQTT 断开 ${def.name}，自动无缝重连中…`);
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
          this.ingestBatch(new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength), def.name);
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
    this.watchdog = setInterval(() => this.check(false), 3500);
    this.onVis = () => {
      if (document.visibilityState === "visible") this.check(true);
    };
    document.addEventListener("visibilitychange", this.onVis);
    window.addEventListener("online", this.onVis);
    window.addEventListener("focus", this.onVis);
  }

  /** WebSerial USB 串口直连（零断连硬件级旁路：可同时连接多块板，与 MQTT 自动去重合并） */
  async connectSerial(): Promise<boolean> {
    const nav = navigator as unknown as {
      serial?: {
        requestPort: () => Promise<{
          open: (opts: { baudRate: number }) => Promise<void>;
          readable?: ReadableStream<Uint8Array>;
          close: () => Promise<void>;
        }>;
      };
    };
    if (!nav.serial) {
      this.ev.onLog("warn", "当前浏览器不支持 WebSerial，请使用 Chrome 或 Edge 桌面版进行 USB 串口直连");
      return false;
    }
    try {
      const port = await nav.serial.requestPort();
      await port.open({ baudRate: 115200 });
      const idx = ++this.serialCount;
      const linkName = `USB-${idx}`;
      this.ev.onLink(linkName, "online");
      this.ev.onLog("info", `已通过 ${linkName} 串口直连 ESP32（115200 bps）`);
      const reader = port.readable?.getReader();
      if (!reader) return false;
      const dec = new TextDecoder();
      let buf = "";
      (async () => {
        try {
          while (!this.stopped) {
            const { value, done } = await reader.read();
            if (done) break;
            if (!value) continue;
            buf += dec.decode(value, { stream: true });
            let nl = buf.indexOf("\n");
            while (nl >= 0) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              nl = buf.indexOf("\n");
              if (!line) continue;
              if (line.startsWith("@CSI:")) {
                const bytes = hexToBytes(line.slice(5));
                this.totalMsgs++;
                this.ingestBatch(bytes, linkName);
              } else if (line.startsWith("@STAT:")) {
                try {
                  const j = JSON.parse(line.slice(6));
                  if (typeof j.id === "number" && j.id >= 1 && j.id <= 3) {
                    this.ev.onStatus({ ...j, seenAt: performance.now(), via: linkName });
                  }
                } catch {
                  /* ignore */
                }
              }
            }
          }
        } catch (e) {
          this.ev.onLog("warn", `${linkName} 串口读取结束: ${String(e)}`);
        } finally {
          this.ev.onLink(linkName, "offline");
        }
      })();
      return true;
    } catch (e) {
      this.ev.onLog("warn", `USB 串口连接取消或失败: ${String(e)}`);
      return false;
    }
  }

  private check(force: boolean) {
    this.tickCount++;
    for (const c of this.clients) {
      if ((c.state === "offline" || c.state === "error") && !c.client.reconnecting) {
        try {
          c.client.reconnect();
        } catch {
          /* ignore */
        }
      } else if (force && c.state === "online") {
        c.client.publish(`${this.root}/cmd`, "hello", { qos: 0 });
      }
    }
    // 每约 28 秒发送一次轻量保活，确保公网 NAT 映射与设备状态常新
    if (this.tickCount % 8 === 0) {
      const onlineClient = this.clients.find((c) => c.state === "online");
      if (onlineClient) onlineClient.client.publish(`${this.root}/cmd`, "ping", { qos: 0 });
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
