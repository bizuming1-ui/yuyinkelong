"use client";
import { forwardRef, useEffect, useImperativeHandle, useRef, type MutableRefObject } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { DetectedObject, ObjectKind, RadarState, Row } from "@/lib/radar";

export type SceneOpts = { terrain: boolean; ellipses: boolean; autoRotate: boolean; music: boolean; objects3d?: boolean };
export type SceneStatus = { gl: boolean; renderer: string; error: string; fps: number; pixelRatio: number };
export type Radar3DHandle = { resetView: () => void; focusObject: (obj: DetectedObject) => void };
type Props = {
  stateRef: MutableRefObject<RadarState | null>;
  rowsRef: MutableRefObject<Row[]>;
  baselineM: number;
  opts: SceneOpts;
  selectedObjId?: string | null;
  onStatus: (s: SceneStatus) => void;
};

const COLS = 128;
const ROWS = 72;
const TW = 30;
const TD = 18;
const TZ = -19;
const HMAX = 6;
const NEL = 7;
const NPT = 200;
const MAX_OBJ3D = 10;

function colormap(v: number, out: THREE.Color) {
  const stops: [number, number, number][] = [
    [0.02, 0.05, 0.16],
    [0.0, 0.35, 0.65],
    [0.0, 0.85, 0.85],
    [0.6, 0.95, 0.3],
    [1.0, 0.65, 0.1],
    [1.0, 0.2, 0.15],
  ];
  const x = Math.min(0.999, Math.max(0, v)) * (stops.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const a = stops[i];
  const b = stops[i + 1];
  out.setRGB(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f);
}

function drawLabelCanvas(c: HTMLCanvasElement, text: string, subText: string, color: string) {
  c.width = 512;
  c.height = 112;
  const g = c.getContext("2d");
  if (!g) return;
  g.clearRect(0, 0, c.width, c.height);
  g.fillStyle = "rgba(4, 11, 24, 0.82)";
  g.strokeStyle = color;
  g.lineWidth = 3;
  g.beginPath();
  g.roundRect(8, 8, 496, 96, 16);
  g.fill();
  g.stroke();
  g.font = "bold 28px sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillStyle = color;
  g.fillText(text.slice(0, 26), 256, subText ? 38 : 56);
  if (subText) {
    g.font = "22px monospace";
    g.fillStyle = "#e2e8f0";
    g.fillText(subText.slice(0, 36), 256, 76);
  }
}

function label(text: string, color: string, scale = 1.6): THREE.Sprite {
  const c = document.createElement("canvas");
  drawLabelCanvas(c, text, "", color);
  const t = new THREE.CanvasTexture(c);
  const m = new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false });
  const s = new THREE.Sprite(m);
  s.scale.set(4.2 * scale, 0.95 * scale, 1);
  return s;
}

function ellipsePoints(L: number, d: number, out: Float32Array, y: number) {
  const a = Math.max(d / 2 + 0.05, L / 2);
  const c = d / 2;
  const b = Math.sqrt(Math.max(0.0001, a * a - c * c));
  for (let i = 0; i < NPT; i++) {
    const th = (i / NPT) * Math.PI * 2;
    out[i * 3] = a * Math.cos(th);
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = b * Math.sin(th);
  }
}

function kindColorHex(kind: ObjectKind): { num: number; css: string } {
  switch (kind) {
    case "human_moving":
      return { num: 0xff6b2b, css: "#ff854d" };
    case "human_breathing":
      return { num: 0x10b981, css: "#34d399" };
    case "static_object":
      return { num: 0xfbbf24, css: "#fcd34d" };
    case "wifi_device":
      return { num: 0xe879f9, css: "#f0abfc" };
    case "router":
    default:
      return { num: 0x22d3ee, css: "#67e8f9" };
  }
}

export function objWorldPos(obj: DetectedObject, baselineM: number): [number, number, number] {
  if (obj.kind === "router") {
    return [baselineM / 2, 0, 0];
  }
  const rad = ((obj.angleDeg || 0) * Math.PI) / 180;
  const r = Math.max(0.6, Math.min(24, obj.rangeM || 2.0));
  const x = r * Math.sin(rad);
  const z = r * Math.cos(rad);
  return [x, 0, z];
}

