// 三角阵列几何（图中：A 在上方，B 左下，C 右下，正三角形，质心在原点）
// 坐标系：x 向右，z 向「屏幕下方」（俯视图的 +z），y 向上；节点高度 h。
export interface Geometry {
  A: [number, number];
  B: [number, number];
  C: [number, number];
  side: number; // 边长（米），按天线辐射单元中心测量
  h: number; // 天线离地高度
}

export function makeGeometry(side: number, h = 1.0): Geometry {
  const R = side / Math.sqrt(3);
  return { A: [0, -R], B: [-side / 2, R / 2], C: [side / 2, R / 2], side, h };
}

/** 双基地路径长度  L_i(p)=|p−t|+|p−r_i|  （提示词 7.1） */
export function pathLength(g: Geometry, rx: "B" | "C", x: number, z: number) {
  const r = rx === "B" ? g.B : g.C;
  return Math.hypot(x - g.A[0], z - g.A[1]) + Math.hypot(x - r[0], z - r[1]);
}
