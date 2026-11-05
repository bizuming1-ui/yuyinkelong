// ESP32-B / ESP32-C → MQTT 二进制帧协议 v3（小端）
//
//  批头 8 字节： [0] 0xC5 魔数   [1] 协议版本=3   [2] 节点号(2=B,3=C)   [3] 记录条数
//               [4..5] boot_id u16（每次开机随机，重启可被检测）   [6..7] 设备累计丢弃数 u16(循环)
//  记录 140 字节：[0] flags(bit0=已与 A 的探测序列号配对, bit1=HT帧, bit7=CSI缓冲被截断)
//               [1] 信道   [2] rssi i8   [3] 噪声底 i8（0=不可用）
//               [4..5] seqA u16（A 的探测序列号；bit0=0 时无效）
//               [6..7] rxCnt u16（本节点 CSI 回调计数，用于检测丢包）
//               [8..11] tms u32（本节点 millis，MCU 本地单调时钟域，仅用于排序/延迟分析，不用于跨板同步）
//               [12..139] CSI 原始 int8：64 子载波 ×（虚部,实部）
//  原始 I/Q 不做任何不可逆归一化（提示词第 4.4 节要求）。
export const FRAME_MAGIC = 0xc5;
export const FRAME_VER = 3;
export const HDR_BYTES = 8;
export const REC_BYTES = 140;
export const CSI_BYTES = 128;

export const FLAG_PAIRED = 1;
export const FLAG_HT = 2;

export interface TriFrame {
  node: number; // 2=B 3=C
  boot: number;
  paired: boolean;
  ch: number;
  rssi: number;
  noise: number;
  seqA: number;
  rxCnt: number;
  tms: number;
  droppedTotal: number;
  re: Float32Array; // 64
  im: Float32Array; // 64
}

export function parseTriBatch(buf: Uint8Array): TriFrame[] {
  const out: TriFrame[] = [];
  if (buf.length < HDR_BYTES || buf[0] !== FRAME_MAGIC || buf[1] !== FRAME_VER) return out;
  const node = buf[2];
  if (node !== 2 && node !== 3) return out;
  const n = buf[3];
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const boot = dv.getUint16(4, true);
  const dropped = dv.getUint16(6, true);
  for (let i = 0; i < n; i++) {
    const o = HDR_BYTES + i * REC_BYTES;
    if (o + REC_BYTES > buf.length) break;
    const re = new Float32Array(64);
    const im = new Float32Array(64);
    for (let s = 0; s < 64; s++) {
      im[s] = dv.getInt8(o + 12 + 2 * s);
      re[s] = dv.getInt8(o + 13 + 2 * s);
    }
    out.push({
      node,
      boot,
      paired: (buf[o] & FLAG_PAIRED) !== 0,
      ch: buf[o + 1],
      rssi: dv.getInt8(o + 2),
      noise: dv.getInt8(o + 3),
      seqA: dv.getUint16(o + 4, true),
      rxCnt: dv.getUint16(o + 6, true),
      tms: dv.getUint32(o + 8, true),
      droppedTotal: dropped,
      re,
      im,
    });
  }
  return out;
}

export interface RawTriRec {
  flags: number;
  ch: number;
  rssi: number;
  noise: number;
  seqA: number;
  rxCnt: number;
  tms: number;
  csi: Int8Array; // 128
}

// 仅用于单元测试/模拟：生成与固件完全一致的字节流
export function encodeTriBatch(node: number, boot: number, dropped: number, recs: RawTriRec[]): Uint8Array {
  const out = new Uint8Array(HDR_BYTES + recs.length * REC_BYTES);
  const dv = new DataView(out.buffer);
  out[0] = FRAME_MAGIC;
  out[1] = FRAME_VER;
  out[2] = node;
  out[3] = recs.length;
  dv.setUint16(4, boot & 0xffff, true);
  dv.setUint16(6, dropped & 0xffff, true);
  recs.forEach((r, i) => {
    const o = HDR_BYTES + i * REC_BYTES;
    out[o] = r.flags;
    out[o + 1] = r.ch;
    dv.setInt8(o + 2, r.rssi);
    dv.setInt8(o + 3, r.noise);
    dv.setUint16(o + 4, r.seqA & 0xffff, true);
    dv.setUint16(o + 6, r.rxCnt & 0xffff, true);
    dv.setUint32(o + 8, r.tms >>> 0, true);
    for (let s = 0; s < CSI_BYTES; s++) dv.setInt8(o + 12 + s, r.csi[s]);
  });
  return out;
}
