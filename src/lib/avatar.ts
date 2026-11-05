// 参数化人体线框网格（风格参考 DensePose：蓝→青→黄 的分部位渐变 + 网格线）。
// 全部用代码生成，不依赖任何模型文件；关节层级支持步态动画（走路/静止呼吸）。
import * as THREE from "three";

const STOPS: [number, number, number, number][] = [
  [0, 0.1, 0.12, 0.62],
  [0.28, 0.08, 0.42, 0.95],
  [0.52, 0.1, 0.86, 0.82],
  [0.76, 0.62, 0.92, 0.25],
  [1, 1.0, 0.92, 0.12],
];
export function cmap(v: number, out: THREE.Color) {
  v = Math.max(0, Math.min(1, v));
  for (let i = 1; i < STOPS.length; i++) {
    if (v <= STOPS[i][0]) {
      const a = STOPS[i - 1];
      const b = STOPS[i];
      const t = (v - a[0]) / (b[0] - a[0]);
      return out.setRGB(a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t);
    }
  }
  return out.setRGB(1, 0.92, 0.12);
}

interface PartOpts {
  rx: number;
  rz: number;
  len: number; // 沿 -y 方向的长度（以枢轴为起点向下）
  base: number; // 部位的颜色基准 0..1
  spread?: number; // 渐变幅度
  rings?: number;
  around?: number;
  taper?: [number, number]; // 上/下端半径系数
  center?: boolean; // true：以枢轴为中心（头、躯干）
  p?: number; // 端部圆润程度
}

const tmpC = new THREE.Color();

