// ============================================================================
//  高灵敏度「有人 / 运动」检测器（浏览器内运行，输入 = 每一条 CSI 记录，输出 10~20Hz）
//
//  为什么要重写（对旧版的批判）：
//   1. 旧版 normalizePacket 先把每个包按 RMS 归一化再比较 → 把"人挡住/反射造成的整体功率变化"
//      这一最强的人体特征直接抹掉了，只剩频谱形状的微小变化。
//   2. 旧版只在启动后前 6 秒做一次校准；校准时你正好在走动 → 基线被污染 → 永远"静止"。
//   3. 旧版阈值 z>1.5 才开始、z>10.5 才满格，且 sigma 有 mean*8% 的下限 → 对轻微扰动几乎没反应。
//   4. 旧版完全丢弃路由器(AP)链路的 CSI，只用两块板之间的短链路（基线 0.3m 时直达波太强，人几乎扰动不了）。
//
//  新方案（每条链路独立、全自适应，无需手动校准）：
//   · 4 条链路：ESP32-1 收对端 / ESP32-2 收对端 / ESP32-1 收路由器 / ESP32-2 收路由器
//   · 每个包提取：  turb = std(幅度)/mean(幅度)（子载波间"湍流"，对 AGC 免疫）
//                   lp   = 20·log10(mean 幅度)（总功率 dB，人体遮挡/反射的最强特征）
//                   d    = 1 - Pearson(幅度形状, 慢速参考形状)（频谱形状漂移）
//                   ad   = mean|形状 - 参考形状|
//   · 700ms 滑窗统计：std(turb)、std(lp)、mean(d)、mean(ad)
//   · 噪声底 = 过去 90 秒窗口的 10 分位数（人走动 <90% 的时间，底就是对的；启动时用最小值）→ 不怕校准时有人
//   · 链路得分 = 4 个统计量与噪声底之比的平均值；>阈值即"运动"，带迟滞与保持，不闪烁
//   · 总体运动强度 = 各链路最大值（最灵敏的链路说了算）
// ============================================================================
import type { CsiFrame } from "./protocol";
import { LINK_PEER } from "./protocol";

export type LinkId = "p1" | "p2" | "a1" | "a2";
export const LINK_IDS: LinkId[] = ["p1", "p2", "a1", "a2"];
export const LINK_NAMES: Record<LinkId, string> = {
  p1: "ESP32-1 ⇐ ESP32-2",
  p2: "ESP32-2 ⇐ ESP32-1",
  a1: "ESP32-1 ⇐ 路由器",
  a2: "ESP32-2 ⇐ 路由器",
};

const VALID: number[] = [];
for (let k = -26; k <= 26; k++) if (k !== 0) VALID.push(k < 0 ? k + 64 : k);
const NV = VALID.length; // 52

const WIN_MS = 700;
const FLOOR_WIN_MS = 90_000;
const EPS = [0.0025, 0.05, 0.0015, 0.003]; // 各统计量的绝对下限（防止噪声底趋于 0 时比值爆炸）

interface Sample {
  t: number;
  turb: number;
  lp: number;
  d: number;
  ad: number;
}

export interface LinkState {
  id: LinkId;
  fps: number;
  score: number; // z 型得分：安静时约 0~3，越大越动
  intensity: number; // 0..1
  active: boolean; // 近 1.5 秒有数据
  stats: number[];
  floors: number[];
  rssi: number;
}

function median(a: number[]): number {
  const b = a.slice().sort((x, y) => x - y);
  const n = b.length;
  return n % 2 ? b[(n - 1) >> 1] : 0.5 * (b[n / 2 - 1] + b[n / 2]);
}
function robustStd(a: number[]): number {
  const m = median(a);
  return 1.4826 * median(a.map((x) => Math.abs(x - m)));
}

