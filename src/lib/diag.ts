import type { Conn, EventItem } from "./useRadar";
import { parseUrls, type DiagItem, type RadarState, type ServerDiag } from "./radar";

export type Check = DiagItem;
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

export function clientChecks(x: DiagCtx): Check[] {
  const out: Check[] = [];
  const add = (id: string, name: string, status: Check["status"], detail: string) => out.push({ id, name, status, detail });

  if (x.gl.ok === null) add("webgl", "3D 渲染 (WebGL)", "info", "正在初始化 Three.js 场景…");
  else if (!x.gl.ok) add("webgl", "3D 渲染 (WebGL)", "fail", `WebGL 创建失败：${x.gl.error || "未知原因"}。请打开浏览器硬件加速。`);
  else add("webgl", "3D 渲染 (WebGL)", x.fps >= 15 || x.fps === 0 ? "ok" : "warn", `${x.gl.renderer || "WebGL"} · ${x.fps.toFixed(0)} fps · 像素比 ${x.pixelRatio.toFixed(2)}`);

  if (x.demo) {
    add("mode", "数据源模式", "info", "当前为【单节点 1×ESP32-S3 全物体检测演示模式】；填好顶部 Kaggle 网址点「连接」即切到真实硬件数据。");
    return out;
  }

  const urls = parseUrls(x.url);
  if (!urls.length) {
    add("url", "Kaggle 网址", "fail", "尚未填写 Kaggle 网址。请在 Kaggle 运行单文件脚本，复制输出框里的网址粘贴到顶部输入框。");
    return out;
  }
  add("url", "Kaggle 网址", "ok", x.conn.active ? `${x.conn.active}${urls.length > 1 ? `（共配置 ${urls.length} 个候选隧道）` : ""}` : urls.join(" , "));

  if (x.conn.healthOk === null) add("health", "主机 /api/health", "info", "正在探测…");
  else if (!x.conn.healthOk) add("health", "主机 /api/health", "fail", `${x.conn.healthMsg}${x.conn.hint ? " —— 建议：" + x.conn.hint : ""}`);
  else add("health", "主机 /api/health", "ok", x.conn.healthMsg);

  const age = x.conn.lastOk ? ((Date.now() - x.conn.lastOk) / 1000).toFixed(1) + "s 前" : "从未";
  add(
    "poll",
    "零断连实时轮询",
    x.conn.status === "ok" ? "ok" : x.conn.status === "connecting" ? "info" : "fail",
    `状态 ${x.conn.status} · 延迟 ${x.conn.latency}ms · 成功 ${x.conn.polls} 次 / 重试 ${x.conn.fails} 次 · 最近成功 ${age}${x.conn.lastErr ? " · " + x.conn.lastErr : ""}`,
  );

  const s = x.state;
  if (!s) return out;

  const isSingle = Boolean(s.singleNode || s.last?.mode === "single-node" || s.nodes.A.info?.mode === "single");
  const nA = s.nodes.A;
  if (!nA.uploads) {
    add("nodeA", "ESP32-S3 主节点", "fail", "主机尚未收到 ESP32 上传。请确认 config.h 中 WIFI_SSID(2.4GHz)、WIFI_PASS、KAGGLE_URL、API_KEY 已配置并供电。");
  } else {
    add(
      "nodeA",
      isSingle ? "ESP32-S3 (单节点全能模式)" : "Node A (主节点)",
      nA.online ? "ok" : "warn",
      `${nA.online ? "在线" : "离线"} · ${nA.age ?? "?"}s 前上传 · ${nA.uploads} 次/${nA.recs} 条 · 固件 ${nA.info.fw || "?"} · RSSI ${nA.info.rssi || "?"} · 辐射源 ${nA.info.macs || "1"} 个`,
    );
  }

  const nB = s.nodes.B;
  if (isSingle) {
    add("nodeB", "辅助节点 / 自参考标定", "ok", "当前为 1×ESP32-S3 单节点全能模式（已启用自参考相位消噪 + 虚拟频段外推，无需第 2 块 ESP32）");
  } else if (!nB.uploads) {
    add("nodeB", "Node B", "info", "未检测到第 2 块板子，系统已自动兼容单节点采集");
  } else {
    add("nodeB", "Node B", nB.online ? "ok" : "warn", `${nB.online ? "在线" : "离线"} · ${nB.age ?? "?"}s 前上传 · ${nB.uploads} 次/${nB.recs} 条`);
  }

  const L = s.last;
  if (!L) {
    add("csi", "CSI 剖面与物体检测", "warn", "正在汇聚第一轮 CSI 扫描数据…");
  } else {
    add("csi", "CSI 剖面", "ok", `序号 ${s.seq} · 模式 ${L.mode} · 样本对 ${L.pairs} · 信道 ${L.channelsOk.length}/${s.plan} · 合成带宽 ${L.bwMHz}MHz · 分辨率 ${L.resM}m`);
    add("stitch", "相位标定与拼接", L.coherence > 0.5 ? "ok" : "warn", `帧内相干 ${L.coherence} · 参考相关 ${L.refCorr} · 覆盖频点 ${L.bins}`);
    const objs = L.objects ?? [];
    add(
      "objects",
      "空间物体检测",
      objs.length > 0 ? "ok" : "info",
      `当前检出 ${objs.length} 个空间目标：` +
        (objs.length ? objs.map((o) => `${o.label}(R=${o.rangeM}m,${o.db}dB)`).join("；") : "环境平稳"),
    );
    add(
      "sense",
      "人体与微动感知",
      L.sense.calibrated ? "ok" : "info",
      `${L.sense.level} · 存在 ${L.sense.present} · 运动 ${(L.sense.motion * 100).toFixed(0)}% · 呼吸 ${L.sense.breathBpm ?? "—"} BPM (置信 ${L.sense.breathConf}) · 活动距离 ${L.sense.activeR ?? "—"}m`,
    );
  }

  const g = s.gpu;
  add(
    "gpu",
    "Kaggle 云端算力",
    g.cuda > 0 ? "ok" : "info",
    g.cuda > 0
      ? `${g.devices.join(" | ")} · 显存池 ${JSON.stringify(g.vramHeldMB ?? [])}MB · IFFT(${g.nfft}) ${g.cir_ms}ms · MUSIC ${g.music_ms}ms`
      : `CPU 运算 (${g.err || "未开 GPU"}) · IFFT ${g.cir_ms}ms · MUSIC ${g.music_ms}ms`,
  );
  return out;
}

