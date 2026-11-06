// Three.js 全息点云场景（纯 three，不经过 React 渲染，保证 60fps 丝滑）
//  - 房间：用户录入尺寸的虚线框 + 地面点阵（这是「标尺」，不是测量出来的墙）
//  - 三个节点 A/B/C 的真实相对位置 + 三角阵列 + 链路 A→B、A→C（亮度 = 该链路实时运动强度）
//  - 粒子云：粒子滤波后验采样（概率云）；亮度 ∝ 粒子权重；高度只是先验（不可观测）
//  - 地面占据概率「地形」、2σ 不确定度椭圆、轨迹
// 操作：左键旋转 / 右键平移 / 滚轮缩放 / 触屏双指缩放 —— OrbitControls（带阻尼，丝滑）
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Geometry } from "./geometry";
import type { ParticleFilter } from "./pf";
import type { Imager25D } from "./imager25d";

export interface SceneState {
  active: boolean; // 融合检测器判定有运动目标
  conf: number; // 检测置信度
  actB: number; // 链路 A→B 平滑运动分数
  actC: number;
  simulation: boolean;
  noData: boolean; // 真实模式下没有数据 → 画面压暗并提示
  conf25d?: number; // Imager25D 启发式置信度分数 0..1（低置信度时曲面变淡，不假装可靠）
}

export interface SceneOptions {
  cloud: boolean;
  terrain: boolean;
  trail: boolean;
  room: boolean;
  autoRotate: boolean;
  surface?: boolean; // 2.5D 后验曲面（高度 = 概率强度，不是真实高度）
  contour?: boolean; // 50% / 90% 可信区域等高线
  marker?: boolean; // MAP 峰值标记
}

const VERT = `
attribute float aSize; attribute float aAlpha; attribute vec3 aColor;
uniform float uScale; uniform float uAlpha;
varying float vA; varying vec3 vC;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = max(1.0, aSize * uScale / max(0.1, -mv.z));
  vA = aAlpha * uAlpha; vC = aColor;
}`;
const FRAG = `
varying float vA; varying vec3 vC;
void main(){
  vec2 p = gl_PointCoord - 0.5; float d = length(p);
  if (d > 0.5) discard;
  float a = smoothstep(0.5, 0.0, d);
  gl_FragColor = vec4(vC * (0.55 + 0.9 * a), vA * (0.15 + 0.85 * a * a));
}`;

interface PointSet {
  geo: THREE.BufferGeometry;
  mat: THREE.ShaderMaterial;
  pts: THREE.Points;
  pos: Float32Array;
  col: Float32Array;
  size: Float32Array;
  alpha: Float32Array;
}


