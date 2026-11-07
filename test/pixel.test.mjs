import test from 'node:test';
import assert from 'node:assert/strict';

import { decodePng } from '../src/observe/png.mjs';
import { samplePoints, pixelAt, backgroundAt, applyPixelBackgrounds } from '../src/observe/pixel.mjs';
import { contrastRatio } from '../src/observe/geometry.mjs';

// 手写一张 PNG：不依赖 Playwright，纯逻辑层就能测。
// 用 zlib 自己压，滤波器固定 0（None），足够覆盖解码路径。
import { deflateSync } from 'node:zlib';

function makePng(width, height, paint) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a = 255] = paint(x, y);
      const i = y * (stride + 1) + 1 + x * 4;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
      raw[i + 3] = a;
    }
  }
  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const tb = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(tb) >>> 0);
    return Buffer.concat([len, tb, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c;
}

test('PNG 解码：纯色图逐像素读回', () => {
  const img = decodePng(makePng(8, 4, () => [12, 34, 56]));
  assert.equal(img.width, 8);
  assert.equal(img.height, 4);
  assert.deepEqual(pixelAt(img, { x: 3, y: 2 }), [12, 34, 56]);
});

test('PNG 解码：左右分色，坐标不许错位', () => {
  const img = decodePng(makePng(20, 4, (x) => (x < 10 ? [200, 100, 50] : [10, 20, 30])));
  assert.deepEqual(pixelAt(img, { x: 2, y: 1 }), [200, 100, 50]);
  assert.deepEqual(pixelAt(img, { x: 15, y: 1 }), [10, 20, 30]);
});

test('PNG 解码：越界与非 PNG 一律返回 null / 抛错，不猜', () => {
  const img = decodePng(makePng(4, 4, () => [1, 2, 3]));
  assert.equal(pixelAt(img, { x: -1, y: 0 }), null);
  assert.equal(pixelAt(img, { x: 4, y: 0 }), null);
  assert.throws(() => decodePng(Buffer.from('not a png')), /不是 PNG/);
});

test('PNG 解码：全透明像素返回 null（截图里没有这个像素）', () => {
  const img = decodePng(makePng(4, 4, () => [0, 0, 0, 0]));
  assert.equal(pixelAt(img, { x: 1, y: 1 }), null);
});

test('采样点必须落在矩形内部，且不重复', () => {
  const pts = samplePoints({ x: 10, y: 20, w: 100, h: 20 });
  assert.ok(pts.length >= 4);
  for (const p of pts) {
    assert.ok(p.x >= 10 && p.x <= 110, `x 越界 ${p.x}`);
    assert.ok(p.y >= 20 && p.y <= 40, `y 越界 ${p.y}`);
  }
  const keys = new Set(pts.map((p) => `${p.x},${p.y}`));
  assert.equal(keys.size, pts.length, '采样点有重复');
});

test('采样点：零尺寸矩形不产出任何点', () => {
  assert.deepEqual(samplePoints({ x: 0, y: 0, w: 0, h: 0 }), []);
});

test('背景采样：纯色区域读回该颜色', () => {
  const img = decodePng(makePng(60, 30, () => [240, 240, 240]));
  const bg = backgroundAt(img, { x: 5, y: 5, w: 50, h: 20 });
  assert.equal(bg, 'rgb(240, 240, 240)');
});

test('背景采样：采样点全落在字形上（读到的"底色"就是字色）→ 退回未判，不造红', () => {
  // 采样点位置全是黑的：说明这一块根本看不到底，只有字
  const img = decodePng(makePng(60, 30, () => [0, 0, 0]));
  const data = { texts: [{ selector: '.ink', rect: { x: 5, y: 5, w: 50, h: 20 }, color: 'rgb(0,0,0)', background: null }] };
  const r = applyPixelBackgrounds(data, img);
  assert.equal(r.filled, 0, '把字色当成背景填进去了');
  assert.equal(r.inkSuspected, 1);
  assert.equal(r.texts[0].background, null);
});

test('背景采样：跨渐变（点与点差异大）→ null，不猜', () => {
  const img = decodePng(makePng(200, 30, (x) => [x, x, x]));
  assert.equal(backgroundAt(img, { x: 0, y: 5, w: 190, h: 20 }), null);
});

test('像素背景只补 CSS 采不到的那些，已采到的不覆盖', () => {
  const img = decodePng(makePng(60, 30, () => [250, 250, 250]));
  const data = {
    texts: [
      { selector: '.a', rect: { x: 5, y: 5, w: 50, h: 20 }, color: 'rgb(0,0,0)', background: 'rgb(255,255,255)' },
      { selector: '.b', rect: { x: 5, y: 5, w: 50, h: 20 }, color: 'rgb(0,0,0)', background: null },
    ],
  };
  const r = applyPixelBackgrounds(data, img);
  assert.equal(r.filled, 1);
  assert.equal(r.texts[0].background, 'rgb(255,255,255)', '已采到的背景被覆盖了');
  assert.equal(r.texts[0].backgroundFrom, undefined);
  assert.equal(r.texts[1].background, 'rgb(250, 250, 250)');
  assert.equal(r.texts[1].backgroundFrom, 'pixel');
});

test('像素背景读出来的颜色能直接参与对比度判定', () => {
  const img = decodePng(makePng(60, 30, () => [255, 255, 255]));
  const r = applyPixelBackgrounds({ texts: [{ selector: '.x', rect: { x: 5, y: 5, w: 50, h: 20 }, color: 'rgb(200,200,200)', background: null }] }, img);
  const ratio = contrastRatio(r.texts[0].color, r.texts[0].background);
  assert.ok(ratio !== null && ratio < 4.5, `浅灰压白应当判不足 4.5:1，实得 ${ratio}`);
});