export function buildLogText(x: DiagCtx, events: EventItem[]): string {
  const mark: Record<string, string> = { ok: "✅", warn: "⚠️", fail: "❌", info: "ℹ️" };
  const lines: string[] = [
    `# ESP32-S3 单/双节点自适应 WiFi CSI 成像与物体检测系统 · 检测日志  ${new Date().toLocaleString("zh-CN", { hour12: false })}`,
    `页面: ${typeof location !== "undefined" ? location.href : ""}`,
    `浏览器: ${typeof navigator !== "undefined" ? navigator.userAgent : ""}`,
    "",
    "## 浏览器侧检测",
  ];
  for (const c of clientChecks(x)) lines.push(`${mark[c.status]} ${c.name}: ${c.detail}`);
  if (x.serverDiag?.items?.length) {
    lines.push("", "## 主机(Kaggle)侧检测");
    for (const c of x.serverDiag.items) lines.push(`${mark[c.status] || "•"} ${c.name}: ${c.detail}`);
  }
  if (x.serverDiag?.events?.length) {
    lines.push("", "## 主机事件(最近)");
    for (const e of x.serverDiag.events.slice(-40)) lines.push(`${new Date(e.t * 1000).toLocaleTimeString("zh-CN", { hour12: false })} [${e.lv}] ${e.msg}`);
  }
  if (events.length) {
    lines.push("", "## 浏览器事件");
    for (const e of events.slice(-40)) lines.push(`${new Date(e.t).toLocaleTimeString("zh-CN", { hour12: false })} [${e.lv}] ${e.msg}`);
  }
  if (x.state?.last) {
    lines.push("", "## 最近一轮摘要(JSON)");
    const { music, spectrum, ...rest } = x.state.last;
    void music;
    void spectrum;
    lines.push(JSON.stringify({ seq: x.state.seq, ...rest }));
  }
  return lines.join("\n");
}