function makePart(o: PartOpts, mats: { line: THREE.LineBasicMaterial; fill: THREE.MeshBasicMaterial }) {
  const rings = o.rings ?? 9;
  const around = o.around ?? 14;
  const p = o.p ?? 2.2;
  const pos: number[] = [];
  const col: number[] = [];
  const idxRing = (r: number, a: number) => r * around + (a % around);
  for (let r = 0; r <= rings; r++) {
    const v = r / rings;
    const e = 2 * v - 1;
    const shape = Math.pow(Math.max(0, 1 - Math.pow(Math.abs(e), p)), 1 / p);
    const t = o.taper ?? [1, 1];
    const k = (t[0] + (t[1] - t[0]) * v) * Math.max(0.08, shape);
    const y = o.center ? o.len / 2 - v * o.len : -v * o.len;
    for (let a = 0; a < around; a++) {
      const ang = (a / around) * Math.PI * 2;
      const x = Math.cos(ang) * o.rx * k;
      const z = Math.sin(ang) * o.rz * k;
      pos.push(x, y, z);
      // 颜色：部位基准 + 沿长度渐变 + 绕向微小变化（类似 U/V 坐标）
      cmap(o.base + (o.spread ?? 0.22) * (0.5 - v) + 0.06 * Math.sin(ang * 2), tmpC);
      col.push(tmpC.r, tmpC.g, tmpC.b);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  const tri: number[] = [];
  const seg: number[] = [];
  for (let r = 0; r < rings; r++)
    for (let a = 0; a < around; a++) {
      const a0 = idxRing(r, a);
      const a1 = idxRing(r, a + 1);
      const b0 = idxRing(r + 1, a);
      const b1 = idxRing(r + 1, a + 1);
      tri.push(a0, b0, a1, a1, b0, b1);
      seg.push(a0, a1); // 环线
      seg.push(a0, b0); // 经线
    }
  for (let a = 0; a < around; a++) seg.push(idxRing(rings, a), idxRing(rings, a + 1));
  const fillGeo = geo.clone();
  fillGeo.setIndex(tri);
  const lineGeo = geo;
  lineGeo.setIndex(seg);
  const g = new THREE.Group();
  g.add(new THREE.LineSegments(lineGeo, mats.line));
  g.add(new THREE.Mesh(fillGeo, mats.fill));
  return g;
}

export interface Avatar {
  root: THREE.Group; // 位置 / 朝向
  body: THREE.Group; // 上下起伏
  setOpacity(o: number): void;
  animate(phase: number, amp: number, breath: number, glow: number): void;
  dispose(): void;
}

export function createAvatar(): Avatar {
  const line = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 1, depthWrite: false });
  const fill = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.26, side: THREE.DoubleSide, depthWrite: false });
  const mats = { line, fill };
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const add = (parent: THREE.Object3D, o: PartOpts, x = 0, y = 0, z = 0) => {
    const g = makePart(o, mats);
    g.position.set(x, y, z);
    parent.add(g);
    return g;
  };
  const pivot = (parent: THREE.Object3D, x: number, y: number, z = 0) => {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    parent.add(g);
    return g;
  };

  // 躯干 / 骨盆 / 头
  const torso = pivot(body, 0, 1.24);
  add(torso, { rx: 0.19, rz: 0.1, len: 0.62, base: 0.3, spread: 0.3, rings: 12, around: 18, center: true, p: 2.6, taper: [1.12, 0.82] });
  const pelvis = pivot(body, 0, 0.95);
  add(pelvis, { rx: 0.17, rz: 0.1, len: 0.2, base: 0.45, spread: 0.2, rings: 5, around: 16, center: true, p: 2.4 });
  const head = pivot(body, 0, 1.66);
  add(head, { rx: 0.085, rz: 0.095, len: 0.24, base: 0.97, spread: 0.1, rings: 10, around: 16, center: true, p: 2 });
  // 眼睛方向标记（让人能看出朝向）
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.02, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  nose.position.set(0, 1.66, 0.1);
  body.add(nose);

  // 手臂
  const mkArm = (side: number) => {
    const sh = pivot(body, side * 0.235, 1.47);
    add(sh, { rx: 0.05, rz: 0.05, len: 0.3, base: 0.7, spread: 0.2, rings: 6, around: 10, taper: [1.1, 0.9] });
    const el = pivot(sh, 0, -0.3);
    add(el, { rx: 0.04, rz: 0.04, len: 0.27, base: 0.88, spread: 0.18, rings: 6, around: 10, taper: [1, 0.75] });
    return { sh, el };
  };
  const armL = mkArm(-1);
  const armR = mkArm(1);

  // 腿
  const mkLeg = (side: number) => {
    const hip = pivot(body, side * 0.095, 0.93);
    add(hip, { rx: 0.075, rz: 0.075, len: 0.45, base: 0.56, spread: 0.24, rings: 8, around: 12, taper: [1.1, 0.85] });
    const kn = pivot(hip, 0, -0.45);
    add(kn, { rx: 0.055, rz: 0.055, len: 0.43, base: 0.4, spread: 0.2, rings: 8, around: 12, taper: [0.95, 0.7] });
    const foot = pivot(kn, 0, -0.43);
    add(foot, { rx: 0.05, rz: 0.11, len: 0.07, base: 0.2, spread: 0.1, rings: 3, around: 10, center: true, p: 2 }, 0, -0.02, 0.05);
    return { hip, kn };
  };
  const legL = mkLeg(-1);
  const legR = mkLeg(1);

  const apply = (phase: number, amp: number, breath: number, glow: number) => {
    const s = Math.sin(phase);
    const c = Math.cos(phase);
    const A = 0.62 * amp;
    legL.hip.rotation.x = A * s;
    legR.hip.rotation.x = -A * s;
    legL.kn.rotation.x = Math.max(0, -Math.sin(phase - 0.9)) * 0.9 * amp;
    legR.kn.rotation.x = Math.max(0, Math.sin(phase - 0.9)) * 0.9 * amp;
    armL.sh.rotation.x = -0.55 * amp * s;
    armR.sh.rotation.x = 0.55 * amp * s;
    armL.el.rotation.x = -0.25 - 0.45 * amp * Math.max(0, s);
    armR.el.rotation.x = -0.25 - 0.45 * amp * Math.max(0, -s);
    armL.sh.rotation.z = 0.06 + 0.02 * breath;
    armR.sh.rotation.z = -0.06 - 0.02 * breath;
    body.position.y = 0.035 * amp * Math.abs(c) + 0.006 * breath;
    torso.rotation.y = 0.12 * amp * s;
    torso.rotation.x = 0.06 * amp + 0.01 * breath;
    head.rotation.y = -0.1 * amp * s;
    const sc = 1 + 0.006 * breath + 0.01 * glow;
    body.scale.set(sc, 1 + 0.004 * breath, sc);
  };
  apply(0, 0, 0, 0);

  return {
    root,
    body,
    setOpacity(o: number) {
      line.opacity = Math.max(0, Math.min(1, o));
      fill.opacity = 0.26 * Math.max(0, Math.min(1, o));
      root.visible = o > 0.01;
    },
    animate: apply,
    dispose() {
      root.traverse((c) => {
        const m = c as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
      });
      line.dispose();
      fill.dispose();
    },
  };
}