const Radar3D = forwardRef<Radar3DHandle, Props>(function Radar3D({ stateRef, rowsRef, baselineM, opts, selectedObjId, onStatus }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const baseRef = useRef(baselineM);
  baseRef.current = baselineM;
  const selRef = useRef(selectedObjId);
  selRef.current = selectedObjId;
  const api = useRef<{ setBaseline: (d: number) => void; reset: () => void; focus: (obj: DetectedObject) => void } | null>(null);
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;

  useImperativeHandle(ref, () => ({
    resetView: () => api.current?.reset(),
    focusObject: (obj: DetectedObject) => api.current?.focus(obj),
  }));
  useEffect(() => {
    api.current?.setBaseline(baselineM);
  }, [baselineM]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    } catch (e) {
      statusRef.current({ gl: false, renderer: "", error: e instanceof Error ? e.message : String(e), fps: 0, pixelRatio: 0 });
      return;
    }
    let pr = Math.min(window.devicePixelRatio || 1, 1.5);
    renderer.setPixelRatio(pr);
    renderer.setClearColor(0x040a14, 1);
    el.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";
    let rname = "WebGL";
    try {
      const gl = renderer.getContext();
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      rname = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "WebGL";
    } catch {
      /* ignore */
    }

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x040a14, 42, 100);
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 300);
    const home = { pos: new THREE.Vector3(0, 16, 26), tgt: new THREE.Vector3(0, 0, -4) };
    camera.position.copy(home.pos);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(home.tgt);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.minDistance = 3;
    controls.maxDistance = 95;
    controls.autoRotateSpeed = 0.6;
    controls.update();

    scene.add(new THREE.AmbientLight(0x6a8cb0, 1.2));
    const sun = new THREE.DirectionalLight(0xbfe3ff, 1.7);
    sun.position.set(-10, 25, 12);
    scene.add(sun);

    const grid = new THREE.GridHelper(80, 80, 0x0f5578, 0x0a2a40);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.6;
    scene.add(grid);

    const staticGroup = new THREE.Group();
    scene.add(staticGroup);
    const nodeGroup = new THREE.Group();
    scene.add(nodeGroup);

    const buildStatic = (d: number) => {
      staticGroup.traverse((o) => {
        const m = o as THREE.Line;
        m.geometry?.dispose?.();
      });
      staticGroup.clear();
      nodeGroup.clear();
      for (let L = 6; L <= 30; L += 6) {
        if (L <= d + 0.2) continue;
        const arr = new Float32Array(NPT * 3);
        ellipsePoints(L, d, arr, 0.02);
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(arr, 3));
        const ln = new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color: 0x1b86b8, transparent: true, opacity: 0.35 }));
        staticGroup.add(ln);
        const lb = label(`L=${L}m`, "#6fd6ff", 0.95);
        lb.position.set(0, 0.3, Math.sqrt(Math.max(0.01, (L / 2) ** 2 - (d / 2) ** 2)));
        staticGroup.add(lb);
      }
      const mk = (x: number, col: number, name: string) => {
        const grp = new THREE.Group();
        const s = new THREE.Mesh(new THREE.SphereGeometry(0.45, 24, 16), new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.85 }));
        s.position.y = 0.5;
        const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 5.5, 8), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.35 }));
        beam.position.y = 2.8;
        const lb = label(name, "#" + col.toString(16).padStart(6, "0"), 1.15);
        lb.position.y = 6.1;
        grp.add(s, beam, lb);
        grp.position.x = x;
        return grp;
      };
      nodeGroup.add(mk(-d / 2, 0x38e8ff, "ESP32-S3 雷达主节点"), mk(d / 2, 0xff4fd8, "路由器基站 / 协同锚点"));
      const bl = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-d / 2, 0.5, 0), new THREE.Vector3(d / 2, 0.5, 0)]),
        new THREE.LineBasicMaterial({ color: 0x9be7ff, transparent: true, opacity: 0.75 }),
      );
      nodeGroup.add(bl);
      const dl = label(`参考基线 ${d.toFixed(1)}m`, "#cfefff", 0.9);
      dl.position.set(0, 1.35, 0.8);
      nodeGroup.add(dl);
    };
    buildStatic(baseRef.current);

    // 雷达扫描波纹环
    const sweepGeo = new THREE.RingGeometry(0.3, 0.55, 64);
    sweepGeo.rotateX(-Math.PI / 2);
    const sweepMat = new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false });
    const sweepRing = new THREE.Mesh(sweepGeo, sweepMat);
    sweepRing.position.set(-baseRef.current / 2, 0.04, 0);
    scene.add(sweepRing);

    // 动态路径长度椭圆
    const els: { line: THREE.LineLoop; arr: Float32Array; L: number; tL: number; op: number; tOp: number }[] = [];
    for (let i = 0; i < NEL; i++) {
      const arr = new Float32Array(NPT * 3);
      ellipsePoints(10, baseRef.current, arr, 0.06);
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(arr, 3));
      const line = new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0, depthWrite: false }));
      line.frustumCulled = false;
      scene.add(line);
      els.push({ line, arr, L: 10, tL: 10, op: 0, tOp: 0 });
    }

    // 活动粒子椭圆
    const actArr = new Float32Array(NPT * 3);
    ellipsePoints(10, baseRef.current, actArr, 0.1);
    const actGeo = new THREE.BufferGeometry();
    actGeo.setAttribute("position", new THREE.BufferAttribute(actArr, 3));
    const actMat = new THREE.PointsMaterial({ color: 0x3dff9a, size: 4, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
    const act = new THREE.Points(actGeo, actMat);
    act.frustumCulled = false;
    scene.add(act);
    const actState = { L: 10, tL: 10, op: 0, tOp: 0, motion: 0 };
    const actLabel = label("活动", "#7dffb8", 1.0);
    actLabel.visible = false;
    scene.add(actLabel);

    // ★ 3D 全息检测物体池（将检测到的任何物体实时渲染在 3D 空间）
    type ObjSlot = {
      group: THREE.Group;
      core: THREE.Mesh;
      wire: THREE.LineSegments;
      ring: THREE.Mesh;
      sprite: THREE.Sprite;
      canvas: HTMLCanvasElement;
      tex: THREE.CanvasTexture;
      lastKey: string;
      tx: number;
      tz: number;
      ty: number;
      op: number;
      tOp: number;
      scale: number;
      kind: ObjectKind;
    };
    const objPool: ObjSlot[] = [];
    const objGroup = new THREE.Group();
    scene.add(objGroup);

    const boxGeo = new THREE.BoxGeometry(1.1, 1.8, 1.1);
    const edgesGeo = new THREE.EdgesGeometry(boxGeo);
    const ringObjGeo = new THREE.RingGeometry(0.65, 0.85, 32);
    ringObjGeo.rotateX(-Math.PI / 2);

    for (let i = 0; i < MAX_OBJ3D; i++) {
      const grp = new THREE.Group();
      grp.visible = false;
      const coreMat = new THREE.MeshStandardMaterial({
        color: 0x38bdf8,
        emissive: 0x38bdf8,
        emissiveIntensity: 0.55,
        transparent: true,
        opacity: 0.45,
        roughness: 0.3,
      });
      const core = new THREE.Mesh(boxGeo, coreMat);
      core.position.y = 0.95;

      const wireMat = new THREE.LineBasicMaterial({ color: 0x7dd3fc, transparent: true, opacity: 0.9 });
      const wire = new THREE.LineSegments(edgesGeo, wireMat);
      wire.position.y = 0.95;

      const rMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false });
      const ring = new THREE.Mesh(ringObjGeo, rMat);
      ring.position.y = 0.05;

      const cv = document.createElement("canvas");
      drawLabelCanvas(cv, "目标", "", "#38bdf8");
      const tex = new THREE.CanvasTexture(cv);
      const spMat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
      const sp = new THREE.Sprite(spMat);
      sp.position.y = 2.6;
      sp.scale.set(4.8, 1.08, 1);

      grp.add(core, wire, ring, sp);
      objGroup.add(grp);
      objPool.push({
        group: grp,
        core,
        wire,
        ring,
        sprite: sp,
        canvas: cv,
        tex,
        lastKey: "",
        tx: 0,
        tz: 3,
        ty: 0,
        op: 0,
        tOp: 0,
        scale: 1,
        kind: "static_object",
      });
    }

    // 距离-时间地形
    const geo = new THREE.PlaneGeometry(TW, TD, COLS - 1, ROWS - 1);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const colA = new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3);
    geo.setAttribute("color", colA);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.65, metalness: 0.05, transparent: true, opacity: 0.94 });
    const terrain = new THREE.Mesh(geo, mat);
    const wire = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x66d8ff, wireframe: true, transparent: true, opacity: 0.07, depthWrite: false }));
    const tGroup = new THREE.Group();
    tGroup.add(terrain, wire);
    tGroup.position.set(0, 0, TZ);
    scene.add(tGroup);
    for (const L of [0, 10, 20, 30]) {
      const lb = label(`L=${L}m`, "#9fd8ff", 0.95);
      lb.position.set(L - TW / 2, 0.5, TZ + TD / 2 + 1.4);
      scene.add(lb);
    }
    const tl = label("路径长度 L = 多径反射总路径  →   时间 ↑（远处更早）", "#7fb4d6", 1.9);
    tl.position.set(0, 0.2, TZ + TD / 2 + 3.4);
    scene.add(tl);
    const tgt = new Float32Array(ROWS * COLS);
    const disp = new Float32Array(ROWS * COLS);
    let scroll = 0;
    const dz = TD / (ROWS - 1);
    const tmpC = new THREE.Color();

    const resize = () => {
      const w = el.clientWidth || 800;
      const h = el.clientHeight || 600;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = w + "px";
      renderer.domElement.style.height = h + "px";
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    api.current = {
      setBaseline: (d) => {
        buildStatic(d);
        sweepRing.position.x = -d / 2;
      },
      reset: () => {
        camera.position.copy(home.pos);
        controls.target.copy(home.tgt);
        controls.update();
      },
      focus: (obj: DetectedObject) => {
        const [ox, , oz] = objWorldPos(obj, baseRef.current);
        controls.target.set(ox, 0.8, oz);
        camera.position.set(ox + 4, 8, oz + 9);
        controls.update();
      },
    };

    let raf = 0;
    let frames = 0;
    let fps = 60;
    let lastFpsT = performance.now();
    let prevT = performance.now();
    let lowStreak = 0;
    statusRef.current({ gl: true, renderer: rname, error: "", fps: 60, pixelRatio: pr });

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(0.1, (now - prevT) / 1000);
      prevT = now;
      frames++;
      if (now - lastFpsT >= 600) {
        fps = (frames * 1000) / (now - lastFpsT);
        frames = 0;
        lastFpsT = now;
        if (fps < 28 && pr > 1) {
          lowStreak++;
          if (lowStreak >= 2) {
            pr = Math.max(0.85, +(pr - 0.25).toFixed(2));
            renderer.setPixelRatio(pr);
            resize();
            lowStreak = 0;
          }
        } else lowStreak = 0;
        statusRef.current({ gl: true, renderer: rname, error: "", fps, pixelRatio: pr });
      }

      const o = optsRef.current;
      controls.autoRotate = o.autoRotate;
      tGroup.visible = o.terrain;
      staticGroup.visible = o.ellipses;
      objGroup.visible = o.objects3d !== false;

      // 雷达扫描扩散波纹动画
      const pulse = ((now * 0.00065) % 1);
      const sRad = 0.5 + pulse * 22;
      sweepRing.scale.set(sRad, 1, sRad);
      sweepMat.opacity = (1 - pulse) * 0.42;

      const q = rowsRef.current;
      while (q.length) {
        const r = q.shift()!;
        tgt.copyWithin(COLS, 0, (ROWS - 1) * COLS);
        disp.copyWithin(COLS, 0, (ROWS - 1) * COLS);
        const p = r.p;
        for (let c = 0; c < COLS; c++) {
          const v = (p[Math.min(p.length - 1, Math.floor((c * p.length) / COLS))] || 0) / 255;
          tgt[c] = v;
          disp[c] = v * 0.65;
        }
        scroll = dz;
      }
      scroll *= Math.exp(-dt * 9);
      terrain.position.z = scroll;
      wire.position.z = scroll;

      if (o.terrain) {
        const k = 1 - Math.exp(-dt * 12);
        const carr = colA.array as Float32Array;
        const parr = pos.array as Float32Array;
        for (let i = 0; i < ROWS * COLS; i++) {
          const v = disp[i] + (tgt[i] - disp[i]) * k;
          disp[i] = v;
          parr[i * 3 + 1] = v * HMAX;
          colormap(v, tmpC);
          carr[i * 3] = tmpC.r;
          carr[i * 3 + 1] = tmpC.g;
          carr[i * 3 + 2] = tmpC.b;
        }
        pos.needsUpdate = true;
        colA.needsUpdate = true;
      }

      const st = stateRef.current;
      const d = baseRef.current;
      const L = st?.last;
      const pks = L ? (o.music && L.musicPeaks?.length ? L.musicPeaks : L.peaks) || [] : [];
      for (let i = 0; i < NEL; i++) {
        const e = els[i];
        const pk = o.ellipses ? pks[i] : undefined;
        if (pk && pk.r > d + 0.15) {
          e.tL = pk.r;
          e.tOp = Math.min(0.9, Math.max(0.2, (pk.db + 35) / 35));
        } else {
          e.tOp = 0;
        }
        e.L += (e.tL - e.L) * Math.min(1, dt * 8);
        e.op += (e.tOp - e.op) * Math.min(1, dt * 8);
        e.line.visible = e.op > 0.02;
        if (e.line.visible) {
          ellipsePoints(e.L, d, e.arr, 0.06 + i * 0.01);
          (e.line.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
          const m = e.line.material as THREE.LineBasicMaterial;
          m.opacity = e.op;
          m.color.setHex(o.music && L?.musicPeaks?.length ? 0xff4fd8 : 0xffb347);
        }
      }

      const s = L?.sense;
      if (o.ellipses && s && s.present && s.activeR && s.activeR > d + 0.15) {
        actState.tL = s.activeR;
        actState.tOp = 0.95;
        actState.motion = s.motion;
      } else {
        actState.tOp = 0;
      }
      actState.L += (actState.tL - actState.L) * Math.min(1, dt * 7);
      actState.op += (actState.tOp - actState.op) * Math.min(1, dt * 6);
      act.visible = actState.op > 0.03;
      actLabel.visible = act.visible;
      if (act.visible) {
        const breath = s?.breathBpm ? 0.12 * Math.sin((now / 1000) * ((s.breathBpm / 60) * Math.PI * 2)) : 0;
        ellipsePoints(actState.L + breath, d, actArr, 0.14);
        (actGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
        actMat.opacity = actState.op * (0.65 + 0.35 * Math.sin(now * 0.008));
        actMat.color.setHex(s?.level === "moving" ? 0xff7b3d : 0x3dff9a);
        const b = Math.sqrt(Math.max(0.01, (actState.L / 2) ** 2 - (d / 2) ** 2));
        actLabel.position.set(0, 1.1, b);
      }

      // ★ 渲染所有检测到的 3D 空间物体
      const rawObjs = L?.objects ?? [];
      const visObjs = rawObjs.filter((x) => x.kind !== "router").slice(0, MAX_OBJ3D);
      for (let i = 0; i < MAX_OBJ3D; i++) {
        const slot = objPool[i];
        const item = visObjs[i];
        if (item && o.objects3d !== false) {
          const [wx, , wz] = objWorldPos(item, d);
          slot.tx = wx;
          slot.tz = wz;
          slot.tOp = Math.max(0.35, Math.min(1.0, item.confidence));
          slot.kind = item.kind;
          const sc = item.rcs === "large" ? 1.25 : item.rcs === "small" ? 0.75 : 1.0;
          slot.scale = sc;
          const isSel = selRef.current === item.id;
          const sub = `R=${item.rangeM}m · L=${item.pathLenM}m · ${item.db}dB · 置信${Math.round(item.confidence * 100)}%`;
          const key = `${item.id}|${item.label}|${sub}|${isSel ? "1" : "0"}`;
          if (slot.lastKey !== key) {
            slot.lastKey = key;
            const kc = kindColorHex(item.kind);
            drawLabelCanvas(slot.canvas, (isSel ? "🎯 " : "") + item.label, sub, isSel ? "#ffffff" : kc.css);
            slot.tex.needsUpdate = true;
            (slot.core.material as THREE.MeshStandardMaterial).color.setHex(kc.num);
            (slot.core.material as THREE.MeshStandardMaterial).emissive.setHex(kc.num);
            (slot.wire.material as THREE.LineBasicMaterial).color.setHex(isSel ? 0xffffff : kc.num);
            (slot.ring.material as THREE.MeshBasicMaterial).color.setHex(kc.num);
          }
        } else {
          slot.tOp = 0;
        }

        slot.op += (slot.tOp - slot.op) * Math.min(1, dt * 8);
        slot.group.visible = slot.op > 0.03;
        if (slot.group.visible) {
          slot.group.position.x += (slot.tx - slot.group.position.x) * Math.min(1, dt * 7);
          slot.group.position.z += (slot.tz - slot.group.position.z) * Math.min(1, dt * 7);
          const bob = slot.kind === "human_moving" ? 0.12 * Math.abs(Math.sin(now * 0.008)) : slot.kind === "human_breathing" ? 0.05 * Math.sin(now * 0.003) : 0;
          slot.core.scale.set(slot.scale, slot.scale + bob, slot.scale);
          slot.wire.scale.set(slot.scale * 1.05, slot.scale * 1.05 + bob, slot.scale * 1.05);
          const rScale = slot.scale * (1 + 0.18 * Math.sin(now * 0.005 + i));
          slot.ring.scale.set(rScale, 1, rScale);
          (slot.core.material as THREE.MeshStandardMaterial).opacity = slot.op * 0.42;
          (slot.wire.material as THREE.LineBasicMaterial).opacity = slot.op * 0.95;
          (slot.ring.material as THREE.MeshBasicMaterial).opacity = slot.op * 0.7;
          (slot.sprite.material as THREE.SpriteMaterial).opacity = slot.op;
        }
      }

      controls.update();
      renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [rowsRef, stateRef]);

  return <div ref={host} className="h-full w-full select-none" />;
});

export default Radar3D;
