// ESP32 -> MQTT 二进制帧协议（与 firmware/main.cpp 的 CsiRec / 批包头完全对应）
//   批头 4B: 0xC5, ver(2), 接收节点号(1|2), 记录条数
//   记录 138B: link, ch, rssi(int8), sweepId, cnt(u16 LE), tms(u32 LE), csi[128] (int8: 虚部,实部 × 64 子载波)
export const FRAME_MAGIC = 0xc5;
export const REC_BYTES = 138;
export const CSI_BYTES = 128;
export const LINK_PEER = 0;
export const LINK_AP = 1;

export interface CsiFrame {
  node: number; // 接收这一帧的节点（1 或 2）
  link: number;
  ch: number;
  rssi: number;
  sweepId: number;
  cnt: number;
  tms: number;
  re: Float32Array; // 64（按 LLTF 排列：0..31 → k=0..31；32..63 → k=-32..-1）
  im: Float32Array;
}

export function parseBatch(buf: Uint8Array): CsiFrame[] {
  const out: CsiFrame[] = [];
  if (buf.length < 4 || buf[0] !== FRAME_MAGIC) return out;
  const node = buf[2];
  const n = buf[3];
  if (node !== 1 && node !== 2) return out;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < n; i++) {
    const o = 4 + i * REC_BYTES;
    if (o + REC_BYTES > buf.length) break;
    const re = new Float32Array(64);
    const im = new Float32Array(64);
    for (let s = 0; s < 64; s++) {
      im[s] = dv.getInt8(o + 10 + 2 * s);
      re[s] = dv.getInt8(o + 11 + 2 * s);
    }
    out.push({
      node,
      link: buf[o],
      ch: buf[o + 1],
      rssi: dv.getInt8(o + 2),
      sweepId: buf[o + 3],
      cnt: dv.getUint16(o + 4, true),
      tms: dv.getUint32(o + 6, true),
      re,
      im,
    });
  }
  return out;
}

export interface RawRec {
  link: number;
  ch: number;
  rssi: number;
  sweepId: number;
  cnt: number;
  tms: number;
  csi: Int8Array; // 128
}

export function encodeBatch(node: number, recs: RawRec[]): Uint8Array {
  const out = new Uint8Array(4 + recs.length * REC_BYTES);
  const dv = new DataView(out.buffer);
  out[0] = FRAME_MAGIC;
  out[1] = 2;
  out[2] = node;
  out[3] = recs.length;
  recs.forEach((r, i) => {
    const o = 4 + i * REC_BYTES;
    out[o] = r.link;
    out[o + 1] = r.ch;
    dv.setInt8(o + 2, r.rssi);
    out[o + 3] = r.sweepId;
    dv.setUint16(o + 4, r.cnt & 0xffff, true);
    dv.setUint32(o + 6, r.tms >>> 0, true);
    for (let s = 0; s < CSI_BYTES; s++) dv.setInt8(o + 10 + s, r.csi[s]);
  });
  return out;
}
