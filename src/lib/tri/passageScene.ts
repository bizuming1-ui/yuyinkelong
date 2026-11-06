// 「过路成像」渲染器：Three.js 2.5D 曲面（高度=后验强度）+ 尾迹层 + 静态物体层 + A→B/A→C 链路光束（脉冲随扰动变快）
// + 物体标记（核心球/光晕/落地圈/不确定度圈/速度箭头/轨迹）+ 底部时间轴 HUD（B/C 链路活动曲线）。
// 操作：左键旋转 · 右键平移 · 滚轮缩放 · 触屏双指缩放（OrbitControls，带阻尼）。渲染 60fps，高度每帧指数平滑 → 丝滑。
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { PG_N, type PassageEngine } from "./passage";

export interface PassageViewOpts {
  wake: boolean;
  stat: boolean;
  links: boolean;
  region: boolean;
  autoRotate: boolean;
}

function heat(h: number, out: number[], o = 0) {
  const t = Math.min(1, Math.max(0, h));
  const stops: [number, number, number, number][] = [
    [0.0, 0.08, 0.2, 0.7],
    [0.25, 0.0, 0.6, 0.95],
    [0.5, 0.1, 0.9, 0.5],
    [0.7, 0.98, 0.9, 0.15],
    [0.88, 1.0, 0.5, 0.08],
    [1.0, 1.0, 0.12, 0.1],
  ];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const a = stops[i - 1];
      const b = stops[i];
      const u = (t - a[0]) / (b[0] - a[0]);
      out[o] = a[1] + (b[1] - a[1]) * u;
      out[o + 1] = a[2] + (b[2] - a[2]) * u;
      out[o + 2] = a[3] + (b[3] - a[3]) * u;
      return;
    }
  }
  out[o] = 1;
  out[o + 1] = 0.12;
  out[o + 2] = 0.1;
}