// ---- 2.5D 后验曲面：高度场 = 概率强度（Imager25D.view），热力色 + 光照浮雕 + 50%/90% 可信区域等高线 ----
const SURF_COMMON = `
uniform sampler2D uTex; uniform float uN;
float hs(vec2 uv){
  vec2 e = vec2(0.5 / uN);
  return 0.25 * (texture2D(uTex, uv + vec2(e.x, e.y)).r + texture2D(uTex, uv + vec2(-e.x, e.y)).r
               + texture2D(uTex, uv + vec2(e.x, -e.y)).r + texture2D(uTex, uv + vec2(-e.x, -e.y)).r);
}`;
const SURF_VERT = SURF_COMMON + `
uniform float uH; varying vec2 vUv; varying float vV;
void main(){
  vUv = vec2(uv.x, 1.0 - uv.y);
  float v = hs(vUv);
  vV = v;
  vec3 p = position; p.y += pow(v, 0.85) * uH + 0.004;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
const SURF_FRAG = SURF_COMMON + `
uniform float uH; uniform float uAlpha; uniform vec2 uCell; uniform float uT50; uniform float uT90; uniform float uContour;
varying vec2 vUv; varying float vV;
vec3 ramp(float t){
  vec3 c0 = vec3(0.02, 0.06, 0.20); vec3 c1 = vec3(0.05, 0.45, 0.80); vec3 c2 = vec3(0.10, 0.85, 0.75);
  vec3 c3 = vec3(0.98, 0.85, 0.25); vec3 c4 = vec3(1.0, 0.35, 0.18);
  if (t < 0.25) return mix(c0, c1, t / 0.25);
  if (t < 0.50) return mix(c1, c2, (t - 0.25) / 0.25);
  if (t < 0.75) return mix(c2, c3, (t - 0.50) / 0.25);
  return mix(c3, c4, (t - 0.75) / 0.25);
}
float iso(float v, float t){ float w = fwidth(v) * 1.3 + 1e-4; return 1.0 - smoothstep(0.0, w, abs(v - t)); }
void main(){
  float v = vV;
  vec2 e = vec2(1.0 / uN);
  float dx = hs(vUv + vec2(e.x, 0.0)) - hs(vUv - vec2(e.x, 0.0));
  float dz = hs(vUv + vec2(0.0, e.y)) - hs(vUv - vec2(0.0, e.y));
  vec3 n = normalize(vec3(-dx * uH / (2.0 * uCell.x), 1.0, -dz * uH / (2.0 * uCell.y)));
  float diff = clamp(dot(n, normalize(vec3(0.4, 0.9, 0.3))), 0.0, 1.0);
  vec3 col = ramp(clamp(v * 1.05, 0.0, 1.0)) * (0.55 + 0.6 * diff);
  vec2 g = abs(fract(vUv * uN) - 0.5);
  float gl = smoothstep(0.46, 0.5, max(g.x, g.y));
  col += vec3(0.04, 0.10, 0.16) * gl * (0.3 + v);
  float l50 = iso(v, uT50) * uContour;
  float l90 = iso(v, uT90) * uContour;
  col = mix(col, vec3(1.0, 0.95, 0.55), l50 * 0.95);
  col = mix(col, vec3(0.65, 0.95, 1.0), l90 * 0.8);
  float a = smoothstep(0.012, 0.16, v) * 0.88 + max(l50, l90) * 0.7;
  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0) * uAlpha);
}`;

function makePointSet(n: number, uAlpha = 1): PointSet {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const size = new Float32Array(n);
  const alpha = new Float32Array(n);
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
  geo.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
  geo.setAttribute("aAlpha", new THREE.BufferAttribute(alpha, 1));
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uScale: { value: 600 }, uAlpha: { value: uAlpha } },
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  return { geo, mat, pts, pos, col, size, alpha };
}

function label(text: string, color: string, scale = 0.5) {
  const cv = document.createElement("canvas");
  cv.width = 256;
  cv.height = 96;
  const g = cv.getContext("2d")!;
  g.font = "bold 44px system-ui, 'Microsoft YaHei', sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.shadowColor = color;
  g.shadowBlur = 12;
  g.fillStyle = "#ffffff";
  g.fillText(text, 128, 48);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
  sp.scale.set(scale * 2.66, scale, 1);
  sp.renderOrder = 10;
  return sp;
}

export class TriScene {
  state: SceneState = { active: false, conf: 0, actB: 0, actC: 0, simulation: false, noData: true };
  opts: SceneOptions = { cloud: true, terrain: true, trail: true, room: true, autoRotate: false, surface: true, contour: true, marker: true };
  fps = 0;

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private raf = 0;
  private ro: ResizeObserver;
  private dead = false;
  private staticGroup = new THREE.Group();
  private roomGroup = new THREE.Group();
  private cloud: PointSet;
  private terrain: PointSet | null = null;
  private imager: Imager25D | null = null;
  private surf: THREE.Mesh | null = null;
  private surfTex: THREE.DataTexture | null = null;
  private surfBytes = new Uint8Array(0);
  private dv = new Float32Array(0); // 渲染端时间平滑后的高度场（60fps 丝滑）
  private mapMarker: THREE.Mesh;
  private mapX = 0;
  private mapZ = 0;
  private mapV = 0;
  private TN = 36;
  private occ = new Float32Array(36 * 36);
  private rp: Float32Array; // 渲染平滑后的粒子位置
  private rpInit = false;
  private presence = 0;
  private estX = 0;
  private estZ = 0;
  private ring: THREE.LineLoop;
  private pillar: THREE.Line;
  private trailLine: THREE.Line;
  private trailPos = new Float32Array(150 * 3);
  private trailCol = new Float32Array(150 * 3);
  private trail: [number, number][] = [];
  private lastTrailAt = 0;
  private linkLines: THREE.Line[] = [];
  private nodeMeshes: THREE.Mesh[] = [];
  private tri: THREE.Mesh | null = null;
  private lastT = performance.now();
  private fpsAcc = 0;
  private fpsN = 0;
  private lastOcc = 0;
  geom!: Geometry;
  private W = 6;
  private D = 6;
  private H = 2.6;

  constructor(
    private container: HTMLElement,
    private pf: ParticleFilter,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setClearColor(0x02060d, 1);
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = "block";
    this.renderer.domElement.style.touchAction = "none";
    this.scene.fog = new THREE.FogExp2(0x02060d, 0.035);
    this.camera = new THREE.PerspectiveCamera(48, 1, 0.05, 200);
    this.camera.position.set(4.6, 3.6, 6.4);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.rotateSpeed = 0.8;
    this.controls.zoomSpeed = 1.0;
    this.controls.panSpeed = 0.9;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 0.6;
    this.controls.maxDistance = 40;
    this.controls.maxPolarAngle = Math.PI * 0.499;
    this.controls.target.set(0, 0.7, 0);
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };

    this.scene.add(this.staticGroup, this.roomGroup);
    this.cloud = makePointSet(pf.N);
    this.rp = new Float32Array(pf.N * 3);
    this.scene.add(this.cloud.pts);

    const ringGeo = new THREE.BufferGeometry().setFromPoints(Array.from({ length: 64 }, (_, i) => new THREE.Vector3(Math.cos((i / 64) * Math.PI * 2), 0, Math.sin((i / 64) * Math.PI * 2))));
    this.ring = new THREE.LineLoop(ringGeo, new THREE.LineBasicMaterial({ color: 0x67e8f9, transparent: true, opacity: 0.6 }));
    this.scene.add(this.ring);
    this.pillar = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1.9, 0)]), new THREE.LineBasicMaterial({ color: 0xbae6fd, transparent: true, opacity: 0.5 }));
    this.scene.add(this.pillar);
    const tg = new THREE.BufferGeometry();
    tg.setAttribute("position", new THREE.BufferAttribute(this.trailPos, 3));
    tg.setAttribute("color", new THREE.BufferAttribute(this.trailCol, 3));
    tg.setDrawRange(0, 0);
    this.trailLine = new THREE.Line(tg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.trailLine.frustumCulled = false;
    this.scene.add(this.trailLine);
    this.mapMarker = new THREE.Mesh(new THREE.OctahedronGeometry(0.07), new THREE.MeshBasicMaterial({ color: 0xfff1a8, transparent: true, opacity: 0.95, depthTest: false }));
    this.mapMarker.renderOrder = 12;
    this.mapMarker.visible = false;
    this.scene.add(this.mapMarker);

    this.setLayout(pf.geom, pf.W, pf.D);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
    const loop = () => {
      if (this.dead) return;
      this.raf = requestAnimationFrame(loop);
      this.frame();
    };
    loop();
  }

  /** 接入 Imager25D：曲面/地形/MAP 标记都由它的后验网格驱动（粒子滤波只做跟踪与云可视化） */
  attachImager(im: Imager25D) {
    this.imager = im;
    this.buildSurface();
  }

  private buildSurface() {
    if (this.surf) {
      this.scene.remove(this.surf);
      this.surf.geometry.dispose();
      (this.surf.material as THREE.Material).dispose();
      this.surf = null;
    }
    this.surfTex?.dispose();
    this.surfTex = null;
    const im = this.imager;
    if (!im) return;
    const n = im.n;
    this.dv = new Float32Array(n * n);
    this.surfBytes = new Uint8Array(n * n);
    const tex = new THREE.DataTexture(this.surfBytes, n, n, THREE.RedFormat, THREE.UnsignedByteType);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this.surfTex = tex;
    const geo = new THREE.PlaneGeometry(this.W, this.D, 127, 127);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.ShaderMaterial({
      vertexShader: SURF_VERT,
      fragmentShader: SURF_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uTex: { value: tex },
        uN: { value: n },
        uH: { value: Math.min(1.8, Math.max(0.6, Math.min(this.W, this.D) * 0.28)) },
        uAlpha: { value: 0 },
        uCell: { value: new THREE.Vector2(this.W / n, this.D / n) },
        uT50: { value: 2 },
        uT90: { value: 2 },
        uContour: { value: 1 },
      },
    });
    this.surf = new THREE.Mesh(geo, mat);
    this.surf.frustumCulled = false;
    this.surf.renderOrder = 3;
    this.surf.visible = false;
    this.scene.add(this.surf);
  }

  resetView() {
    this.camera.position.set(this.W * 0.75, this.H * 1.4, this.D * 1.05);
    this.controls.target.set(0, 0.7, 0);
    this.controls.update();
  }

  topView() {
    this.camera.position.set(0.001, Math.max(this.W, this.D) * 1.6, 0.001);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  arrayCloseUpView() {
    const d = Math.max(1.2, this.geom.side * 3.2);
    this.camera.position.set(d * 0.8, this.geom.h + d * 0.75, d * 1.1);
    this.controls.target.set(0, this.geom.h * 0.8, 0);
    this.controls.update();
  }

  private resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const scale = (h * this.renderer.getPixelRatio()) / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    this.cloud.mat.uniforms.uScale.value = scale;
    this.terrain && (this.terrain.mat.uniforms.uScale.value = scale);
    this.staticGroup.traverse((o) => {
      const m = (o as THREE.Points).material as THREE.ShaderMaterial | undefined;
      if (m && m.uniforms && m.uniforms.uScale) m.uniforms.uScale.value = scale;
    });
    this.roomGroup.traverse((o) => {
      const m = (o as THREE.Points).material as THREE.ShaderMaterial | undefined;
      if (m && m.uniforms && m.uniforms.uScale) m.uniforms.uScale.value = scale;
    });
  }

  /** 重建房间 + 节点（尺寸/阵列边长改变时调用） */
  setLayout(g: Geometry, W: number, D: number) {
    this.geom = g;
    this.W = W;
    this.D = D;
    this.pf.geom = g;
    const dispose = (grp: THREE.Group) => {
      grp.traverse((o) => {
        const a = o as THREE.Mesh;
        a.geometry?.dispose?.();
        const m = a.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(m)) m.forEach((x) => x.dispose());
        else m?.dispose?.();
      });
      grp.clear();
    };
    dispose(this.staticGroup);
    dispose(this.roomGroup);
    this.linkLines = [];
    this.nodeMeshes = [];

    // ---- 房间点阵 ----
    const strong: number[] = [];
    const faint: number[] = [];
    const seg = (arr: number[], a: number[], b: number[], step: number) => {
      const L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      const n = Math.max(2, Math.round(L / step));
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        arr.push(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
      }
    };
    const x0 = -W / 2;
    const x1 = W / 2;
    const z0 = -D / 2;
    const z1 = D / 2;
    const H = this.H;
    // 12 条棱（强）
    const c = [
      [x0, 0, z0], [x1, 0, z0], [x1, 0, z1], [x0, 0, z1],
      [x0, H, z0], [x1, H, z0], [x1, H, z1], [x0, H, z1],
    ];
    const edges = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    for (const [a, b] of edges) seg(strong, c[a], c[b], 0.07);
    // 地面 0.5m 网格（弱）
    for (let x = Math.ceil(x0 / 0.5) * 0.5; x <= x1 + 1e-6; x += 0.5) seg(faint, [x, 0, z0], [x, 0, z1], 0.14);
    for (let z = Math.ceil(z0 / 0.5) * 0.5; z <= z1 + 1e-6; z += 0.5) seg(faint, [x0, 0, z], [x1, 0, z], 0.14);
    // 后墙与左墙 0.5m 网格（更弱）
    const wallPts: number[] = [];
    for (let x = Math.ceil(x0 / 0.5) * 0.5; x <= x1 + 1e-6; x += 0.5) seg(wallPts, [x, 0, z0], [x, H, z0], 0.2);
    for (let y = 0.5; y < H; y += 0.5) seg(wallPts, [x0, y, z0], [x1, y, z0], 0.2);
    for (let z = Math.ceil(z0 / 0.5) * 0.5; z <= z1 + 1e-6; z += 0.5) seg(wallPts, [x0, 0, z], [x0, H, z], 0.2);
    for (let y = 0.5; y < H; y += 0.5) seg(wallPts, [x0, y, z0], [x0, y, z1], 0.2);
    const fill = (arr: number[], size: number, alpha: number, r: number, gg: number, b: number) => {
      const n = arr.length / 3;
      const ps = makePointSet(n);
      ps.pos.set(arr);
      for (let i = 0; i < n; i++) {
        ps.col[i * 3] = r;
        ps.col[i * 3 + 1] = gg;
        ps.col[i * 3 + 2] = b;
        ps.size[i] = size;
        ps.alpha[i] = alpha;
      }
      this.roomGroup.add(ps.pts);
    };
    fill(strong, 0.028, 0.9, 0.25, 0.65, 1.0);
    fill(faint, 0.02, 0.38, 0.15, 0.45, 0.8);
    fill(wallPts, 0.016, 0.2, 0.12, 0.35, 0.7);

    // ---- 节点与阵列 ----
    const h = g.h;
    const P = (v: [number, number]) => new THREE.Vector3(v[0], h, v[1]);
    const nodeCfg: { v: [number, number]; color: number; css: string; name: string }[] = [
      { v: g.A, color: 0x2563eb, css: "#3b82f6", name: "ESP32-1(A) 发射" },
      { v: g.B, color: 0x0d9488, css: "#14b8a6", name: "ESP32-B 接收1" },
      { v: g.C, color: 0x0d9488, css: "#14b8a6", name: "ESP32-C 接收2" },
    ];
    const rad = Math.max(0.05, Math.min(0.12, g.side * 0.09));
    nodeCfg.forEach((n) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(rad, 24, 16), new THREE.MeshBasicMaterial({ color: n.color }));
      m.position.copy(P(n.v));
      this.staticGroup.add(m);
      this.nodeMeshes.push(m);
      const halo = new THREE.Mesh(new THREE.SphereGeometry(rad * 1.7, 20, 12), new THREE.MeshBasicMaterial({ color: n.color, transparent: true, opacity: 0.18, depthWrite: false, blending: THREE.AdditiveBlending }));
      halo.position.copy(m.position);
      this.staticGroup.add(halo);
      // 标签沿「质心 → 节点」方向向外错开，紧凑阵列时三个标签也不会叠在一起
      const dx = n.v[0] - (g.A[0] + g.B[0] + g.C[0]) / 3;
      const dz = n.v[1] - (g.A[1] + g.B[1] + g.C[1]) / 3;
      const dl = Math.hypot(dx, dz) || 1;
      const off = 0.16 + rad * 2.2;
      const lb = label(n.name, n.css, Math.max(0.16, Math.min(0.26, g.side * 0.3 + 0.12)));
      lb.position.copy(m.position).add(new THREE.Vector3((dx / dl) * off, rad * 1.5 + 0.1, (dz / dl) * off));
      this.staticGroup.add(lb);
      // 立柱到地面
      const pl = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(n.v[0], 0, n.v[1]), P(n.v)]), new THREE.LineBasicMaterial({ color: n.color, transparent: true, opacity: 0.35 }));
      this.staticGroup.add(pl);
    });
    // 三角形填充
    const tg = new THREE.BufferGeometry().setFromPoints([P(g.A), P(g.B), P(g.C)]);
    tg.setIndex([0, 1, 2, 0, 2, 1]);
    this.tri = new THREE.Mesh(tg, new THREE.MeshBasicMaterial({ color: 0x16a34a, transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false }));
    this.staticGroup.add(this.tri);
    const mkLink = (a: [number, number], b: [number, number], dashed: boolean) => {
      const geo = new THREE.BufferGeometry().setFromPoints([P(a), P(b)]);
      const mat = dashed
        ? new THREE.LineDashedMaterial({ color: 0x22c55e, dashSize: Math.max(0.03, g.side * 0.06), gapSize: Math.max(0.02, g.side * 0.04), transparent: true, opacity: 0.85 })
        : new THREE.LineBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.5 });
      const l = new THREE.Line(geo, mat);
      if (dashed) l.computeLineDistances();
      this.staticGroup.add(l);
      return l;
    };
    mkLink(g.B, g.C, true);
    this.linkLines.push(mkLink(g.A, g.B, true), mkLink(g.A, g.C, true));
    const cen = label("集中式阵列", "#22c55e", 0.2);
    cen.position.set(0, h + 0.02, 0);
    cen.material.opacity = 0.8;
    this.staticGroup.add(cen);

    // ---- 地形（占据概率） ----
    if (this.terrain) {
      this.scene.remove(this.terrain.pts);
      this.terrain.geo.dispose();
      this.terrain.mat.dispose();
    }
    const TN = this.TN;
    this.terrain = makePointSet(TN * TN);
    for (let j = 0; j < TN; j++)
      for (let i = 0; i < TN; i++) {
        const k = j * TN + i;
        this.terrain.pos[k * 3] = x0 + ((i + 0.5) / TN) * W;
        this.terrain.pos[k * 3 + 1] = 0.01;
        this.terrain.pos[k * 3 + 2] = z0 + ((j + 0.5) / TN) * D;
        this.terrain.col[k * 3] = 0.2;
        this.terrain.col[k * 3 + 1] = 0.65;
        this.terrain.col[k * 3 + 2] = 1;
        this.terrain.size[k] = Math.max(0.02, Math.min(W, D) / TN / 2.2);
      }
    this.scene.add(this.terrain.pts);
    this.buildSurface();
    this.rpInit = false;
    this.trail = [];
    this.resize();
    this.resetView();
  }

  private frame() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastT) / 1000);
    this.lastT = now;
    this.fpsAcc += dt;
    this.fpsN++;
    if (this.fpsAcc >= 0.5) {
      this.fps = Math.round(this.fpsN / this.fpsAcc);
      this.fpsAcc = 0;
      this.fpsN = 0;
    }
    const st = this.state;
    const o = this.opts;
    const pf = this.pf;
    this.controls.autoRotate = o.autoRotate;
    this.controls.autoRotateSpeed = 0.9;
    this.controls.update();

    // 淡入淡出：有目标 → 快速出现；无目标 → 缓慢淡出（不是动画造假：没有目标就不画云）
    const hasObj = !!(this.imager && this.imager.est && this.imager.est.available);
    const target = (st.active || hasObj) && !st.noData ? 1 : 0;
    this.presence += (target - this.presence) * (1 - Math.exp(-dt * (target > this.presence ? 7 : 1.4)));
    if (this.presence < 0.004) this.presence = 0;
    const dim = st.noData ? 0.35 : 1;
    this.roomGroup.visible = o.room;
    this.roomGroup.children.forEach((c) => ((c as THREE.Points).material as THREE.ShaderMaterial).uniforms.uAlpha && (((c as THREE.Points).material as THREE.ShaderMaterial).uniforms.uAlpha.value = dim));

    // 链路亮度
    const lk = [st.actB, st.actC];
    this.linkLines.forEach((l, i) => {
      const a = Math.min(1, lk[i] / 12);
      const m = l.material as THREE.LineDashedMaterial;
      m.opacity = 0.35 + 0.65 * a;
      m.color.setRGB(0.13 + 0.87 * a, 0.77 - 0.3 * a, 0.37 - 0.2 * a);
    });

    // ---- 粒子云 ----
    const N = pf.N;
    const c = this.cloud;
    c.pts.visible = o.cloud && this.presence > 0;
    c.mat.uniforms.uAlpha.value = this.presence;
    if (c.pts.visible) {
      const k = 1 - Math.exp(-dt * 14);
      const rp = this.rp;
      const vt = 0.05; // 速度外推 50ms（≈ 滤波步长 20Hz），让云在两次更新之间连续滑动
      for (let i = 0; i < N; i++) {
        const tx = pf.px[i] + pf.vx[i] * vt * 0.5;
        const tz = pf.pz[i] + pf.vz[i] * vt * 0.5;
        const ty = pf.hy[i];
        const j = i * 3;
        if (!this.rpInit) {
          rp[j] = tx;
          rp[j + 1] = ty;
          rp[j + 2] = tz;
        } else {
          rp[j] += (tx - rp[j]) * k;
          rp[j + 1] += (ty - rp[j + 1]) * k;
          rp[j + 2] += (tz - rp[j + 2]) * k;
        }
        c.pos[j] = rp[j];
        c.pos[j + 1] = rp[j + 1];
        c.pos[j + 2] = rp[j + 2];
        const w = Math.min(1, pf.w[i] * N * 0.35);
        const s = 0.35 + 0.65 * w;
        c.col[j] = 0.25 + 0.55 * s;
        c.col[j + 1] = 0.62 + 0.38 * s;
        c.col[j + 2] = 1.0;
        c.size[i] = 0.018 + 0.03 * s;
        c.alpha[i] = 0.12 + 0.88 * s;
      }
      this.rpInit = true;
      c.geo.attributes.position.needsUpdate = true;
      c.geo.attributes.aColor.needsUpdate = true;
      c.geo.attributes.aSize.needsUpdate = true;
      c.geo.attributes.aAlpha.needsUpdate = true;
    } else {
      this.rpInit = false;
    }

    // ---- 估计位置/椭圆/柱/轨迹 ----
    const e = pf.est;
    const ke = 1 - Math.exp(-dt * 8);
    if (this.presence > 0.02) {
      this.estX += (e.x - this.estX) * ke;
      this.estZ += (e.z - this.estZ) * ke;
    }
    const show = this.presence > 0.05 && o.cloud;
    this.ring.visible = show;
    this.pillar.visible = show;
    if (show) {
      this.ring.position.set(this.estX, 0.02, this.estZ);
      this.ring.scale.set(Math.max(0.12, 2 * e.sx), 1, Math.max(0.12, 2 * e.sz));
      (this.ring.material as THREE.LineBasicMaterial).opacity = 0.65 * this.presence;
      this.pillar.position.set(this.estX, 0, this.estZ);
      (this.pillar.material as THREE.LineBasicMaterial).opacity = 0.5 * this.presence;
    }
    // 轨迹
    if (show && now - this.lastTrailAt > 100) {
      this.lastTrailAt = now;
      this.trail.push([this.estX, this.estZ]);
      if (this.trail.length > 150) this.trail.shift();
    }
    if (!st.active && this.presence < 0.05 && this.trail.length) this.trail = [];
    this.trailLine.visible = o.trail && this.trail.length > 1;
    if (this.trailLine.visible) {
      const n = this.trail.length;
      for (let i = 0; i < n; i++) {
        this.trailPos[i * 3] = this.trail[i][0];
        this.trailPos[i * 3 + 1] = 0.03;
        this.trailPos[i * 3 + 2] = this.trail[i][1];
        const f = (i / n) * this.presence;
        this.trailCol[i * 3] = 0.2 * f;
        this.trailCol[i * 3 + 1] = 0.8 * f;
        this.trailCol[i * 3 + 2] = 1.0 * f;
      }
      this.trailLine.geometry.setDrawRange(0, n);
      this.trailLine.geometry.attributes.position.needsUpdate = true;
      this.trailLine.geometry.attributes.color.needsUpdate = true;
    }

    // ---- 2.5D 后验曲面（高度 = 概率强度）：每帧对 Imager25D.view 做指数平滑 → 60fps 丝滑 ----
    const im = this.imager;
    const est = im ? im.est : null;
    const S = this.surf;
    if (S && im && est && this.surfTex) {
      const showS = (o.surface ?? true) && this.presence > 0.01 && !st.noData;
      S.visible = showS;
      this.mapMarker.visible = false;
      if (showS) {
        const ks = 1 - Math.exp(-dt * 11);
        const src = est.available ? im.view : this.dv; // 不可用（无运动/单路过期）时不再被新数据驱动，保持上一帧并随 presence 淡出
        const dv = this.dv;
        const bytes = this.surfBytes;
        for (let k = 0; k < dv.length; k++) {
          dv[k] += (src[k] - dv[k]) * ks;
          bytes[k] = dv[k] * 255 + 0.5;
        }
        this.surfTex.needsUpdate = true;
        const u = (S.material as THREE.ShaderMaterial).uniforms;
        const conf = st.conf25d ?? est.conf25d;
        u.uAlpha.value = this.presence * (est.mode === "stale" ? 0.55 : 1) * (0.5 + 0.5 * Math.min(1, conf * 2.2));
        u.uT50.value = Math.min(1, (est.hpd50 * im.n * im.n) / im.densityRef);
        u.uT90.value = Math.min(1, (est.hpd90 * im.n * im.n) / im.densityRef);
        u.uContour.value = (o.contour ?? true) && est.available ? 1 : 0;
        // MAP 标记（平滑）
        if (est.available && (o.marker ?? true)) {
          const km = 1 - Math.exp(-dt * 9);
          this.mapX += (est.peakX - this.mapX) * km;
          this.mapZ += (est.peakZ - this.mapZ) * km;
          this.mapV += (Math.min(1, est.pmaxDensity / im.densityRef) - this.mapV) * km;
          const uh = u.uH.value as number;
          this.mapMarker.position.set(this.mapX, Math.pow(this.mapV, 0.85) * uh + 0.1, this.mapZ);
          this.mapMarker.rotation.y += dt * 1.6;
          (this.mapMarker.material as THREE.MeshBasicMaterial).opacity = 0.95 * this.presence;
          this.mapMarker.visible = true;
        }
      }
    }

    // ---- 地形点集（10Hz 更新；由 Imager25D.view 驱动，无 imager 时回退粒子占据）----
    const T = this.terrain;
    if (T) {
      T.pts.visible = o.terrain && this.presence > 0.02;
      T.mat.uniforms.uAlpha.value = this.presence;
      if (T.pts.visible && now - this.lastOcc > 100) {
        this.lastOcc = now;
        const TN = this.TN;
        if (im) {
          const n = im.n;
          const v = this.dv.length === n * n ? this.dv : im.view;
          for (let j = 0; j < TN; j++)
            for (let i = 0; i < TN; i++) {
              const gi = Math.min(n - 1, Math.floor(((i + 0.5) / TN) * n));
              const gj = Math.min(n - 1, Math.floor(((j + 0.5) / TN) * n));
              this.occ[j * TN + i] = v[gj * n + gi];
            }
        } else {
          pf.occupancy(TN, this.occ);
        }
        for (let k = 0; k < this.occ.length; k++) {
          const v = this.occ[k];
          const tgt = im ? Math.min(1, v * 1.4) : v * v;
          T.pos[k * 3 + 1] += (tgt * 0.55 + 0.01 - T.pos[k * 3 + 1]) * 0.5;
          T.alpha[k] = Math.min(1, tgt * 1.6);
          T.col[k * 3] = 0.2 + 0.5 * v;
          T.col[k * 3 + 1] = 0.6 + 0.4 * v;
        }
        T.geo.attributes.position.needsUpdate = true;
        T.geo.attributes.aAlpha.needsUpdate = true;
        T.geo.attributes.aColor.needsUpdate = true;
      }
    }
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.dead = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.controls.dispose();
    this.surfTex?.dispose();
    this.scene.traverse((o) => {
      const a = o as THREE.Mesh;
      a.geometry?.dispose?.();
      const m = a.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(m)) m.forEach((x) => x.dispose());
      else m?.dispose?.();
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
