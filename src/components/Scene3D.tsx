// 3D 视图：人体线框成像 + 路径椭圆 + 距离-时间地形 + 两个节点。
// 鼠标：左键旋转 / 右键平移 / 滚轮缩放（触屏：单指旋转、双指缩放平移）。
// 渲染循环 60fps，检测结果经临界阻尼平滑，保证"丝滑"；React 不参与逐帧更新。
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { DL, NDISP, NT, type RadarEngine } from "@/lib/dsp";
import type { Detector } from "@/lib/detector";
import { createAvatar } from "@/lib/avatar";

export interface SceneOptions {
  terrain: boolean;
  ellipses: boolean;
  avatar: boolean;
  trail: boolean;
  autoRotate: boolean;
}

interface Props {
  engine: RadarEngine;
  detector: Detector;
  baseline: number;
  options: SceneOptions;
  resetSignal: number;
  onFps?: (fps: number) => void;
}

const HEIGHT = 6;
const Z_FRONT = -16;
const Z_STEP = 0.5;
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
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (mat) {
      (Array.isArray(mat) ? mat : [mat]).forEach((x) => {
        const sm = x as THREE.SpriteMaterial;
        if (sm.map) sm.map.dispose();
        x.dispose();
      });
    }
  });
}

function ellipsePts(L: number, d: number, n = 180) {
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

function blobTexture() {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 128;
  const g = cv.getContext("2d")!;
  const gr = g.createRadialGradient(64, 64, 2, 64, 64, 62);
  gr.addColorStop(0, "rgba(255,255,255,0.95)");
  gr.addColorStop(0.35, "rgba(255,255,255,0.45)");
  gr.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export default function Scene3D({ engine, detector, baseline, options, resetSignal, onFps }: Props) {
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
    scene.fog = new THREE.FogExp2(0x050a14, 0.012);
    const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 500);
    const home = { pos: new THREE.Vector3(0, 5.2, 10.5), target: new THREE.Vector3(0, 1.0, 0.5) };
    camera.position.copy(home.pos);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(home.target);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.zoomSpeed = 1.1;
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    controls.minDistance = 1.5;
    controls.maxDistance = 160;
    controls.maxPolarAngle = Math.PI * 0.495;
    controls.autoRotateSpeed = 0.9;
    controls.update();
    apiRef.current = {
      reset: () => {
        camera.position.copy(home.pos);
        controls.target.copy(home.target);
        controls.update();
      },
    };

    // ---------- 地面
    const grid = new THREE.GridHelper(80, 80, 0x16456b, 0x0b2038);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.5;
    scene.add(grid);
    const grid2 = new THREE.GridHelper(16, 32, 0x2a7fb0, 0x123a5a);
    (grid2.material as THREE.Material).transparent = true;
    (grid2.material as THREE.Material).opacity = 0.35;
    grid2.position.y = 0.01;
    scene.add(grid2);

    // ---------- 地形（路径长度-时间）
    const NX = NDISP;
    const NZ = NT;
    const positions = new Float32Array(NX * NZ * 3);
    const colors = new Float32Array(NX * NZ * 3);
    const heights = new Float32Array(NX * NZ);
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
    terrain.add(
      new THREE.Mesh(tg, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.86, side: THREE.DoubleSide })),
      new THREE.Mesh(tg, new THREE.MeshBasicMaterial({ color: 0x7fd8ff, wireframe: true, transparent: true, opacity: 0.1, depthWrite: false })),
    );
    for (const L of [0, 10, 20, 30]) {
      const s = label(`L=${L}m`, "#cfe8ff", 0.55);
      s.position.set(L - X_HALF, 0.8, Z_FRONT + 1.6);
      terrain.add(s);
    }
    const tlabel = label("路径长度-时间地形（扫频剖面）", "#9bd7ff", 0.9);
    tlabel.position.set(0, HEIGHT + 0.8, Z_FRONT - 4);
    terrain.add(tlabel);
    scene.add(terrain);

    // ---------- 节点
    const nodes = new THREE.Group();
    scene.add(nodes);
    const mkNode = (color: number) => {
      const g = new THREE.Group();
      const board = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.05, 0.6), new THREE.MeshBasicMaterial({ color: 0x0c2a44 }));
      const edge = new THREE.LineSegments(new THREE.EdgesGeometry(board.geometry), new THREE.LineBasicMaterial({ color }));
      const orb = new THREE.Mesh(new THREE.SphereGeometry(0.16, 20, 14), new THREE.MeshBasicMaterial({ color }));
      orb.position.y = 0.3;
      const halo = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.52, 40), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, side: THREE.DoubleSide }));
      halo.rotation.x = -Math.PI / 2;
      halo.position.y = 0.03;
      const beam = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 2.4, 0)]),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.7 }),
      );
      g.add(board, edge, orb, halo, beam);
      return { g, orb, halo };
    };
    const nA = mkNode(0x22d3ee);
    const nB = mkNode(0xf472b6);
    nodes.add(nA.g, nB.g);
    const lblA = label("ESP32-1", "#67e8f9", 0.3);
    const lblB = label("ESP32-2", "#f9a8d4", 0.3);
    nodes.add(lblA, lblB);
    let lblBase: THREE.Sprite | null = null;
    const losGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-1, 0.3, 0), new THREE.Vector3(1, 0.3, 0)]);
    const losLine = new THREE.Line(losGeo, new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.9 }));
    nodes.add(losLine);

    // ---------- 椭圆
    const rings = new THREE.Group();
    scene.add(rings);
    let builtBase = -1;
    const build = (d: number) => {
      builtBase = d;
      for (const ch of [...rings.children]) {
        rings.remove(ch);
        disposeObj(ch);
      }
      nA.g.position.set(-d / 2, 0.06, 0);
      nB.g.position.set(d / 2, 0.06, 0);
      lblA.position.set(-d / 2, 2.7, 0);
      lblB.position.set(d / 2, 3.1, 0);
      losGeo.setFromPoints([new THREE.Vector3(-d / 2, 0.3, 0), new THREE.Vector3(d / 2, 0.3, 0)]);
      if (lblBase) {
        nodes.remove(lblBase);
        disposeObj(lblBase);
      }
      lblBase = label(`基线 ${d.toFixed(2)}m`, "#e2f4ff", 0.26);
      lblBase.position.set(0, 0.7, 0.8);
      nodes.add(lblBase);
      for (const L of [4, 8, 12, 18, 24, 30]) {
        if (L <= d + 0.01) continue;
        const { pts, b } = ellipsePts(L, d);
        rings.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x1d8fc9, transparent: true, opacity: 0.4 })));
        const s = label(`L=${L}m`, "#cfe8ff", 0.24);
        s.position.set(0, 0.15, b + 0.5);
        rings.add(s);
      }
    };

    // 估计路径长度的高亮椭圆（实时跟随目标）
    const hiGeo = new THREE.BufferGeometry();
    hiGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(181 * 3), 3));
    const hiLine = new THREE.Line(hiGeo, new THREE.LineBasicMaterial({ color: 0xfbbf24, transparent: true, opacity: 0.9 }));
    hiLine.frustumCulled = false;
    scene.add(hiLine);

    // ---------- 人体
    const avatar = createAvatar();
    scene.add(avatar.root);
    const blobTex = blobTexture();
    const blob = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: blobTex, color: 0x38bdf8, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    blob.rotation.x = -Math.PI / 2;
    blob.position.y = 0.04;
    scene.add(blob);
    const plabel = label("检测到人体", "#fde68a", 0.3, "rgba(60,40,0,0.7)");
    scene.add(plabel);

    const TRAIL = 120;
    const trailPos = new Float32Array(TRAIL * 3);
    const trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute("position", new THREE.BufferAttribute(trailPos, 3));
    trailGeo.setDrawRange(0, 0);
    const trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ color: 0xfacc15, transparent: true, opacity: 0.7 }));
    trail.frustumCulled = false;
    scene.add(trail);
    let trailN = 0;
    let trailAt = 0;

    // 感知波：从节点中心向外扩散的圆环（有运动时出现）
    const pulses: THREE.Mesh[] = [];
    for (let i = 0; i < 3; i++) {
      const m = new THREE.Mesh(new THREE.RingGeometry(0.97, 1, 96), new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
      m.rotation.x = -Math.PI / 2;
      m.position.y = 0.05;
      scene.add(m);
      pulses.push(m);
    }

    // ---------- 尺寸
    const resize = () => {
      const w = host.clientWidth || 800;
      const h = host.clientHeight || 600;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);

    // ---------- 动画状态
    const st = {
      vis: 0,
      pos: new THREE.Vector3(0, 0, 3),
      prev: new THREE.Vector3(0, 0, 3),
      vel: new THREE.Vector3(),
      yaw: 0,
      L: 6,
      phase: 0,
      amp: 0,
      glow: 0,
      init: false,
    };
    let builtVersion = -1;
    let last = performance.now();
    let fpsN = 0;
    let fpsT = last;
    let raf = 0;
    let disposed = false;
    const tmpCol = [0, 0, 0];

    const frame = () => {
      if (disposed) return;
      raf = requestAnimationFrame(frame);
      const now = performance.now();
      if (host.clientWidth === 0 || host.clientHeight === 0) {
        last = now; // 页面被隐藏（在复制代码界面）时不渲染，省电；数据处理仍在后台继续
        return;
      }
      const dt = Math.min(0.1, Math.max(0.001, (now - last) / 1000));
      last = now;
      const time = now / 1000;
      const opt = optRef.current;
      const d = Math.max(0.1, baseRef.current);
      if (Math.abs(d - builtBase) > 1e-6) build(d);
      rings.visible = opt.ellipses;
      terrain.visible = opt.terrain;
      controls.autoRotate = opt.autoRotate;

      const ds = detector.state;
      const motion = ds.motion;

      // ---- 估计位置
      let Lt = d + 3.4 - 1.4 * motion;
      let fromCir = false;
      if (now - engine.stats.lastSweepAt < 9000 && engine.stats.lastSweepAt > 0) {
        let bestDyn = 0.16;
        for (const p of engine.peaks) {
          if (!p.los && p.dyn > bestDyn && p.L > d + 0.5) {
            bestDyn = p.dyn;
            Lt = p.L;
            fromCir = true;
          }
        }
      }
      st.L += (Lt - st.L) * (1 - Math.exp(-dt / (fromCir ? 0.6 : 1.0)));
      const a = st.L / 2;
      const c = d / 2;
      const b = Math.sqrt(Math.max(0.04, a * a - c * c));
      const phi = Math.PI / 2 - ds.bias * 0.95;
      const tx = a * Math.cos(phi);
      const tz = b * Math.sin(phi);
      if (!st.init) {
        st.pos.set(tx, 0, tz);
        st.prev.copy(st.pos);
        st.init = true;
      }
      const k = 1 - Math.exp(-dt / 0.28);
      st.pos.x += (tx - st.pos.x) * k;
      st.pos.z += (tz - st.pos.z) * k;
      st.vel.set((st.pos.x - st.prev.x) / dt, 0, (st.pos.z - st.prev.z) / dt);
      st.prev.copy(st.pos);

      // ---- 可见度（淡入淡出）
      const target = opt.avatar && ds.presence ? 1 : 0;
      st.vis += (target - st.vis) * (1 - Math.exp(-dt / (target > st.vis ? 0.12 : 0.6)));
      avatar.setOpacity(st.vis);
      avatar.root.position.copy(st.pos);
      // 朝向：移动时朝运动方向，否则朝向节点连线中心
      const sp = Math.hypot(st.vel.x, st.vel.z);
      const faceX = sp > 0.12 ? st.vel.x : -st.pos.x;
      const faceZ = sp > 0.12 ? st.vel.z : -st.pos.z;
      const wantYaw = Math.atan2(faceX, faceZ);
      let dy = wantYaw - st.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      st.yaw += dy * (1 - Math.exp(-dt / 0.25));
      avatar.root.rotation.y = st.yaw;
      // ---- 步态
      const moving = ds.moving;
      const wantAmp = moving ? 0.35 + 0.65 * Math.min(1, motion * 1.6) : 0;
      st.amp += (wantAmp - st.amp) * (1 - Math.exp(-dt / 0.15));
      st.phase += dt * Math.PI * 2 * (0.7 + 1.5 * motion) * (st.amp > 0.05 ? 1 : 0);
      const bpm = detector.breathBpm > 0 ? detector.breathBpm : 16;
      const breath = Math.sin(time * Math.PI * 2 * (bpm / 60));
      st.glow += ((moving ? 1 : 0) - st.glow) * (1 - Math.exp(-dt / 0.2));
      avatar.animate(st.phase, st.amp, breath, st.glow);

      plabel.visible = st.vis > 0.3;
      plabel.position.set(st.pos.x, 2.15, st.pos.z);
      plabel.material.opacity = st.vis;

      // ---- 脚下热点
      const bm = blob.material as THREE.MeshBasicMaterial;
      bm.opacity = st.vis * (0.25 + 0.55 * st.glow);
      bm.color.setRGB(0.2 + 0.8 * motion, 0.75 - 0.35 * motion, 0.95 - 0.8 * motion);
      const bs = 1.6 + 2.6 * motion + 0.15 * Math.sin(time * 4) * st.glow;
      blob.scale.set(bs, bs, 1);
      blob.position.x = st.pos.x;
      blob.position.z = st.pos.z;

      // ---- 高亮椭圆（当前估计 L）
      {
        const arr = hiGeo.getAttribute("position") as THREE.BufferAttribute;
        for (let i = 0; i <= 180; i++) {
          const t = (i / 180) * Math.PI * 2;
          arr.setXYZ(i, a * Math.cos(t), 0.06, b * Math.sin(t));
        }
        arr.needsUpdate = true;
        hiLine.visible = opt.ellipses && st.vis > 0.05;
        (hiLine.material as THREE.LineBasicMaterial).opacity = 0.25 + 0.65 * st.vis * (0.4 + 0.6 * st.glow);
      }

      // ---- 轨迹
      if (opt.trail && now - trailAt > 50 && st.vis > 0.2) {
        trailAt = now;
        if (trailN < TRAIL) trailN++;
        else trailPos.copyWithin(0, 3);
        const o = (trailN - 1) * 3;
        trailPos[o] = st.pos.x;
        trailPos[o + 1] = 0.06;
        trailPos[o + 2] = st.pos.z;
        trailGeo.setDrawRange(0, trailN);
        (trailGeo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
      }
      trail.visible = opt.trail && trailN > 1;

      // ---- 节点 / 链路 / 感知波
      const link = detector.links.p1.smooth > detector.links.p2.smooth ? detector.links.p1 : detector.links.p2;
      const lq = Math.max(0, Math.min(1, (link.smooth - 3) / 15));
      (losLine.material as THREE.LineBasicMaterial).color.setRGB(0.22 + 0.78 * lq, 0.74 - 0.35 * lq, 0.97 - 0.75 * lq);
      const pulse = 1 + 0.18 * Math.sin(time * 5) * (0.3 + motion);
      nA.orb.scale.setScalar(pulse);
      nB.orb.scale.setScalar(pulse);
      nA.halo.rotation.z = time * 0.8;
      nB.halo.rotation.z = -time * 0.8;
      for (let i = 0; i < pulses.length; i++) {
        const ph = (time * 0.7 + i / pulses.length) % 1;
        const m = pulses[i];
        const s = 0.5 + ph * (a + 2.5);
        m.scale.set(s, s * (b / Math.max(a, 0.1)), 1);
        (m.material as THREE.MeshBasicMaterial).opacity = (1 - ph) * 0.4 * st.glow;
        m.visible = st.glow > 0.02;
      }

      // ---- 地形
      if (terrain.visible) {
        if (builtVersion !== engine.version) {
          builtVersion = engine.version;
          const rows = engine.rows;
          const rd = engine.rowDyn;
          for (let r = 0; r < NZ; r++) {
            const src = rows[rows.length - 1 - r];
            const sd = rd[rd.length - 1 - r];
            for (let j = 0; j < NX; j++) {
              targets[r * NX + j] = src ? src[j] : 0;
              dyns[r * NX + j] = sd ? sd[j] : 0;
            }
          }
        }
        const ek = 1 - Math.exp(-dt / 0.18);
        for (let i = 0; i < NX * NZ; i++) {
          heights[i] += (targets[i] - heights[i]) * ek;
          positions[i * 3 + 1] = heights[i] * HEIGHT;
          cmap(heights[i], tmpCol, 0);
          const dy2 = Math.min(1, dyns[i] * 2.2);
          colors[i * 3] = tmpCol[0] + (1 - tmpCol[0]) * dy2 * 0.8;
          colors[i * 3 + 1] = tmpCol[1] * (1 - dy2 * 0.55);
          colors[i * 3 + 2] = tmpCol[2] + (0.7 - tmpCol[2]) * dy2 * 0.5;
        }
        (tg.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
        (tg.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
      }

      controls.update();
      renderer.render(scene, camera);
      fpsN++;
      if (now - fpsT >= 1000) {
        fpsCb.current?.(Math.round((fpsN * 1000) / (now - fpsT)));
        fpsN = 0;
        fpsT = now;
      }
    };
    raf = requestAnimationFrame(frame);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      avatar.dispose();
      blobTex.dispose();
      disposeObj(scene);
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [engine, detector]);

  return <div ref={hostRef} className="absolute inset-0" />;
}
