// 全能检测：把浏览器侧 + 主机侧 + ESP32 节点的所有状态汇成一份可复制 / 可上传 GitHub 的日志
import type { Conn, EventItem } from "./useRadar";
import { plausibleKaggleUrl, type RadarState, type ServerDiag } from "./radar";

export type Status = "ok" | "warn" | "fail" | "info";
export type Check = { id: string; name: string; status: Status; detail: string };
export type GlInfo = { ok: boolean | null; renderer: string; error: string };
export type DiagCtx = {
  url: string;
  demo: boolean;
  conn: Conn;
  state: RadarState | null;
  gl: GlInfo;
  fps: number;
  pixelRatio: number;
  serverDiag: ServerDiag | null;
};

export function clientChecks(c: DiagCtx): Check[] {
  const out: Check[] = [];
  const add = (id: string, name: string, status: Status, detail: string) => out.push({ id, name, status, detail });
  add("gl", "3D 渲染 (WebGL)", c.gl.ok === null ? "info" : c.gl.ok ? "ok" : "fail", c.gl.ok === null ? "初始化中" : c.gl.ok ? `${c.gl.renderer || "WebGL"} · ${c.fps.toFixed(0)} fps · 像素比 ${c.pixelRatio.toFixed(2)}` : `WebGL 不可用：${c.gl.error}（换 Chrome/Edge，开启硬件加速）`);
  if (c.demo) {
    add("mode", "数据来源", "warn", "当前是【演示数据】，不是真实 ESP32；点“关闭演示”并填 Kaggle 网址后才是真实数据");
    return out;
  }
  if (!c.url) {
    add("url", "Kaggle 网址", "fail", "还没填写。在 Kaggle 输出框复制 https://xxxx.trycloudflare.com → 粘贴到顶部“Kaggle 网址”→ 连接");
    return out;
  }
  add("url", "Kaggle 网址", plausibleKaggleUrl(c.url) ? "ok" : "warn", c.url + (plausibleKaggleUrl(c.url) ? "" : "（不是常见隧道域名格式，请确认复制完整）"));
  add("health", "主机 /api/health", c.conn.healthOk === null ? "info" : c.conn.healthOk ? "ok" : "fail", c.conn.healthMsg || "检测中");
  const age = c.conn.lastOk ? (Date.now() - c.conn.lastOk) / 1000 : null;
  add("poll", "实时轮询", c.conn.status === "ok" ? "ok" : c.conn.status === "connecting" ? "info" : "fail", `状态 ${c.conn.status} · 延迟 ${c.conn.latency}ms · 成功 ${c.conn.polls} 次 / 失败 ${c.conn.fails} 次${c.conn.lastErr ? " · 最近错误：" + c.conn.lastErr : ""}${age !== null ? ` · 最近成功 ${age.toFixed(1)}s 前` : ""}`);
  const s = c.state;
  if (s) {
    for (const k of ["A", "B"] as const) {
      const n = s.nodes[k];
      if (!n.uploads) add("node" + k, `Node ${k}`, "fail", "主机从未收到它的上传。检查 config.h：WIFI_SSID/PASS、KAGGLE_URL、API_KEY；串口应有 [upload] HTTP 200");
      else add("node" + k, `Node ${k}`, n.online && (n.age ?? 99) < 25 ? "ok" : "warn", `${n.online ? "在线" : "离线"} · ${n.age ?? "?"}s 前上传 · ${n.uploads} 次/${n.recs} 条 · 固件 ${n.info.fw ?? "?"} · RSSI ${n.info.rssi ?? "?"} · 缓冲丢弃 ${n.dropped}`);
    }
    if (!s.last) add("csi", "CSI 剖面", s.nodes.A.uploads + s.nodes.B.uploads ? "warn" : "fail", s.nodes.A.recs + s.nodes.B.recs === 0 ? "节点在线但还没有 CSI 记录：两块板子没同步（看串口 [sync]）" : "已收到记录，正在凑齐一轮扫描…");
    else {
      const L = s.last;
      add("csi", "CSI 剖面", "ok", `序号 ${s.seq} · 模式 ${L.mode} · 配对 ${L.pairs} · 信道 ${L.channelsOk.length}/${s.plan > 3 ? 13 : 3} · 带宽 ${L.bwMHz}MHz · 分辨率 ${L.resM}m`);
      add("stitch", "拼接质量", L.coherence > 0.6 && L.refCorr > 0.5 ? "ok" : "warn", `帧内相干 ${L.coherence} · 与参考相关 ${L.refCorr} · 重叠子载波 ${L.overlaps.join("/")}`);
      add("sense", "感知结果", "info", `${L.sense.level} · 存在 ${L.sense.present} · 运动 ${L.sense.motion} · 呼吸 ${L.sense.breathBpm ?? "—"} BPM · 校准 ${L.sense.calN}/${L.sense.calNeed}`);
    }
    if (s.syncLossPct !== null) add("sync", "同步丢失率", s.syncLossPct < 10 ? "ok" : s.syncLossPct < 30 ? "warn" : "fail", `${s.syncLossPct}%（目标 <10%）`);
    add("gpu", "GPU", s.gpu.cuda ? "ok" : "info", s.gpu.cuda ? s.gpu.devices.join(" | ") + ` · CIR ${s.gpu.cir_ms}ms · MUSIC ${s.gpu.music_ms}ms` : "无 CUDA，CPU 运算");
  }
  return out;
}

const mark: Record<string, string> = { ok: "✅", warn: "⚠️", fail: "❌", info: "ℹ️" };
const hhmmss = (t: number) => new Date(t).toLocaleTimeString("zh-CN", { hour12: false });

export function buildLogText(c: DiagCtx, events: EventItem[]): string {
  const L: string[] = [];
  L.push(`# ESP32-S3 双节点 CSI 雷达 · 检测日志  ${new Date().toLocaleString("zh-CN")}`);
  L.push(`页面: ${typeof location !== "undefined" ? location.href : ""}`);
  L.push(`浏览器: ${typeof navigator !== "undefined" ? navigator.userAgent : ""}`);
  L.push("\n## 浏览器侧检测");
  for (const k of clientChecks(c)) L.push(`${mark[k.status]} ${k.name}: ${k.detail}`);
  L.push("\n## 主机(Kaggle)侧检测");
  if (c.serverDiag) for (const k of c.serverDiag.items) L.push(`${mark[k.status]} ${k.name}: ${k.detail}`);
  else L.push("（没有拿到主机检测数据：尚未连接或主机不可达）");
  L.push("\n## 主机事件(最近)");
  if (c.serverDiag) for (const e of c.serverDiag.events.slice(-60)) L.push(`${hhmmss(e.t * 1000)} [${e.lv}] ${e.msg}`);
  L.push("\n## 浏览器事件");
  for (const e of events.slice(-80)) L.push(`${hhmmss(e.t)} [${e.lv}] ${e.msg}`);
  if (c.state?.last) {
    L.push("\n## 最近一轮摘要(JSON)");
    const l = c.state.last;
    L.push(JSON.stringify({ seq: c.state.seq, mode: l.mode, pairs: l.pairs, channelsOk: l.channelsOk, coherence: l.coherence, refCorr: l.refCorr, bwMHz: l.bwMHz, peaks: l.peaks, musicPeaks: l.musicPeaks, sense: l.sense }));
  }
  return L.join("\n");
}