class Link {
  id: LinkId;
  ref: Float32Array | null = null;
  samples: Sample[] = [];
  hist: { t: number; s: number[] }[] = [];
  floors: number[] = [EPS[0] * 2, EPS[1] * 2, EPS[2] * 2, EPS[3] * 2];
  spread: number[] = [EPS[0], EPS[1], EPS[2], EPS[3]];
  floorsInit = false;
  stats = [0, 0, 0, 0];
  score = 0;
  smooth = 0;
  lastT = 0;
  lastFloorAt = 0;
  fpsN = 0;
  fpsAt = 0;
  fps = 0;
  rssi = 0;
  seen = 0;
  minSeen: number[] = [1e9, 1e9, 1e9, 1e9];
  private a = new Float32Array(NV);
  private n = new Float32Array(NV);

  constructor(id: LinkId) {
    this.id = id;
  }

  push(f: CsiFrame, now: number) {
    const a = this.a;
    let sum = 0;
    for (let i = 0; i < NV; i++) {
      const s = VALID[i];
      const v = Math.hypot(f.re[s], f.im[s]);
      a[i] = v;
      sum += v;
    }
    const mean = sum / NV;
    if (mean < 1.2) return; // 信号太弱（或全零包）
    let vr = 0;
    for (let i = 0; i < NV; i++) vr += (a[i] - mean) * (a[i] - mean);
    const turb = Math.sqrt(vr / NV) / mean;
    const lp = 20 * Math.log10(mean);
    const n = this.n;
    for (let i = 0; i < NV; i++) n[i] = a[i] / mean;
    let d = 0;
    let ad = 0;
    if (!this.ref) {
      this.ref = Float32Array.from(n);
    } else {
      const ref = this.ref;
      let sn = 0;
      let sr = 0;
      for (let i = 0; i < NV; i++) {
        sn += n[i];
        sr += ref[i];
      }
      sn /= NV;
      sr /= NV;
      let cov = 0;
      let vn = 0;
      let vrf = 0;
      for (let i = 0; i < NV; i++) {
        const x = n[i] - sn;
        const y = ref[i] - sr;
        cov += x * y;
        vn += x * x;
        vrf += y * y;
        ad += Math.abs(n[i] - ref[i]);
      }
      ad /= NV;
      d = 1 - cov / Math.sqrt(Math.max(1e-12, vn * vrf));
      if (d < 0) d = 0;
      // 慢速参考（τ≈2.5 秒@40Hz）：静止时跟随环境，运动时偏离
      for (let i = 0; i < NV; i++) ref[i] += 0.012 * (n[i] - ref[i]);
    }
    this.samples.push({ t: now, turb, lp, d, ad });
    if (this.samples.length > 600) this.samples.splice(0, this.samples.length - 600);
    this.rssi = f.rssi;
    this.lastT = now;
    this.seen++;
    this.fpsN++;
  }

  /** 每 50~100ms 调用一次：滑窗统计 → 得分 */
  update(now: number) {
    if (now - this.fpsAt >= 1000) {
      this.fps = (this.fpsN * 1000) / Math.max(1, now - this.fpsAt);
      this.fpsN = 0;
      this.fpsAt = now;
    }
    const sm = this.samples;
    while (sm.length && now - sm[0].t > WIN_MS) sm.shift();
    if (now - this.lastT > 1500) {
      // 链路停了：得分衰减回 1
      this.score -= 0.1 * this.score;
      this.smooth -= 0.1 * this.smooth;
      return;
    }
    if (sm.length < 6) return;
    // 鲁棒统计（中位数 / MAD）：偶发的坏包（碰撞、AGC 毛刺，占 1~2 个）不会把四个统计量同时顶起来；
    // 真有人走动时整个窗口都在连续变化，中位数/MAD 照样大幅升高。
    const turbs = sm.map((x) => x.turb);
    const lps = sm.map((x) => x.lp);
    const st = [robustStd(turbs), robustStd(lps), median(sm.map((x) => x.d)), median(sm.map((x) => x.ad))];
    this.stats = st;
    // 历史（用于噪声底）：每 100ms 记一次
    if (now - this.lastFloorAt >= 100) {
      this.lastFloorAt = now;
      this.hist.push({ t: now, s: st });
      while (this.hist.length && now - this.hist[0].t > FLOOR_WIN_MS) this.hist.shift();
      for (let i = 0; i < 4; i++) this.minSeen[i] = Math.min(this.minSeen[i], st[i]);
      if (this.hist.length >= 15 && (!this.floorsInit || this.hist.length % 10 === 0)) this.recomputeFloors();
    }
    if (!this.floorsInit) return;
    // 每个统计量换算成 z = (当前 - 噪声底) / 该统计量自身的"安静时波动幅度"，4 个 z 取中位数（中间两个均值）：
    //  · 单个统计量被偶发坏包/AGC 抖动顶起来不会误报；
    //  · 每个统计量按自己的波动幅度归一，AGC 抖动大的环境会自动变"迟钝"而不是误报；
    //  · 真有人走动时 4 个统计量同时远超波动幅度（z≫阈值）。
    const r = [0, 1, 2, 3].map((i) => (st[i] - this.floors[i]) / this.spread[i]).sort((a, b) => a - b);
    this.score = (r[2] + r[3]) / 2;
    // 平滑：上升快（80ms 级）、下降稍慢
    const k = this.score > this.smooth ? 0.6 : 0.18;
    this.smooth += k * (this.score - this.smooth);
  }

