"use client";
// 3D 视图：路径长度-时间地形 + 椭圆等路径线 + 两个节点。鼠标：左键旋转、右键平移、滚轮缩放。
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { DL, NDISP, NT, type Peak, type RadarEngine } from "@/lib/dsp";

export interface SceneOptions {
  terrain: boolean;
  ellipses: boolean;
  peakEllipses: boolean;
  autoRotate: boolean;
}

interface Props {
  engine: RadarEngine;
  baseline: number;
  options: SceneOptions;
  resetSignal: number;
  onFps?: (fps: number) => void;
}

const HEIGHT = 9;
const Z_FRONT = -9;
const Z_STEP = 0.55;
const X_HALF = ((NDISP - 1) * DL) / 2;

function label(text: string, color = "#e2f4ff", scale = 1, bg = "rgba(10,28,52,0.72)") {
  const cv = document.createElement("canvas");
  cv.width = 512;
  cv.height = 112;
  const g = cv.getContext("2d")!;
  g.fillStyle = bg;
  g.beginPath();
  g.roundRect(4, 4, 504, 104, 18);
  g.fill();
  g.font = "bold 54px system-ui, 'Microsoft YaHei', sans-serif";
  g.fillStyle = color;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, 256, 58);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false }));
  sp.scale.set(5.2 * scale, 1.14 * scale, 1);
  sp.renderOrder = 10;
  return sp;
}

function disposeObj(o: THREE.Object3D) {
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = (m as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (mat) {
      const arr = Array.isArray(mat) ? mat : [mat];
      arr.forEach((x) => {
        const sm = x as THREE.SpriteMaterial;
        if (sm.map) sm.map.dispose();
        x.dispose();
      });
    }
  });
}

function ellipsePoints(L: number, d: number, n = 160) {
  const a = L / 2;
  const c = d / 2;
  const b = Math.sqrt(Math.max(0, a * a - c * c));
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    pts.push(new THREE.Vector3(a * Math.cos(t), 0.03, b * Math.sin(t)));
  }
  return { pts, a, b };
}

