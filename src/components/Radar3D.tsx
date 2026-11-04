import { useEffect, useRef } from "react";
import type { Obj } from "../lib/store";

/** 自研透视投影 3D 场景（零依赖）：距离-时间地形 + 路径椭圆 + ESP32/路由器 + 检测到的物体 */
export type SceneOpts = { terrain: boolean; ellipses: boolean; music: boolean; rotate: boolean };
type Props = {
  snap: any;
  hist: number[][];
  baseline: number;
  opts: SceneOpts;
  resetKey: number;
  onFps?: (fps: number) => void;
};

type V3 = [number, number, number];
const CAM0 = { yaw: -1.25, pitch: 0.68, dist: 54, tx: -9, ty: 10, tz: 0 };
const KIND_COL: Record<string, string> = {
  moving: "#ff4d6d",
  breathing: "#ff9f43",
  device: "#a78bfa",
  reflector: "#34d399",
  router: "#fbbf24",
};
const TX0 = -34; // 地形（距离-时间）放在椭圆区域左侧
const TW = 24;

function heat(v: number) {
  v = Math.max(0, Math.min(1, v));
  const r = Math.round(14 + 120 * v * v);
  const g = Math.round(46 + 190 * v);
  const b = Math.round(110 + 145 * v);
  return `rgb(${r},${g},${b})`;
}

