/* 源图 Dumark 小程序 — 图标 / Logo 水印启发式检测
 * 与电脑版 scripts/detect-icons.js 同一套规则：只在「四角 + 底边条带」做
 * 大半径背景差分 → 自适应阈值 → 连通域，并要求实心覆盖物特征（填充率、
 * 偏移方向一致、内部均匀、边缘锐利），避免误伤场景内容。
 */
import { resizeImage } from './canvas.js';

const CORNER = 0.22;
const STRIP = 0.12;
const MIN_AREA = 500;
const MAX_AREA = 0.08;
const FILL_MIN = 0.28;
const UNIFORM = 0.6;
const SIGN_RATIO = 0.8;
const MAX_SHIFT = 48;
const MAX_IN_REGION = 0.6;
const SMALL_MIN = 160;
const SMALL_MAX = 6400;
const SMALL_ASPECT = 3;
const SMALL_FILL = 0.15;
const SMALL_CONTRAST = 2.5;
const SMALL_CORNER = 0.07;
const SOLID_CORNER = 0.2;
const CRISP_MAX = 0.9;

/* 输入原图 ImageData，返回原图坐标下的检测框 [{x,y,w,h,conf}] */
export function detectIcons(img, opts) {
  const sens = (opts && opts.sensitivity) || 'mid';
  const allowSmall = sens !== 'low';
  const W = img.width, H = img.height;
  const k = 0.5;
  const w = Math.max(8, Math.round(W * k)), h = Math.max(8, Math.round(H * k));
  const half = resizeImage(img, w, h);
  const d = half.data;
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    g[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
  }

  const cw = Math.round(w * CORNER), ch = Math.round(h * CORNER);
  const sh = Math.round(h * STRIP);
  const regions = [
    { x: 0, y: 0, w: cw, h: ch, corner: [0, 0] },
    { x: w - cw, y: 0, w: cw, h: ch, corner: [w, 0] },
    { x: 0, y: h - ch, w: cw, h: ch, corner: [0, h] },
    { x: w - cw, y: h - ch, w: cw, h: ch, corner: [w, h] },
    { x: 0, y: h - sh, w: w, h: sh, corner: 'bottom' },
  ];

  const boxes = [];
  const minArea = MIN_AREA * k * k;
  const maxArea = w * h * MAX_AREA;

  for (const rg of regions) {
    const r = Math.max(6, Math.round(Math.min(rg.w, rg.h) * 0.25));
    const bg = boxBlur(g, w, h, r);

    let sum = 0, sum2 = 0, n = 0;
    for (let y = rg.y; y < rg.y + rg.h; y++) {
      for (let x = rg.x; x < rg.x + rg.w; x++) {
        const v = Math.abs(g[y * w + x] - bg[y * w + x]);
        sum += v; sum2 += v * v; n++;
      }
    }
    if (!n) continue;
    const mean = sum / n;
    const std = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
    const thresh = Math.max(10, mean + 2 * std);
    if (thresh > 60) continue;

    const bin = new Uint8Array(w * h);
    const signed = new Int8Array(w * h);
    for (let y = rg.y; y < rg.y + rg.h; y++) {
      for (let x = rg.x; x < rg.x + rg.w; x++) {
        const i = y * w + x;
        const dv = g[i] - bg[i];
        if (Math.abs(dv) >= thresh) { bin[i] = 1; signed[i] = dv > 0 ? 1 : -1; }
      }
    }

    const visited = new Uint8Array(w * h);
    for (let s = rg.y * w + rg.x; s < (rg.y + rg.h) * w; s++) {
      if (!bin[s] || visited[s] || s % w < rg.x || s % w >= rg.x + rg.w) continue;
      const stack = [s];
      visited[s] = 1;
      let minX = w, minY = h, maxX = -1, maxY = -1, count = 0, dSum = 0, dSq = 0, pos = 0;
      while (stack.length) {
        const ci = stack.pop();
        const cx = ci % w, cy = (ci / w) | 0;
        count++;
        const dv = Math.abs(g[ci] - bg[ci]);
        dSum += dv; dSq += dv * dv;
        if (signed[ci] > 0) pos++;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        for (const ni of [ci - 1, ci + 1, ci - w, ci + w]) {
          if (ni < 0 || ni >= w * h) continue;
          const nx = ni % w, ny = (ni / w) | 0;
          if (Math.abs(nx - cx) > 1) continue;
          if (nx < rg.x || nx >= rg.x + rg.w || ny < rg.y || ny >= rg.y + rg.h) continue;
          if (!visited[ni] && bin[ni]) { visited[ni] = 1; stack.push(ni); }
        }
      }
      const bw = maxX - minX + 1, bh = maxY - minY + 1;
      const area = bw * bh;
      const dMean = dSum / count;
      const dStd = Math.sqrt(Math.max(0, dSq / count - dMean * dMean));
      const crisp = edgeCrisp(g, bg, w, h, minX, minY, maxX, maxY, dMean);
      const minSide = Math.min(w, h);
      let nearSmall = false, nearSolid = true;
      if (rg.corner === 'bottom') {
        nearSmall = (h - 1 - maxY) <= minSide * SMALL_CORNER
          && (minX <= minSide * SMALL_CORNER || (w - 1 - maxX) <= minSide * SMALL_CORNER);
      } else if (rg.corner) {
        nearSmall = (rg.corner[0] === 0 ? minX : w - 1 - maxX) <= minSide * SMALL_CORNER
          && (rg.corner[1] === 0 ? minY : h - 1 - maxY) <= minSide * SMALL_CORNER;
        nearSolid = (rg.corner[0] === 0 ? minX : w - 1 - maxX) <= minSide * SOLID_CORNER
          && (rg.corner[1] === 0 ? minY : h - 1 - maxY) <= minSide * SOLID_CORNER;
      }
      const isSolid = nearSolid && crisp <= CRISP_MAX
        && area >= minArea && area <= maxArea
        && area <= rg.w * rg.h * MAX_IN_REGION
        && count / area >= FILL_MIN
        && Math.min(bw, bh) >= 7 && Math.max(bw, bh) / Math.min(bw, bh) <= 6
        && dMean <= MAX_SHIFT
        && dStd <= dMean * UNIFORM
        && (pos / count >= SIGN_RATIO || (count - pos) / count >= SIGN_RATIO);
      const isSmall = !isSolid && allowSmall && nearSmall && crisp <= CRISP_MAX
        && area >= SMALL_MIN * k * k && area <= SMALL_MAX * k * k
        && count / area >= SMALL_FILL
        && Math.max(bw, bh) / Math.min(bw, bh) <= SMALL_ASPECT
        && dMean >= Math.max(20, ringStd(g, w, h, minX, minY, maxX, maxY) * SMALL_CONTRAST);
      if (!isSolid && !isSmall) continue;
      boxes.push({
        x: Math.round(minX / k), y: Math.round(minY / k),
        w: Math.round(bw / k), h: Math.round(bh / k), conf: isSolid ? 0.5 : 0.45,
      });
    }
  }

  const out = [];
  boxes.sort((a, b) => b.w * b.h - a.w * a.h);
  for (const b of boxes) {
    if (out.some((o) => overlap(b, o) > 0.3)) continue;
    out.push(b);
  }
  return out;
}