function ellipseRibbon(L: number, d: number, w: number) {
  const n = 192;
  const a = L / 2;
  const c = d / 2;
  const b = Math.sqrt(Math.max(0, a * a - c * c));
  const pos = new Float32Array((n + 1) * 2 * 3);
  const idx: number[] = [];
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * Math.PI * 2;
    const ca = Math.cos(t);
    const sa = Math.sin(t);
    // 法线近似：沿 (b·cos, a·sin) 方向
    let nx = b * ca;
    let nz = a * sa;
    const nl = Math.hypot(nx, nz) || 1;
    nx /= nl;
    nz /= nl;
    const x = a * ca;
    const z = b * sa;
    pos.set([x - nx * w, 0.05, z - nz * w, x + nx * w, 0.05, z + nz * w], i * 6);
    if (i < n) {
      const k = i * 2;
      idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  return { geo: g, b };
}

const STOPS: [number, number, number, number][] = [
  [0, 0.08, 0.16, 0.5],
  [0.22, 0.04, 0.55, 0.85],
  [0.45, 0.1, 0.8, 0.55],
  [0.68, 0.85, 0.82, 0.2],
  [0.85, 0.98, 0.5, 0.15],
  [1, 0.95, 0.2, 0.25],
];
function cmap(v: number, out: number[], o: number) {
  v = Math.max(0, Math.min(1, v));
  for (let i = 1; i < STOPS.length; i++) {
    if (v <= STOPS[i][0]) {
      const a = STOPS[i - 1];
      const b = STOPS[i];
      const t = (v - a[0]) / (b[0] - a[0]);
      out[o] = a[1] + (b[1] - a[1]) * t;
      out[o + 1] = a[2] + (b[2] - a[2]) * t;
      out[o + 2] = a[3] + (b[3] - a[3]) * t;
      return;
    }
  }
  out[o] = 0.95;
  out[o + 1] = 0.2;
  out[o + 2] = 0.25;
}

export default function Scene3D({ engine, baseline, options, resetSignal, onFps }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const optRef = useRef(options);
  const baseRef = useRef(baseline);
  const apiRef = useRef<{ reset: () => void } | null>(null);
  const fpsCb = useRef(onFps);

  useEffect(() => {
    optRef.current = options;
    baseRef.current = baseline;
    fpsCb.current = onFps;
  });

  useEffect(() => {
    apiRef.current?.reset();
  }, [resetSignal]);

  useEffect(() => {
    const host = hostRef.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.setClearColor(0x050a14, 1);
    host.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";
    renderer.domElement.style.touchAction = "none";

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x050a14, 0.011);
    const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 400);
    const home = { pos: new THREE.Vector3(2, 17, 30), target: new THREE.Vector3(0, 2, -8) };
    camera.position.copy(home.pos);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(home.target);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    controls.minDistance = 3;
    controls.maxDistance = 140;
    controls.maxPolarAngle = Math.PI * 0.495;
    controls.autoRotateSpeed = 0.8;
    controls.update();
    apiRef.current = {
      reset: () => {
        camera.position.copy(home.pos);
        controls.target.copy(home.target);
        controls.update();
      },
    };

    // ---------- 地面网格
    const grid = new THREE.GridHelper(80, 80, 0x16456b, 0x0b2038);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.45;
    scene.add(grid);

    // ---------- 地形
    const NX = NDISP;
    const NZ = NT;
    const positions = new Float32Array(NX * NZ * 3);
    const colors = new Float32Array(NX * NZ * 3);
    const heights = new Float32Array(NX * NZ); // 当前
    const targets = new Float32Array(NX * NZ);
    const dyns = new Float32Array(NX * NZ);
    for (let r = 0; r < NZ; r++)
      for (let j = 0; j < NX; j++) {
        const o = (r * NX + j) * 3;
        positions[o] = j * DL - X_HALF;
        positions[o + 1] = 0;
        positions[o + 2] = Z_FRONT - r * Z_STEP;
      }
    const indices: number[] = [];
    for (let r = 0; r < NZ - 1; r++)
      for (let j = 0; j < NX - 1; j++) {
        const a = r * NX + j;
        indices.push(a, a + 1, a + NX, a + 1, a + NX + 1, a + NX);
      }
    const tg = new THREE.BufferGeometry();
    tg.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    tg.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    tg.setIndex(indices);
    const terrain = new THREE.Group();
    const surf = new THREE.Mesh(tg, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.86, side: THREE.DoubleSide }));
    const wire = new THREE.Mesh(tg, new THREE.MeshBasicMaterial({ color: 0x7fd8ff, wireframe: true, transparent: true, opacity: 0.1, depthWrite: false }));
    terrain.add(surf, wire);
    scene.add(terrain);

    // 地形 L 轴标签
    const axis = new THREE.Group();
    for (const L of [0, 10, 20, 30]) {
      const s = label(`L=${L}m`, "#cfe8ff", 0.55);
      s.position.set(L - X_HALF, 0.8, Z_FRONT + 1.6);
      axis.add(s);
    }
    terrain.add(axis);

    // ---------- 节点
    const nodes = new THREE.Group();
    scene.add(nodes);
    const mkNode = (color: number) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.38, 24, 16), new THREE.MeshBasicMaterial({ color }));
      const halo = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.7, 40), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, side: THREE.DoubleSide }));
      halo.rotation.x = -Math.PI / 2;
      halo.position.y = 0.04;
      const g = new THREE.Group();
      g.add(m, halo);
      const beamGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 8, 0)]);
      g.add(new THREE.Line(beamGeo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.8 })));
      return g;
    };
    const nodeA = mkNode(0x22d3ee);
    const nodeB = mkNode(0xf472b6);
    nodes.add(nodeA, nodeB);
    const lblA = label("ESP32-1 发起端", "#67e8f9", 0.8);
    const lblB = label("ESP32-2 响应端", "#f9a8d4", 0.8);
    lblA.position.set(0, 9, 0);
    lblB.position.set(0, 9.9, 0);
    nodes.add(lblA, lblB);
    let lblBase: THREE.Sprite | null = null;

    // ---------- 等路径椭圆
    const rings = new THREE.Group();
    scene.add(rings);
    const dyn = new THREE.Group();
    scene.add(dyn);

    let builtBase = -1;
    const buildStatic = (d: number) => {
      builtBase = d;
      for (const ch of [...rings.children]) {
        rings.remove(ch);
        disposeObj(ch);
      }
      nodeA.position.set(-d / 2, 0.2, 0);
      nodeB.position.set(d / 2, 0.2, 0);
      lblA.position.set(-d / 2, 9, 0);
      lblB.position.set(d / 2, 9.9, 0);
      if (lblBase) {
        nodes.remove(lblBase);
        disposeObj(lblBase);
      }
      lblBase = label(`基线 ${d.toFixed(2)}m`, "#e2f4ff", 0.7);
      lblBase.position.set(0, 1.2, 1.2);
      nodes.add(lblBase);
      for (const L of [6, 12, 18, 24, 30]) {
        if (L <= d + 0.01) continue;
        const { pts, b } = ellipsePoints(L, d);
        const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x1d8fc9, transparent: true, opacity: 0.45 }));
        rings.add(line);
        const s = label(`L=${L}m`, "#cfe8ff", 0.62);
        s.position.set(0, 0.2, b + 0.9);
        rings.add(s);
      }
    };

    let builtVersion = -1;
    const buildPeaks = (peaks: Peak[], d: number) => {
      for (const ch of [...dyn.children]) {
        dyn.remove(ch);
        disposeObj(ch);
      }
      for (const p of peaks) {
        if (p.L <= d + 0.4) continue;
        const moving = p.dyn > 0.25;
        const w = 0.1 + 0.12 * p.amp;
        const { geo, b } = ellipseRibbon(p.L, d, w);
        const col = p.los ? 0x22d3ee : moving ? 0xff4fd8 : 0xffb020;
        const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.35 + 0.6 * p.amp, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
        dyn.add(m);
        const s = label(`${moving ? "运动目标" : "反射体"} L=${p.L.toFixed(1)}m`, moving ? "#ffd1f3" : "#ffe4a8", 0.6, "rgba(40,20,10,0.7)");
        s.position.set(0, 0.6, -b - 0.9);
        dyn.add(s);
      }
    };

    // ---------- 尺寸
    const resize = () => {
      const w = host.clientWidth || 1;
      const h = host.clientHeight || 1;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();

    // ---------- 动画
    let raf = 0;
    let last = performance.now();
    let frames = 0;
    let fpsAt = last;
    const tmp = [0, 0, 0];
    let animating = true;
    let maxDelta = 0;
    let lastAnimVersion = -2;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const op = optRef.current;
      const d = baseRef.current;
      if (Math.abs(d - builtBase) > 1e-6) {
        buildStatic(d);
        builtVersion = -1;
      }
      if (builtVersion !== engine.version) {
        builtVersion = engine.version;
        const n = engine.rows.length;
        for (let r = 0; r < NZ; r++) {
          const row = r < n ? engine.rows[n - 1 - r] : null;
          const rd = r < n ? engine.rowDyn[n - 1 - r] : null;
          for (let j = 0; j < NX; j++) {
            targets[r * NX + j] = row ? row[j] : 0;
            dyns[r * NX + j] = rd ? rd[j] : 0;
          }
        }
        buildPeaks(engine.peaks, d);
      }
      // 平滑插值 → 顶点
      const k = 1 - Math.exp(-dt * 9);
      const motion = engine.sense.motion;
      if (builtVersion !== lastAnimVersion) {
        lastAnimVersion = builtVersion;
        animating = true;
      }
      for (let i = 0; animating && i < NX * NZ; i++) {
        heights[i] += (targets[i] - heights[i]) * k;
        maxDelta = Math.max(maxDelta, Math.abs(targets[i] - heights[i]));
        const h = heights[i];
        positions[i * 3 + 1] = Math.pow(h, 0.85) * HEIGHT;
        cmap(h, tmp, 0);
        const dv = Math.min(1, dyns[i] * 1.8);
        colors[i * 3] = tmp[0] + (1 - tmp[0]) * dv * 0.9;
        colors[i * 3 + 1] = tmp[1] * (1 - dv * 0.5) + 0.2 * dv;
        colors[i * 3 + 2] = tmp[2] + (0.9 - tmp[2]) * dv * 0.6;
      }
      if (animating) {
        (tg.attributes.position as THREE.BufferAttribute).needsUpdate = true;
        (tg.attributes.color as THREE.BufferAttribute).needsUpdate = true;
        if (maxDelta < 4e-4) animating = false;
        maxDelta = 0;
      }
      const pulse = 1 + motion * 0.9 + 0.08 * Math.sin(now / 280);
      nodeA.scale.setScalar(pulse);
      nodeB.scale.setScalar(pulse);
      terrain.visible = op.terrain;
      rings.visible = op.ellipses;
      dyn.visible = op.peakEllipses;
      controls.autoRotate = op.autoRotate;
      controls.update();
      renderer.render(scene, camera);
      frames++;
      if (now - fpsAt >= 500) {
        fpsCb.current?.(Math.round((frames * 1000) / (now - fpsAt)));
        frames = 0;
        fpsAt = now;
      }
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      disposeObj(scene);
      renderer.dispose();
      renderer.domElement.remove();
      apiRef.current = null;
    };
  }, [engine]);

  return <div ref={hostRef} className="absolute inset-0" />;
}