function label(text: string, color = "#e6f6ff", w = 512, h = 128, font = 54) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  g.font = `bold ${font}px system-ui, "Microsoft YaHei", sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.lineWidth = 8;
  g.strokeStyle = "rgba(2,8,16,0.95)";
  g.strokeText(text, w / 2, h / 2);
  g.fillStyle = color;
  g.fillText(text, w / 2, h / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sp.renderOrder = 20;
  return sp;
}

class Layer {
  geo = new THREE.BufferGeometry();
  pos: Float32Array;
  col: Float32Array;
  disp = new Float32Array(PG_N * PG_N);
  mesh: THREE.Mesh;
  constructor(mat: THREE.Material) {
    const n = PG_N * PG_N;
    this.pos = new Float32Array(n * 3);
    this.col = new Float32Array(n * 4);
    const idx: number[] = [];
    for (let j = 0; j < PG_N - 1; j++)
      for (let i = 0; i < PG_N - 1; i++) {
        const a = j * PG_N + i;
        idx.push(a, a + PG_N, a + 1, a + 1, a + PG_N, a + PG_N + 1);
      }
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute("color", new THREE.BufferAttribute(this.col, 4));
    this.geo.setIndex(idx);
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
  }
}

export class PassageScene {
  fps = 0;
  opts: PassageViewOpts = { wake: true, stat: true, links: true, region: true, autoRotate: false };

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private raf = 0;
  private ro: ResizeObserver;
  private main: Layer;
  private wakeL: Layer;
  private statL: Layer;
  private regL: Layer;
  private staticGroup = new THREE.Group();
  private linkGroup = new THREE.Group();
  private links: { beam: THREE.Mesh; ribbon: THREE.Mesh; pulses: THREE.Mesh[]; from: THREE.Vector3; to: THREE.Vector3 }[] = [];
  private mk = new THREE.Group();
  private core: THREE.Mesh;
  private halo: THREE.Mesh;
  private pole: THREE.Mesh;
  private ring: THREE.Mesh;
  private ring2: THREE.Mesh;
  private arrow: THREE.ArrowHelper;
  private mkLabel: THREE.Sprite;
  private trail: THREE.Line;
  private trailPos = new Float32Array(80 * 3);
  private lastT = performance.now();
  private frame = 0;
  private fpsAcc = 0;
  private fpsN = 0;
  private hudCtx: CanvasRenderingContext2D | null;
  private sc = 1;
  private Hs = 1.6;
  private tmp = [0, 0, 0];
  private layoutKey = "";
  private disposed = false;

  constructor(
    private box: HTMLElement,
    private hud: HTMLCanvasElement | null,
    private eng: PassageEngine,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setClearColor(0x02060d, 1);
    box.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = "block";
    this.renderer.domElement.style.touchAction = "none";
    this.camera = new THREE.PerspectiveCamera(48, 1, 0.05, 200);
    this.scene.fog = new THREE.Fog(0x02060d, 14, 45);

    this.scene.add(new THREE.HemisphereLight(0xbfe4ff, 0x0a1220, 1.15));
    const dl = new THREE.DirectionalLight(0xffffff, 1.5);
    dl.position.set(3, 8, 4);
    this.scene.add(dl);

    const surfMat = new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide, emissive: 0x112233, emissiveIntensity: 0.55 });
    const wakeMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, side: THREE.DoubleSide, depthWrite: false });
    const statMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, side: THREE.DoubleSide, depthWrite: false });
    this.main = new Layer(surfMat);
    this.wakeL = new Layer(wakeMat);
    this.statL = new Layer(statMat);
    this.regL = new Layer(new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, side: THREE.DoubleSide, depthWrite: false }));
    this.regL.mesh.renderOrder = 1;
    this.wakeL.mesh.renderOrder = 2;
    this.statL.mesh.renderOrder = 3;
    this.main.mesh.renderOrder = 4;
    this.scene.add(this.regL.mesh, this.wakeL.mesh, this.statL.mesh, this.main.mesh);
    this.scene.add(this.staticGroup, this.linkGroup);

    // 物体标记
    this.core = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true }));
    this.halo = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshBasicMaterial({ color: 0x55e6ff, transparent: true, opacity: 0.22, depthWrite: false }));
    this.pole = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 8, 1, true), new THREE.MeshBasicMaterial({ color: 0xaef3ff, transparent: true, opacity: 0.5, depthWrite: false }));
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.94, 1, 64), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthTest: false }));
    this.ring2 = new THREE.Mesh(new THREE.RingGeometry(0.96, 1, 64), new THREE.MeshBasicMaterial({ color: 0x55e6ff, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthTest: false }));
    this.ring.rotation.x = this.ring2.rotation.x = -Math.PI / 2;
    this.ring.renderOrder = this.ring2.renderOrder = 15;
    this.arrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 1, 0xffd54a, 0.25, 0.14);
    this.mkLabel = label("物体（估计位置）", "#ffffff");
    this.mk.add(this.core, this.halo, this.pole, this.ring, this.ring2, this.arrow, this.mkLabel);
    this.mk.visible = false;
    this.scene.add(this.mk);

    const tg = new THREE.BufferGeometry();
    tg.setAttribute("position", new THREE.BufferAttribute(this.trailPos, 3));
    tg.setDrawRange(0, 0);
    this.trail = new THREE.Line(tg, new THREE.LineBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.85 }));
    this.trail.frustumCulled = false;
    this.scene.add(this.trail);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.rotateSpeed = 0.8;
    this.controls.zoomSpeed = 1.0;
    this.controls.panSpeed = 0.9;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 0.5;
    this.controls.maxDistance = 60;
    this.controls.maxPolarAngle = Math.PI * 0.499;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };

    this.hudCtx = hud ? hud.getContext("2d") : null;
    this.buildStatic();
    this.view("oblique");
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(box);
    this.resize();
    this.loop();
  }

  private resize() {
    const w = Math.max(2, this.box.clientWidth);
    const h = Math.max(2, this.box.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = w + "px";
    this.renderer.domElement.style.height = h + "px";
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.hud) {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const cw = this.hud.clientWidth || 440;
      const ch = this.hud.clientHeight || 130;
      if (this.hud.width !== Math.round(cw * dpr)) {
        this.hud.width = Math.round(cw * dpr);
        this.hud.height = Math.round(ch * dpr);
      }
    }
  }

  view(kind: "oblique" | "top" | "front" | "reset") {
    const M = Math.max(this.eng.W, this.eng.D);
    const t = this.controls.target;
    t.set(0, 0.3, 0);
    if (kind === "top") this.camera.position.set(0, M * 1.15, 0.001);
    else if (kind === "front") this.camera.position.set(0, M * 0.28, M * 0.95);
    else this.camera.position.set(M * 0.55, M * 0.62, M * 0.92);
    this.camera.lookAt(t);
    this.controls.update();
  }

  /** 布局（阵列边长 / 感知区）变化时重建静态物体 */
  rebuild() {
    this.buildStatic();
  }

  private clearGroup(g: THREE.Group) {
    for (const c of [...g.children]) {
      g.remove(c);
      c.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose?.();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else if (mat) {
          (mat as THREE.SpriteMaterial).map?.dispose?.();
          mat.dispose();
        }
      });
    }
  }

  private buildStatic() {
    const e = this.eng;
    const g = e.geom;
    const W = e.W;
    const D = e.D;
    this.sc = Math.max(0.5, Math.max(W, D) / 6);
    this.Hs = 1.7 * this.sc;
    this.layoutKey = `${g.side}|${W}|${D}`;
    this.clearGroup(this.staticGroup);
    this.clearGroup(this.linkGroup);
    this.links = [];

    // 地面网格 + 感知区边框
    const grid = new THREE.GridHelper(Math.max(W, D), Math.round(Math.max(W, D) * 2), 0x1d5f7a, 0x0f2d3c);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.55;
    grid.position.y = -0.002;
    this.staticGroup.add(grid);
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(W, this.Hs * 1.3, D)), new THREE.LineBasicMaterial({ color: 0x2aa6c8, transparent: true, opacity: 0.35 }));
    edge.position.y = (this.Hs * 1.3) / 2;
    this.staticGroup.add(edge);
    const mkTxt = (t: string, x: number, z: number, s = 1, c = "#7fd8ff") => {
      const sp = label(t, c);
      sp.scale.set(1.2 * s * this.sc, 0.3 * s * this.sc, 1);
      sp.position.set(x, 0.12 * this.sc, z);
      this.staticGroup.add(sp);
    };
    mkTxt("← B 侧", -W / 2 + 0.7 * this.sc, D / 2 + 0.25 * this.sc);
    mkTxt("C 侧 →", W / 2 - 0.7 * this.sc, D / 2 + 0.25 * this.sc);
    mkTxt("后方（A 一侧）", 0, -D / 2 - 0.25 * this.sc, 1, "#8aa7b8");
    mkTxt("前方", 0, D / 2 + 0.25 * this.sc, 1, "#8aa7b8");

    // 三块板
    const nsc = Math.min(0.4, Math.max(0.12, g.side * 0.3)) * Math.max(1, this.sc * 0.8);
    const nodes: [string, [number, number], number, string][] = [
      ["ESP32-1 (A) 发射", g.A, 0xffb02e, "#ffd28a"],
      ["ESP32-B 接收", g.B, 0x2ee6a6, "#9bffdc"],
      ["ESP32-C 接收", g.C, 0x4aa8ff, "#a9d4ff"],
    ];
    const pos3: THREE.Vector3[] = [];
    nodes.forEach(([name, p, color, tc], i) => {
      const grp = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(nsc, nsc * 0.18, nsc * 0.45), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.55, roughness: 0.4 }));
      body.position.y = nsc * 0.09;
      grp.add(body);
      if (i > 0) {
        const ant = new THREE.Mesh(new THREE.CylinderGeometry(nsc * 0.04, nsc * 0.07, nsc * 1.9, 8), new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.6 }));
        ant.position.set(i === 1 ? -nsc * 0.3 : nsc * 0.3, nsc * 1.0, 0);
        ant.rotation.z = i === 1 ? 0.35 : -0.35;
        grp.add(ant);
      }
      const lab = label(name, tc);
      const ls = Math.min(1, Math.max(0.4, g.side / 1.5));
      lab.scale.set(1.35 * this.sc * ls, 0.34 * this.sc * ls, 1);
      lab.position.set(0, nsc * 2.2 + 0.2 * this.sc * ls, 0);
      grp.add(lab);
      grp.position.set(p[0], 0.02, p[1]);
      this.staticGroup.add(grp);
      pos3.push(new THREE.Vector3(p[0], nsc * 0.25, p[1]));
    });

    // 链路光束 A→B、A→C
    for (const ri of [1, 2]) {
      const from = pos3[0];
      const to = pos3[ri];
      const len = from.distanceTo(to);
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 8, 1, true), new THREE.MeshBasicMaterial({ color: 0x2b6a8a, transparent: true, opacity: 0.7, depthWrite: false }));
      const mid = from.clone().add(to).multiplyScalar(0.5);
      beam.position.copy(mid);
      beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize());
      const ribbon = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0xffb02e, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
      ribbon.rotation.x = -Math.PI / 2;
      ribbon.position.set(mid.x, 0.01, mid.z);
      ribbon.rotation.z = -Math.atan2(to.z - from.z, to.x - from.x);
      const pulses: THREE.Mesh[] = [];
      for (let k = 0; k < 6; k++) {
        const p = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 8), new THREE.MeshBasicMaterial({ color: 0xbff4ff, transparent: true, opacity: 0.8, depthWrite: false }));
        pulses.push(p);
        this.linkGroup.add(p);
      }
      beam.scale.set(0.012 * this.sc, len, 0.012 * this.sc);
      ribbon.scale.set(len, 0.2, 1);
      this.linkGroup.add(beam, ribbon);
      this.links.push({ beam, ribbon, pulses, from, to });
    }
  }

  private fillLayer(L: Layer, field: Float32Array, dt: number, kind: "main" | "wake" | "stat" | "reg", hs: number) {
    const W = this.eng.W;
    const D = this.eng.D;
    const up = 1 - Math.exp(-dt / 0.05);
    const dn = 1 - Math.exp(-dt / 0.22);
    const c = this.tmp;
    for (let j = 0; j < PG_N; j++) {
      for (let i = 0; i < PG_N; i++) {
        const k = j * PG_N + i;
        const tgt = field[k];
        const d = L.disp[k];
        const v = d + (tgt - d) * (tgt > d ? up : dn);
        L.disp[k] = v < 0.002 ? 0 : v;
        const h = L.disp[k];
        const p = k * 3;
        L.pos[p] = -W / 2 + (W * i) / (PG_N - 1);
        L.pos[p + 1] = h * hs;
        L.pos[p + 2] = -D / 2 + (D * j) / (PG_N - 1);
        const q = k * 4;
        if (kind === "main") {
          heat(h, c);
          L.col[q] = c[0];
          L.col[q + 1] = c[1];
          L.col[q + 2] = c[2];
          L.col[q + 3] = Math.min(0.95, h * 4);
        } else if (kind === "reg") {
          L.col[q] = 0.55;
          L.col[q + 1] = 0.4;
          L.col[q + 2] = 1;
          L.col[q + 3] = Math.min(0.28, h * 1.1);
        } else if (kind === "wake") {
          L.col[q] = 0.1 + 0.3 * h;
          L.col[q + 1] = 0.55 + 0.4 * h;
          L.col[q + 2] = 0.95;
          L.col[q + 3] = Math.min(0.5, h * 2.4);
        } else {
          L.col[q] = 1;
          L.col[q + 1] = 0.7;
          L.col[q + 2] = 0.15;
          L.col[q + 3] = Math.min(0.6, h * 3);
        }
      }
    }
    (L.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (L.geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    L.geo.computeVertexNormals();
  }

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min(0.1, Math.max(0.001, (now - this.lastT) / 1000));
    this.lastT = now;
    this.fpsAcc += dt;
    this.fpsN++;
    if (this.fpsAcc >= 0.5) {
      this.fps = Math.round(this.fpsN / this.fpsAcc);
      this.fpsAcc = 0;
      this.fpsN = 0;
    }
    const e = this.eng;
    if (this.layoutKey !== `${e.geom.side}|${e.W}|${e.D}`) this.buildStatic();
    const t = now / 1000;

    this.fillLayer(this.main, e.blob, dt, "main", this.Hs);
    this.regL.mesh.visible = this.opts.region;
    if (this.opts.region) this.fillLayer(this.regL, e.cur, dt, "reg", this.Hs * 0.3);
    this.wakeL.mesh.visible = this.opts.wake;
    this.statL.mesh.visible = this.opts.stat;
    if (this.opts.wake) this.fillLayer(this.wakeL, e.wake, dt, "wake", this.Hs * 0.75);
    if (this.opts.stat) this.fillLayer(this.statL, e.stat, dt, "stat", this.Hs * 0.6);

    // 链路光束
    this.linkGroup.visible = this.opts.links;
    const acts = [e.okB ? e.aB : 0, e.okC ? e.aC : 0];
    this.links.forEach((l, i) => {
      const a = Math.min(1, acts[i] * 1.3);
      const bm = l.beam.material as THREE.MeshBasicMaterial;
      bm.color.setRGB(0.17 + 0.83 * a, 0.42 + 0.18 * a - 0.2 * a * a, 0.54 - 0.4 * a);
      bm.opacity = 0.45 + 0.5 * a;
      const r = (0.012 + 0.05 * a) * this.sc;
      l.beam.scale.x = r;
      l.beam.scale.z = r;
      const rm = l.ribbon.material as THREE.MeshBasicMaterial;
      rm.opacity = 0.42 * a;
      l.ribbon.scale.y = (0.15 + 0.5 * a) * this.sc;
      l.pulses.forEach((p, k) => {
        const u = (((t * (0.35 + 1.6 * a) + k / l.pulses.length) % 1) + 1) % 1;
        p.position.lerpVectors(l.from, l.to, u);
        p.scale.setScalar((0.018 + 0.03 * a) * this.sc);
        (p.material as THREE.MeshBasicMaterial).opacity = (e.okB || e.okC ? 0.25 : 0.05) + 0.75 * a;
      });
    });

    // 标记
    const m = e.marker;
    this.mk.visible = m.alpha > 0.01;
    if (this.mk.visible) {
      const sc = this.sc;
      const h = Math.max(m.h, 0.05) * this.Hs;
      this.mk.position.set(m.x, 0, m.z);
      this.core.position.y = h + 0.1 * sc;
      this.core.scale.setScalar((0.1 + 0.025 * Math.sin(t * 8)) * sc);
      (this.core.material as THREE.MeshBasicMaterial).opacity = m.alpha;
      this.halo.position.copy(this.core.position);
      this.halo.scale.setScalar((0.26 + 0.05 * Math.sin(t * 5)) * sc);
      (this.halo.material as THREE.MeshBasicMaterial).opacity = 0.22 * m.alpha;
      this.pole.position.y = (h + 0.1 * sc) / 2;
      this.pole.scale.set(0.012 * sc, h + 0.1 * sc, 0.012 * sc);
      (this.pole.material as THREE.MeshBasicMaterial).opacity = 0.5 * m.alpha;
      const rad = Math.max(0.25 * sc, Math.min(0.8 * sc, m.spread * 0.6));
      this.ring.position.y = this.ring2.position.y = 0.012;
      this.ring.scale.setScalar(rad);
      const pulse = (t * 0.9) % 1;
      this.ring2.scale.setScalar(rad * (0.35 + 0.65 * pulse));
      (this.ring2.material as THREE.MeshBasicMaterial).opacity = 0.6 * (1 - pulse) * m.alpha;
      (this.ring.material as THREE.MeshBasicMaterial).opacity = 0.45 * m.alpha;
      this.mkLabel.position.set(0, h + 0.45 * sc, 0);
      this.mkLabel.scale.set(1.3 * sc, 0.33 * sc, 1);
      (this.mkLabel.material as THREE.SpriteMaterial).opacity = m.alpha;
      const sp = Math.hypot(m.vx, m.vz);
      this.arrow.visible = sp > 0.25;
      if (this.arrow.visible) {
        const dir = new THREE.Vector3(m.vx, 0, m.vz).normalize();
        this.arrow.position.set(0, h + 0.1 * sc, 0);
        this.arrow.setDirection(dir);
        this.arrow.setLength(Math.min(1.8 * sc, 0.5 * sc + sp * 0.5 * sc), 0.28 * sc, 0.16 * sc);
      }
    }
    // 轨迹
    const tr = e.trail;
    const n = Math.min(80, tr.length);
    for (let i = 0; i < n; i++) {
      const q = tr[tr.length - n + i];
      this.trailPos[i * 3] = q.x;
      this.trailPos[i * 3 + 1] = 0.03 * this.sc + 0.2 * this.sc;
      this.trailPos[i * 3 + 2] = q.z;
    }
    this.trail.geometry.setDrawRange(0, e.marker.alpha > 0.05 ? n : 0);
    (this.trail.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;

    this.controls.autoRotate = this.opts.autoRotate;
    this.controls.autoRotateSpeed = 1.2;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    if (++this.frame % 3 === 0) this.drawHud(now);
  };

  private drawHud(now: number) {
    const cv = this.hud;
    const g = this.hudCtx;
    if (!cv || !g) return;
    const dpr = cv.width / Math.max(1, cv.clientWidth);
    const W = cv.clientWidth;
    const H = cv.clientHeight;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    g.fillStyle = "rgba(2,10,20,0.78)";
    g.fillRect(0, 0, W, H);
    g.strokeStyle = "rgba(60,140,180,0.5)";
    g.strokeRect(0.5, 0.5, W - 1, H - 1);
    const L = 8,
      R = 8,
      Tp = 22,
      B = 16;
    const pw = W - L - R;
    const ph = H - Tp - B;
    const span = 12000;
    g.font = "11px system-ui, 'Microsoft YaHei', sans-serif";
    g.fillStyle = "#9fdcff";
    g.fillText("链路扰动时间轴（最近 12 秒）", L, 14);
    g.fillStyle = "#2ee6a6";
    g.fillText("— A→B", W - 118, 14);
    g.fillStyle = "#ff7ad9";
    g.fillText("— A→C", W - 62, 14);
    const h = this.eng.hist;
    const X = (t: number) => L + pw * (1 - (now - t) / span);
    // 物体可见区间
    g.fillStyle = "rgba(255,224,138,0.14)";
    let s = -1;
    for (let i = 0; i < h.length; i++) {
      if (h[i].vis && s < 0) s = i;
      if ((!h[i].vis || i === h.length - 1) && s >= 0) {
        g.fillRect(X(h[s].t), Tp, Math.max(1, X(h[i].t) - X(h[s].t)), ph);
        s = -1;
      }
    }
    // 网格
    g.strokeStyle = "rgba(80,140,170,0.25)";
    g.lineWidth = 1;
    for (let k = 0; k <= 4; k++) {
      const y = Tp + (ph * k) / 4;
      g.beginPath();
      g.moveTo(L, y);
      g.lineTo(L + pw, y);
      g.stroke();
    }
    const plot = (key: "aB" | "aC", color: string) => {
      g.strokeStyle = color;
      g.lineWidth = 1.8;
      g.beginPath();
      let st = false;
      for (const p of h) {
        const x = X(p.t);
        if (x < L) continue;
        const y = Tp + ph * (1 - Math.min(1, p[key]));
        if (!st) {
          g.moveTo(x, y);
          st = true;
        } else g.lineTo(x, y);
      }
      g.stroke();
    };
    plot("aB", "#2ee6a6");
    plot("aC", "#ff7ad9");
    g.fillStyle = "#6c8aa0";
    g.fillText("-12s", L, H - 4);
    g.fillText("现在", W - R - 24, H - 4);
    g.fillStyle = "rgba(255,224,138,0.9)";
    g.fillText("黄色底 = 判定有物体", W / 2 - 40, H - 4);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.controls.dispose();
    this.clearGroup(this.staticGroup);
    this.clearGroup(this.linkGroup);
    for (const L of [this.main, this.wakeL, this.statL, this.regL]) {
      L.geo.dispose();
      (L.mesh.material as THREE.Material).dispose();
    }
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