  private recomputeFloors() {
    const h = this.hist;
    for (let i = 0; i < 4; i++) {
      const arr = h.map((x) => x.s[i]).sort((a, b) => a - b);
      const q = (p: number) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
      const lo = q(0.1);
      // 只用分布的"下半部分"估计波动幅度（P25-P10 ≈ 0.61σ，P50-P10 ≈ 1.28σ），走动再多也不会把它撑大
      const sp = Math.max(2.1 * (q(0.25) - lo), 0.25 * lo, 0.5 * EPS[i]);
      if (!this.floorsInit) {
        this.floors[i] = lo;
        this.spread[i] = sp;
      } else {
        this.floors[i] += 0.5 * (lo - this.floors[i]);
        this.spread[i] += 0.5 * (sp - this.spread[i]);
      }
    }
    this.floorsInit = true;
  }

  resetFloor() {
    this.hist = [];
    this.floorsInit = false;
    this.minSeen = [1e9, 1e9, 1e9, 1e9];
    this.score = 0;
    this.smooth = 0;
    this.ref = null;
  }
}

export interface DetectorState {
  ready: boolean;
  motion: number; // 0..1（已平滑，用于驱动 3D）
  motionRaw: number; // 0..1（未平滑）
  moving: boolean;
  presence: boolean;
  reason: "none" | "moving" | "recent" | "breath";
  score: number; // 最强链路得分（安静时约 0~3）
  best: LinkId | null;
  bias: number; // -1..1：<0 偏向 ESP32-1，>0 偏向 ESP32-2
  lastMoveAt: number;
  links: LinkState[];
  totalFps: number;
  warmupPct: number;
}

export class Detector {
  sensitivity = 1.5; // 0.5 .. 4
  links: Record<LinkId, Link> = { p1: new Link("p1"), p2: new Link("p2"), a1: new Link("a1"), a2: new Link("a2") };
  state: DetectorState = {
    ready: false,
    motion: 0,
    motionRaw: 0,
    moving: false,
    presence: false,
    reason: "none",
    score: 0,
    best: null,
    bias: 0,
    lastMoveAt: 0,
    links: [],
    totalFps: 0,
    warmupPct: 0,
  };
  breathBpm = 0;
  private movingOn = false;
  private onCount = 0;
  private holdUntil = 0;
  private lastUpdate = 0;
  private motionSm = 0;
  private biasSm = 0;
  onChange?: (moving: boolean) => void;

  push(f: CsiFrame, now: number) {
    if (f.sweepId > 0) return; // 扫频包信道不同，不参与连续检测
    let id: LinkId;
    if (f.link === LINK_PEER) id = f.node === 1 ? "p1" : "p2";
    else id = f.node === 1 ? "a1" : "a2";
    this.links[id].push(f, now);
  }

