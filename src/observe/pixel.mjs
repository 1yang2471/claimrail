// 截图像素采样：给对比度检查补上"CSS 采不到背景"的那一类。
//
// 为什么需要它：真站实测（Shinsekai Vite SPA）contrast-ok 只覆盖 7/111 处文本，
// 其余全是渐变/图片背景 —— 不是合格，是判不了。CSS 层永远拿不到渐变里的实际颜色，
// 只能读渲染后的像素。
//
// 三条纪律（与前几层一致）：
//   - 采不到就返回 null，绝不猜。采样点落在文字笔画上、或落在渐变的两侧不一致时都不作数。
//   - 采样必须避开文字本身。取文字矩形内、字形之外的背景点（行间与左右留白），
//     用多个点的一致性来确认"这确实是背景"。
//   - 结果要能被判定层当作"已判"参与统计，同时保留来源标记（pixel / css），
//     让人知道这一条是程序读像素读出来的，不是读样式读出来的。
import { contrastRatio } from './geometry.mjs';

// 从矩形里挑背景采样点：四角内缩 + 中心线上下。全部落在文字自身像素之外。
// 行高通常大于字高，所以上下留白比左右更可靠；宽度不足时退回只取上下。
export function samplePoints(rect, inset = 2) {
  const { x, y, w, h } = rect;
  if (!(w > 0 && h > 0)) return [];
  const left = x + inset;
  const right = x + w - inset;
  const top = y + inset;
  const bottom = y + h - inset;
  const midX = x + Math.floor(w / 2);
  const pts = [
    { x: left, y: top },
    { x: right, y: top },
    { x: left, y: bottom },
    { x: right, y: bottom },
  ];
  // 字高通常占不满行高：上下边缘的点最可能落在纯背景上
  if (h > 2 * inset + 2) {
    pts.push({ x: midX, y: top }, { x: midX, y: bottom });
  }
  return pts;
}

const inBounds = (img, p) => p.x >= 0 && p.y >= 0 && p.x < img.width && p.y < img.height;

export function pixelAt(img, p) {
  if (!inBounds(img, p)) return null;
  const i = (p.y * img.width + p.x) * 4;
  const d = img.data;
  if (d[i + 3] === 0) return null; // 全透明：截图里没有这个像素
  return [d[i], d[i + 1], d[i + 2]];
}

const dist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);

// 一处文本的背景色：采样点里取出现最多的颜色，且要求足够多的点一致。
// 不一致说明采样点压到了文字笔画或跨在渐变上——返回 null，由调用方记"未判"。
export function backgroundAt(img, rect, { tolerance = 24, minAgree = 3 } = {}) {
  const pts = samplePoints(rect).map((p) => pixelAt(img, p)).filter(Boolean);
  if (pts.length < minAgree) return null;

  let best = null;
  let bestCount = 0;
  for (const c of pts) {
    const count = pts.filter((o) => dist(o, c) <= tolerance).length;
    if (count > bestCount) {
      bestCount = count;
      best = c;
    }
  }
  if (bestCount < minAgree) return null;
  const group = pts.filter((o) => dist(o, best) <= tolerance);
  const mean = [0, 1, 2].map((k) => Math.round(group.reduce((s, o) => s + o[k], 0) / group.length));
  return `rgb(${mean[0]}, ${mean[1]}, ${mean[2]})`;
}

// 把采样结果并进采集数据：只填 CSS 层为 null 的那些文本，别覆盖已经采到的值。
// 返回 { texts, filled, inkSuspected, total }，filled 是本轮靠像素救回来的处数。
//
// inkSuspected：采样点全落在字形上时，读到的"背景"其实是文字颜色，对比度会算成 ~1.0。
// 那不是"对比度极差"，是"我把字当成了底"——这种一律退回未判，不许造红。
// 阈值取 1.05：任何真实可见的正文都不可能与其底色几乎同色到 1.05 以内。
const INK_RATIO = 1.05;

export function applyPixelBackgrounds(data, img, opts = {}) {
  let inkSuspected = 0;
  const texts = (data.texts ?? []).map((t) => {
    if (t.background) return t;
    const bg = backgroundAt(img, t.rect, opts);
    if (!bg) return t;
    const ratio = contrastRatio(t.color, bg);
    if (ratio === null || ratio < INK_RATIO) {
      inkSuspected += 1;
      return t;
    }
    return { ...t, background: bg, backgroundFrom: 'pixel' };
  });
  const filled = texts.filter((t) => t.backgroundFrom === 'pixel').length;
  return { texts, filled, inkSuspected, total: texts.length };
}
