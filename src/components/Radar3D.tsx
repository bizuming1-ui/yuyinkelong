"use client";
import { forwardRef, useEffect, useImperativeHandle, useRef, type MutableRefObject } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { RadarState, Row } from "@/lib/radar";

export type SceneOpts = { terrain: boolean; ellipses: boolean; autoRotate: boolean; music: boolean };
export type SceneStatus = { gl: boolean; renderer: string; error: string; fps: number; pixelRatio: number };
export type Radar3DHandle = { resetView: () => void };
type Props = {
  stateRef: MutableRefObject<RadarState | null>;
  rowsRef: MutableRefObject<Row[]>;
  baselineM: number;
  opts: SceneOpts;
  onStatus: (s: SceneStatus) => void;
};

const COLS = 128;
const ROWS = 72;
const TW = 30; // 地形宽度(米) = 路径长度 0..30m
const TD = 18; // 地形深度(米) = 时间
const TZ = -19; // 地形中心 z
const HMAX = 6;
const NEL = 7;
const NPT = 200;

function colormap(v: number, out: THREE.Color) {
  // 深蓝 → 青 → 黄绿 → 橙 → 红
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

function label(text: string, color: string, scale = 1.6): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 64;
  const g = c.getContext("2d");
  if (g) {
    g.font = "bold 30px sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = "rgba(4,10,20,0.55)";
    g.fillRect(8, 8, 240, 48);
    g.fillStyle = color;
    g.fillText(text, 128, 34);
  }
  const t = new THREE.CanvasTexture(c);
  const m = new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false });
  const s = new THREE.Sprite(m);
  s.scale.set(4 * scale, 1 * scale, 1);
  return s;
}

function ellipsePoints(L: number, d: number, out: Float32Array, y: number) {
  const a = L / 2;
  const c = d / 2;
  const b = Math.sqrt(Math.max(0.0001, a * a - c * c));
  for (let i = 0; i < NPT; i++) {
    const th = (i / NPT) * Math.PI * 2;
    out[i * 3] = a * Math.cos(th);
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = b * Math.sin(th);
  }
}