  /** 触发阈值：灵敏度越大越容易触发 */
  thresholds() {
    const s = Math.max(0.3, this.sensitivity);
    return { on: 3 + 5 / s, off: 3 + 2.5 / s };
  }

  update(now: number) {
    const dt = this.lastUpdate ? Math.min(0.5, (now - this.lastUpdate) / 1000) : 0.05;
    this.lastUpdate = now;
    const th = this.thresholds();
    let ready = false;
    let best: LinkId | null = null;
    let bestScore = 0;
    let totalFps = 0;
    let warm = 0;
    let nAct = 0;
    const ls: LinkState[] = [];
    for (const id of LINK_IDS) {
      const l = this.links[id];
      l.update(now);
      const active = now - l.lastT < 1500 && l.fps > 1;
      if (active) {
        nAct++;
        totalFps += l.fps;
        if (l.floorsInit) {
          ready = true;
          if (l.smooth > bestScore) {
            bestScore = l.smooth;
            best = id;
          }
        }
        warm = Math.max(warm, Math.min(1, l.hist.length / 100));
      }
      ls.push({
        id,
        fps: l.fps,
        score: l.smooth,
        intensity: Math.max(0, Math.min(1, (l.smooth - 3) / 20)),
        active,
        stats: l.stats,
        floors: l.floors.slice(),
        rssi: l.rssi,
      });
    }
    const raw = Math.max(0, Math.min(1, (bestScore - 3) / 20));
    // 带迟滞与去抖
    if (!this.movingOn) {
      if (bestScore > th.on) this.onCount++;
      else this.onCount = 0;
      if (this.onCount >= 2) {
        this.movingOn = true;
        this.holdUntil = now + 1500;
        this.onChange?.(true);
      }
    } else {
      if (bestScore > th.off) this.holdUntil = Math.max(this.holdUntil, now + 1200);
      if (now > this.holdUntil && bestScore <= th.off) {
        this.movingOn = false;
        this.onCount = 0;
        this.onChange?.(false);
      }
    }
    if (this.movingOn) this.state.lastMoveAt = now;
    // 3D 驱动量：上升瞬时、下降 ~0.35s
    const target = this.movingOn ? Math.max(raw, 0.12) : raw * 0.5;
    const up = 1 - Math.exp(-dt / 0.06);
    const dn = 1 - Math.exp(-dt / 0.35);
    this.motionSm += (target - this.motionSm) * (target > this.motionSm ? up : dn);
    // 位置偏向：哪个节点的路由器链路被扰动得更厉害（更靠近目标）
    const s1 = this.links.a1.smooth - 3;
    const s2 = this.links.a2.smooth - 3;
    const p1 = this.links.p1.smooth - 3;
    const p2 = this.links.p2.smooth - 3;
    const e1 = Math.max(0, s1) + 0.3 * Math.max(0, p1);
    const e2 = Math.max(0, s2) + 0.3 * Math.max(0, p2);
    const tb = e1 + e2 > 1 ? (e2 - e1) / (e1 + e2) : 0;
    this.biasSm += (tb - this.biasSm) * (1 - Math.exp(-dt / 0.5));

    const recent = now - this.state.lastMoveAt < 8000 && this.state.lastMoveAt > 0;
    const breath = this.breathBpm > 0;
    const presence = this.movingOn || recent || breath;
    this.state = {
      ready,
      motion: this.motionSm,
      motionRaw: raw,
      moving: this.movingOn,
      presence,
      reason: this.movingOn ? "moving" : recent ? "recent" : breath ? "breath" : "none",
      score: bestScore,
      best,
      bias: this.biasSm,
      lastMoveAt: this.state.lastMoveAt,
      links: ls,
      totalFps,
      warmupPct: nAct ? warm : 0,
    };
  }

  resetBaseline() {
    for (const id of LINK_IDS) this.links[id].resetFloor();
    this.movingOn = false;
    this.onCount = 0;
    this.motionSm = 0;
  }
}