export default function Radar3D({ snap, hist, baseline, opts, resetKey, onFps }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const P = useRef({ snap, hist, baseline, opts, onFps });
  P.current = { snap, hist, baseline, opts, onFps };
  const camRef = useRef({ ...CAM0 });

  useEffect(() => {
    Object.assign(camRef.current, CAM0);
  }, [resetKey]);

  useEffect(() => {
    const cv = ref.current!;
    const cx = cv.getContext("2d")!;
    const cam = camRef.current;
    let W = 1,
      H = 1,
      DPR = 1,
      raf = 0,
      last = 0,
      fpsT = performance.now(),
      fpsC = 0;
    let B = { px: 0, py: 0, pz: 0, fx: 0, fy: 0, fz: 0, rx: 0, ry: 0, rz: 0, ux: 0, uy: 0, uz: 0 };

    const resize = () => {
      DPR = Math.min(window.devicePixelRatio || 1, 2);
      const r = cv.getBoundingClientRect();
      W = Math.max(1, r.width);
      H = Math.max(1, r.height);
      cv.width = W * DPR;
      cv.height = H * DPR;
      cx.setTransform(DPR, 0, 0, DPR, 0, 0);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(cv);
    resize();

    const basis = () => {
      const cp = Math.cos(cam.pitch),
        sp = Math.sin(cam.pitch);
      const px = cam.tx + cam.dist * cp * Math.cos(cam.yaw);
      const py = cam.ty + cam.dist * cp * Math.sin(cam.yaw);
      const pz = cam.tz + cam.dist * sp;
      let fx = cam.tx - px,
        fy = cam.ty - py,
        fz = cam.tz - pz;
      const fl = Math.hypot(fx, fy, fz);
      fx /= fl;
      fy /= fl;
      fz /= fl;
      // right = f × up(0,0,1)
      let rx = fy,
        ry = -fx;
      const rl = Math.hypot(rx, ry) || 1;
      rx /= rl;
      ry /= rl;
      const rz = 0;
      // up' = r × f
      const ux = ry * fz - rz * fy,
        uy = rz * fx - rx * fz,
        uz = rx * fy - ry * fx;
      B = { px, py, pz, fx, fy, fz, rx, ry, rz, ux, uy, uz };
    };
    const proj = (x: number, y: number, z: number): [number, number, number] | null => {
      const dx = x - B.px,
        dy = y - B.py,
        dz = z - B.pz;
      const Z = dx * B.fx + dy * B.fy + dz * B.fz;
      if (Z < 0.5) return null;
      const f = Math.min(W, H * 1.6) * 0.95;
      return [W / 2 + (f * (dx * B.rx + dy * B.ry + dz * B.rz)) / Z, H / 2 - (f * (dx * B.ux + dy * B.uy + dz * B.uz)) / Z, Z];
    };
    const line = (a: V3, b: V3, col: string, w = 1) => {
      const p = proj(...a),
        q = proj(...b);
      if (!p || !q) return;
      cx.strokeStyle = col;
      cx.lineWidth = w;
      cx.beginPath();
      cx.moveTo(p[0], p[1]);
      cx.lineTo(q[0], q[1]);
      cx.stroke();
    };
    const label = (x: number, y: number, z: number, t: string, col: string, big = false) => {
      const p = proj(x, y, z);
      if (!p) return;
      cx.font = `${big ? "bold 15px" : "12px"} ui-sans-serif, system-ui, sans-serif`;
      const w = cx.measureText(t).width + 12;
      cx.fillStyle = "rgba(6,10,20,.78)";
      cx.fillRect(p[0] - w / 2, p[1] - 11, w, 22);
      cx.fillStyle = col;
      cx.textAlign = "center";
      cx.textBaseline = "middle";
      cx.fillText(t, p[0], p[1]);
    };
    const dot = (x: number, y: number, z: number, r: number, col: string, glow = 2.4) => {
      const p = proj(x, y, z);
      if (!p) return;
      const rr = Math.max(3.5, (r * 520) / p[2]);
      const g = cx.createRadialGradient(p[0], p[1], 0, p[0], p[1], rr * glow);
      g.addColorStop(0, col);
      g.addColorStop(0.35, col);
      g.addColorStop(1, "rgba(0,0,0,0)");
      cx.fillStyle = g;
      cx.beginPath();
      cx.arc(p[0], p[1], rr * glow, 0, 7);
      cx.fill();
      cx.fillStyle = "#fff";
      cx.globalAlpha = 0.85;
      cx.beginPath();
      cx.arc(p[0], p[1], Math.max(1.5, rr * 0.28), 0, 7);
      cx.fill();
      cx.globalAlpha = 1;
    };
    const ellipsePts = (b: number, L: number, n = 90): V3[] => {
      const a = (b + L) / 2,
        c = b / 2,
        bb = Math.sqrt(Math.max(a * a - c * c, 0.01));
      const out: V3[] = [];
      for (let i = 0; i <= n; i++) {
        const t = (i / n) * Math.PI * 2;
        out.push([a * Math.cos(t), bb * Math.sin(t), 0.02]);
      }
      return out;
    };
    const poly = (pts: V3[], col: string, w: number) => {
      let prev: ReturnType<typeof proj> = null;
      cx.strokeStyle = col;
      cx.lineWidth = w;
      for (const p3 of pts) {
        const p = proj(...p3);
        if (p && prev) {
          cx.beginPath();
          cx.moveTo(prev[0], prev[1]);
          cx.lineTo(p[0], p[1]);
          cx.stroke();
        }
        prev = p;
      }
    };

    const render = (ts: number) => {
      raf = requestAnimationFrame(render);
      if (ts - last < 28) return;
      last = ts;
      const { snap, hist, baseline: b, opts } = P.current;
      if (opts.rotate) cam.yaw += 0.004;
      basis();
      // 背景
      const bg = cx.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, "#050914");
      bg.addColorStop(1, "#02040a");
      cx.fillStyle = bg;
      cx.fillRect(0, 0, W, H);
      cx.globalAlpha = 1;

      // 地面网格
      for (let g = -60; g <= 60; g += 4) {
        line([g, -30, -0.01], [g, 70, -0.01], "rgba(34,120,170,.16)");
        line([-60, g + 10, -0.01], [60, g + 10, -0.01], "rgba(34,120,170,.16)");
      }

      // 路径椭圆
      const prof = snap?.profile;
      if (opts.ellipses) {
        for (const L of [3, 6, 12, 20, 30]) {
          poly(ellipsePts(b, L), "rgba(56,189,248,.28)", 1);
          const a = (b + L) / 2;
          label(a, 0, 0.1, `L=${L}m`, "#7dd3fc");
        }
        if (opts.music && prof?.music) {
          const m: number[] = prof.music;
          const pk: number[] = [];
          for (let i = 1; i < m.length - 1; i++) if (m[i] > m[i - 1] && m[i] >= m[i + 1] && m[i] > 0.25) pk.push(i);
          pk.sort((x, y) => m[y] - m[x]);
          pk.slice(0, 4).forEach((i) => poly(ellipsePts(b, (i / m.length) * (prof.axis_max || 30) + 0.01), "rgba(244,114,182,.7)", 1.6));
        }
      }

      // 距离-时间地形
      if (opts.terrain && hist.length > 1) {
        const R = hist.length,
          C = 64,
          dx = TW / 47,
          dy = 30 / (C - 1);
        const quads: { d: number; pts: [number, number][]; v: number }[] = [];
        const get = (r: number, c: number) => {
          const row = hist[r];
          const k = Math.min(row.length - 1, Math.floor((c / C) * row.length));
          return row[k] || 0;
        };
        for (let r = 0; r < R - 1; r++)
          for (let c = 0; c < C - 1; c++) {
            const v00 = get(r, c),
              v10 = get(r + 1, c),
              v11 = get(r + 1, c + 1),
              v01 = get(r, c + 1);
            const X0 = TX0 + (r + 47 - R + 1) * dx,
              X1 = X0 + dx,
              Y0 = c * dy,
              Y1 = Y0 + dy;
            const p = [proj(X0, Y0, v00 * 3.2), proj(X1, Y0, v10 * 3.2), proj(X1, Y1, v11 * 3.2), proj(X0, Y1, v01 * 3.2)];
            if (p.some((q) => !q)) continue;
            quads.push({ d: p[0]![2], pts: p.map((q) => [q![0], q![1]] as [number, number]), v: (v00 + v10 + v11 + v01) / 4 });
          }
        quads.sort((a, b2) => b2.d - a.d);
        for (const q of quads) {
          cx.fillStyle = heat(q.v);
          cx.strokeStyle = "rgba(120,200,255,.10)";
          cx.beginPath();
          cx.moveTo(q.pts[0][0], q.pts[0][1]);
          for (let i = 1; i < 4; i++) cx.lineTo(q.pts[i][0], q.pts[i][1]);
          cx.closePath();
          cx.fill();
          cx.stroke();
        }
      }
      if (opts.terrain) {
        // 地形边框与距离刻度
        const x0 = TX0,
          x1 = TX0 + TW;
        poly([[x0, 0, 0], [x1, 0, 0], [x1, 30, 0], [x0, 30, 0], [x0, 0, 0]], "rgba(125,211,252,.5)", 1.2);
        for (const L of [0, 10, 20, 30]) label(x0 - 2.5, L, 0, `L=${L}m`, "#9fb4d0");
        label(x0 - 5, 15, 0, "路径长度 L →", "#7dd3fc", true);
        label((x0 + x1) / 2, -2.5, 0, "时间 →（最新在右）", "#64748b");
      }

      // 节点：路由器 + ESP32
      const R: V3 = [-b / 2, 0, 0.3],
        E: V3 = [b / 2, 0, 0.3];
      line(R, E, "rgba(251,191,36,.7)", 2);
      label((R[0] + E[0]) / 2, 0, 1.1, `基线 ${b.toFixed(1)}m`, "#fbbf24");
      dot(...R, 0.7, "#fbbf24");
      dot(...E, 0.7, "#22d3ee");
      label(R[0], 0, 2.6, "路由器/热点", "#fbbf24", true);
      label(E[0], 0, 4.6, "ESP32-S3 (N16R8)", "#22d3ee", true);

      // 物体
      const objs: Obj[] = snap?.objects || [];
      const tt = ts / 1000;
      for (const o of objs) {
        if (o.kind === "router") continue;
        const col = KIND_COL[o.kind] || "#fff";
        let pos: V3 | null = null;
        if (o.kind === "device" && o.range_m != null) {
          const r = Math.max(1.2, o.range_m);
          pos = [E[0] + r * Math.cos(o.ang), E[1] + r * Math.sin(o.ang), 0.6];
          line(E, pos, "rgba(167,139,250,.35)", 1);
        } else if (o.kind === "reflector" && o.range_m != null) {
          const a = (b + o.range_m) / 2,
            c = b / 2,
            bb = Math.sqrt(Math.max(a * a - c * c, 0.01));
          pos = [a * Math.cos(o.ang), bb * Math.sin(o.ang), 0.6];
          line(R, pos, "rgba(52,211,153,.3)", 1);
          line(pos, E, "rgba(52,211,153,.3)", 1);
        }
        if (pos) {
          dot(...pos, 0.55 + 0.4 * o.conf, col);
          label(pos[0], pos[1], pos[2] + 2.4, o.label, col);
        } else if (o.kind === "moving" || o.kind === "breathing") {
          // 位置未知（单链路无角度）：以「感知区」脉冲表示“检测到了存在”，不伪造坐标
          for (let k = 0; k < 3; k++) {
            const ph = (tt * (o.kind === "moving" ? 0.9 : 0.3) + k / 3) % 1;
            poly(ellipsePts(b, 1 + ph * 14, 60).map((p) => [p[0], p[1], 0.05] as V3), `rgba(${o.kind === "moving" ? "255,77,109" : "255,159,67"},${(1 - ph) * 0.8})`, 2);
          }
          label(0, 12, 3, `${o.label}（位置未知·仅检测到存在）`, col, true);
        }
      }

      // 坐标轴指示
      line([0, 0, 0], [6, 0, 0], "rgba(255,255,255,.2)");

      fpsC++;
      if (ts - fpsT > 1000) {
        P.current.onFps?.(Math.round((fpsC * 1000) / (ts - fpsT)));
        fpsC = 0;
        fpsT = ts;
      }
    };
    raf = requestAnimationFrame(render);

    // 交互：左键旋转 / 右键或 Shift 平移 / 滚轮缩放 / 双指缩放
    const ptrs = new Map<number, { x: number; y: number }>();
    let pinch = 0;
    const down = (e: PointerEvent) => {
      cv.setPointerCapture(e.pointerId);
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        pinch = Math.hypot(a.x - b.x, a.y - b.y);
      }
    };
    const move = (e: PointerEvent) => {
      const p = ptrs.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x,
        dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch) cam.dist = Math.min(140, Math.max(8, (cam.dist * pinch) / d));
        pinch = d;
        return;
      }
      if (e.buttons & 2 || e.shiftKey) {
        const s = cam.dist * 0.0016;
        cam.tx -= (dx * B.rx - dy * B.ux) * s;
        cam.ty -= (dx * B.ry - dy * B.uy) * s;
        cam.tz -= -dy * B.uz * s * 0 + 0;
      } else {
        cam.yaw -= dx * 0.006;
        cam.pitch = Math.min(1.5, Math.max(0.08, cam.pitch + dy * 0.005));
      }
    };
    const up = (e: PointerEvent) => {
      ptrs.delete(e.pointerId);
      pinch = 0;
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      cam.dist = Math.min(140, Math.max(8, cam.dist * (1 + Math.sign(e.deltaY) * 0.1)));
    };
    const ctx = (e: Event) => e.preventDefault();
    cv.addEventListener("pointerdown", down);
    cv.addEventListener("pointermove", move);
    cv.addEventListener("pointerup", up);
    cv.addEventListener("pointercancel", up);
    cv.addEventListener("wheel", wheel, { passive: false });
    cv.addEventListener("contextmenu", ctx);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      cv.removeEventListener("pointerdown", down);
      cv.removeEventListener("pointermove", move);
      cv.removeEventListener("pointerup", up);
      cv.removeEventListener("pointercancel", up);
      cv.removeEventListener("wheel", wheel);
      cv.removeEventListener("contextmenu", ctx);
    };
  }, []);

  return <canvas ref={ref} className="absolute inset-0 h-full w-full touch-none cursor-grab active:cursor-grabbing" />;
}