const Radar3D = forwardRef<Radar3DHandle, Props>(function Radar3D({ stateRef, rowsRef, baselineM, opts, onStatus }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const baseRef = useRef(baselineM);
  baseRef.current = baselineM;
  const api = useRef<{ setBaseline: (d: number) => void; reset: () => void } | null>(null);
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;

  useImperativeHandle(ref, () => ({ resetView: () => api.current?.reset() }));
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
    scene.fog = new THREE.Fog(0x040a14, 40, 95);
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 300);
    const home = { pos: new THREE.Vector3(0, 17, 30), tgt: new THREE.Vector3(0, 0, -9) };
    camera.position.copy(home.pos);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(home.tgt);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.minDistance = 4;
    controls.maxDistance = 90;
    controls.autoRotateSpeed = 0.6;
    controls.update();

    scene.add(new THREE.AmbientLight(0x6a8cb0, 1.1));
    const sun = new THREE.DirectionalLight(0xbfe3ff, 1.6);
    sun.position.set(-10, 25, 12);
    scene.add(sun);

    // 地面
    const grid = new THREE.GridHelper(80, 80, 0x0f5578, 0x0a2a40);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.6;
    scene.add(grid);

    // 静态距离椭圆（路径长度 L 相同的点：到 A 与 B 的距离之和 = L）
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
        const ln = new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color: 0x1b86b8, transparent: true, opacity: 0.4 }));
        staticGroup.add(ln);
        const lb = label(`L=${L}m`, "#6fd6ff", 1.1);
        lb.position.set(0, 0.3, Math.sqrt((L / 2) ** 2 - (d / 2) ** 2));
        staticGroup.add(lb);
      }
      // 节点 A / B
      const mk = (x: number, col: number, name: string) => {
        const grp = new THREE.Group();
        const s = new THREE.Mesh(new THREE.SphereGeometry(0.45, 24, 16), new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.8 }));
        s.position.y = 0.5;
        const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 6, 8), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.35 }));
        beam.position.y = 3;
        const lb = label(name, "#" + col.toString(16).padStart(6, "0"), 1.3);
        lb.position.y = 6.6;
        grp.add(s, beam, lb);
        grp.position.x = x;
        return grp;
      };
      nodeGroup.add(mk(-d / 2, 0x38e8ff, "Node A 发起端"), mk(d / 2, 0xff4fd8, "Node B 响应端"));
      const bl = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-d / 2, 0.5, 0), new THREE.Vector3(d / 2, 0.5, 0)]),
        new THREE.LineBasicMaterial({ color: 0x9be7ff, transparent: true, opacity: 0.7 }),
      );
      nodeGroup.add(bl);
      const dl = label(`基线 ${d.toFixed(1)}m`, "#cfefff", 1.0);
      dl.position.set(0, 1.4, 0.8);
      nodeGroup.add(dl);
    };
    buildStatic(baseRef.current);

    // 动态椭圆（检测到的路径长度峰）
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
    // 活动椭圆（粒子，随运动强度脉动）
    const actArr = new Float32Array(NPT * 3);
    ellipsePoints(10, baseRef.current, actArr, 0.1);
    const actGeo = new THREE.BufferGeometry();
    actGeo.setAttribute("position", new THREE.BufferAttribute(actArr, 3));
    const actMat = new THREE.PointsMaterial({ color: 0x3dff9a, size: 4, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
    const act = new THREE.Points(actGeo, actMat);
    act.frustumCulled = false;
    scene.add(act);
    const actState = { L: 10, tL: 10, op: 0, tOp: 0, motion: 0 };
    const actLabel = label("活动", "#7dffb8", 1.1);
    actLabel.visible = false;
    scene.add(actLabel);

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
      const lb = label(`L=${L}m`, "#9fd8ff", 1.0);
      lb.position.set(L - TW / 2, 0.5, TZ + TD / 2 + 1.4);
      scene.add(lb);
    }
    const tl = label("路径长度 L = 到A与到B距离之和  →   时间 ↑（远处更早）", "#7fb4d6", 2.2);
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
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    api.current = {
      setBaseline: (d: number) => {
        buildStatic(d);
        for (const e of els) ellipsePoints(e.L, d, e.arr, 0.06);
      },
      reset: () => {
        camera.position.copy(home.pos);
        controls.target.copy(home.tgt);
        controls.update();
      },
    };

    let raf = 0;
    let last = performance.now();
    let acc = 0;
    let nF = 0;
    let slow = 0;
    let reportAt = 0;
    let fps = 60;
    let lastSeq = -1;
    const clock = new THREE.Clock();
    statusRef.current({ gl: true, renderer: rname, error: "", fps: 60, pixelRatio: pr });

    const frame = () => {
      raf = requestAnimationFrame(frame); // 先排下一帧：即使下面抛异常也不会让画面冻结
      try {
        const now = performance.now();
        const dtm = Math.min(0.1, (now - last) / 1000);
        last = now;
        acc += dtm;
        nF++;
        if (acc >= 0.5) {
          fps = nF / acc;
          acc = 0;
          nF = 0;
          if (fps < 22) slow += 0.5;
          else slow = 0;
          if (slow >= 3 && pr > 0.75) {
            pr = Math.max(0.75, pr - 0.25);
            renderer.setPixelRatio(pr);
            resize();
            slow = 0;
          }
          if (now - reportAt > 900) {
            reportAt = now;
            statusRef.current({ gl: true, renderer: rname, error: "", fps, pixelRatio: pr });
          }
        }
        const o = optsRef.current;
        controls.autoRotate = o.autoRotate;
        controls.update();
        const t = clock.getElapsedTime();
        const d = baseRef.current;

        // 新到的行：滚动地形
        const q = rowsRef.current;
        if (q.length) {
          const take = q.splice(0, Math.min(q.length, 6));
          for (const r of take) {
            tgt.copyWithin(0, COLS);
            for (let j = 0; j < COLS; j++) {
              const u = (r.p[j] ?? 0) / 255;
              tgt[(ROWS - 1) * COLS + j] = Math.pow(u, 2.4) * HMAX;
            }
            scroll = Math.min(2.5, scroll + 1);
          }
        }
        scroll *= Math.exp(-dtm * 5);
        tGroup.position.z = TZ + scroll * dz;
        tGroup.visible = o.terrain;
        if (o.terrain) {
          const k = 1 - Math.exp(-dtm * 9);
          for (let i = 0; i < tgt.length; i++) {
            const v = disp[i] + (tgt[i] - disp[i]) * k;
            disp[i] = v;
            pos.setY(i, v);
            colormap(v / HMAX, tmpC);
            colA.setXYZ(i, tmpC.r, tmpC.g, tmpC.b);
          }
          pos.needsUpdate = true;
          colA.needsUpdate = true;
          if (Math.floor(t * 4) !== Math.floor((t - dtm) * 4)) geo.computeVertexNormals();
        }

        // 峰值椭圆
        const st = stateRef.current;
        const L = st?.last;
        if (L && st.seq !== lastSeq) {
          lastSeq = st.seq;
          const pk = (o.music && L.musicPeaks && L.musicPeaks.length ? L.musicPeaks : L.peaks).filter((p) => p.r > d + 0.15).slice(0, NEL);
          els.forEach((e, i) => {
            const p = pk[i];
            if (p) {
              e.tL = Math.max(d + 0.3, p.r);
              e.tOp = Math.min(0.95, Math.max(0.15, 1 + p.db / 30));
            } else e.tOp = 0;
          });
          const s = L.sense;
          if (s.present && s.activeR && s.activeR > d + 0.15) {
            actState.tL = s.activeR;
            actState.tOp = 0.55 + 0.4 * s.motion;
            actState.motion = s.motion;
          } else actState.tOp = 0;
        } else if (!L) {
          els.forEach((e) => (e.tOp = 0));
          actState.tOp = 0;
        }
        const ke = 1 - Math.exp(-dtm * 6);
        for (const e of els) {
          e.L += (e.tL - e.L) * ke;
          e.op += (e.tOp - e.op) * ke;
          const vis = o.ellipses && e.op > 0.02;
          e.line.visible = vis;
          if (vis) {
            ellipsePoints(e.L, d, e.arr, 0.06);
            (e.line.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
            (e.line.material as THREE.LineBasicMaterial).opacity = e.op;
          }
        }
        actState.L += (actState.tL - actState.L) * ke;
        actState.op += (actState.tOp - actState.op) * ke;
        const avis = o.ellipses && actState.op > 0.02;
        act.visible = avis;
        actLabel.visible = avis;
        if (avis) {
          ellipsePoints(Math.max(d + 0.3, actState.L), d, actArr, 0.12);
          (actGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
          const pulse = 0.75 + 0.25 * Math.sin(t * (3 + actState.motion * 9));
          actMat.opacity = Math.min(0.85, actState.op * pulse * 0.7);
          actMat.size = 3 + actState.motion * 2.5;
          actMat.color.setHSL(0.4 - 0.4 * actState.motion, 1, 0.6);
          const a = actState.L / 2;
          const b = Math.sqrt(Math.max(0.0001, a * a - (d / 2) ** 2));
          actLabel.position.set(0, 1.2, b);
          actLabel.scale.set(4.4, 1.1, 1);
        }
        renderer.render(scene, camera);
      } catch (e) {
        statusRef.current({ gl: true, renderer: rname, error: "渲染循环异常：" + (e instanceof Error ? e.message : String(e)), fps, pixelRatio: pr });
      }
    };
    raf = requestAnimationFrame(frame);

    const onLost = (ev: Event) => {
      ev.preventDefault();
      statusRef.current({ gl: false, renderer: rname, error: "WebGL 上下文丢失（显卡驱动/标签页过多），刷新页面即可", fps: 0, pixelRatio: pr });
    };
    renderer.domElement.addEventListener("webglcontextlost", onLost);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener("webglcontextlost", onLost);
      controls.dispose();
      scene.traverse((ob) => {
        const m = ob as THREE.Mesh;
        m.geometry?.dispose?.();
        const mt = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mt)) mt.forEach((x) => x.dispose());
        else mt?.dispose?.();
      });
      renderer.dispose();
      renderer.domElement.remove();
      api.current = null;
    };
  }, [stateRef, rowsRef]);

  return <div ref={host} className="absolute inset-0 overflow-hidden" />;
});

export default Radar3D;