function overlap(a, b) {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / Math.min(a.w * a.h, b.w * b.h);
}

function ringStd(g, W, H, minX, minY, maxX, maxY) {
  const m = 4;
  const x0 = Math.max(0, minX - m), y0 = Math.max(0, minY - m);
  const x1 = Math.min(W - 1, maxX + m), y1 = Math.min(H - 1, maxY + m);
  let sum = 0, sum2 = 0, n = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (x >= minX && x <= maxX && y >= minY && y <= maxY) continue;
      const v = g[y * W + x];
      sum += v; sum2 += v * v; n++;
    }
  }
  if (n < 8) return 999;
  const mean = sum / n;
  return Math.sqrt(Math.max(0, sum2 / n - mean * mean));
}

function edgeCrisp(g, bg, W, H, minX, minY, maxX, maxY, dMean) {
  const m = 3, lo = 0.2 * dMean, hi = 0.8 * dMean;
  const x0 = Math.max(0, minX - m), y0 = Math.max(0, minY - m);
  const x1 = Math.min(W - 1, maxX + m), y1 = Math.min(H - 1, maxY + m);
  let strong = 0, weak = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dv = Math.abs(g[y * W + x] - bg[y * W + x]);
      if (dv >= hi) strong++;
      else if (dv >= lo) weak++;
    }
  }
  return strong ? weak / strong : 1;
}

/* 盒式模糊（积分图） */
function boxBlur(src, W, H, r) {
  const IW = W + 1;
  const integ = new Float64Array(IW * (H + 1));
  for (let y = 0; y < H; y++) {
    let s = 0;
    for (let x = 0; x < W; x++) {
      s += src[y * W + x];
      integ[(y + 1) * IW + x + 1] = integ[y * IW + x + 1] + s;
    }
  }
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(H - 1, y + r);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(W - 1, x + r);
      const a = y0 * IW + x0, b = y0 * IW + x1 + 1, c = (y1 + 1) * IW + x0, e = (y1 + 1) * IW + x1 + 1;
      out[y * W + x] = (integ[e] - integ[b] - integ[c] + integ[a]) / ((x1 - x0 + 1) * (y1 - y0 + 1));
    }
  }
  return out;
}
