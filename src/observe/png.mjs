// 最小 PNG 解码：只支持 8 位、非隔行的 RGB / RGBA / 灰度。
// 存在的理由：对比度在渐变/图片背景上采不到 CSS 色值时，只能读截图里的真实像素。
// 不引运行时依赖（这个包的可选依赖只有 playwright），所以自己解。
//
// 解不了的情况一律抛错，由调用方降级成"未判"——绝不允许猜一个颜色出来。

import { inflateSync } from 'node:zlib';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// 返回 { width, height, data: Uint8Array(RGBA) }
export function decodePng(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length < 8 || !b.subarray(0, 8).equals(SIG)) throw new Error('不是 PNG');

  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  const idat = [];

  while (off + 8 <= b.length) {
    const len = b.readUInt32BE(off);
    const type = b.toString('ascii', off + 4, off + 8);
    const body = b.subarray(off + 8, off + 8 + len);
    if (body.length < len) throw new Error('PNG 被截断');
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8];
      colorType = body[9];
      interlace = body[12];
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    off += 12 + len;
  }

  if (!width || !height) throw new Error('PNG 缺 IHDR');
  if (bitDepth !== 8) throw new Error(`只支持 8 位色深，收到 ${bitDepth}`);
  if (interlace !== 0) throw new Error('不支持隔行 PNG');
  const ch = CHANNELS[colorType];
  if (!ch) throw new Error(`不支持的 colorType ${colorType}`);
  if (!idat.length) throw new Error('PNG 没有 IDAT');

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * ch;
  if (raw.length < (stride + 1) * height) throw new Error('PNG 数据长度不足');

  const px = new Uint8Array(width * height * ch);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const out = px.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? out[i - ch] : 0;
      const bb = prev ? prev[i] : 0;
      const c = prev && i >= ch ? prev[i - ch] : 0;
      const v = line[i];
      let val;
      if (filter === 0) val = v;
      else if (filter === 1) val = v + a;
      else if (filter === 2) val = v + bb;
      else if (filter === 3) val = v + ((a + bb) >> 1);
      else if (filter === 4) val = v + paeth(a, bb, c);
      else throw new Error(`未知 PNG 行过滤器 ${filter}`);
      out[i] = val & 0xff;
    }
  }

  const data = new Uint8Array(width * height * 4);
  for (let i = 0, n = width * height; i < n; i++) {
    if (ch === 4) {
      data[i * 4] = px[i * 4];
      data[i * 4 + 1] = px[i * 4 + 1];
      data[i * 4 + 2] = px[i * 4 + 2];
      data[i * 4 + 3] = px[i * 4 + 3];
    } else if (ch === 3) {
      data[i * 4] = px[i * 3];
      data[i * 4 + 1] = px[i * 3 + 1];
      data[i * 4 + 2] = px[i * 3 + 2];
      data[i * 4 + 3] = 255;
    } else {
      const g = px[i];
      data[i * 4] = g;
      data[i * 4 + 1] = g;
      data[i * 4 + 2] = g;
      data[i * 4 + 3] = 255;
    }
  }

  return { width, height, data };
}
