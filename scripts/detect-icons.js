/* 源图 Dumark — 图标/Logo 水印启发式检测
 * 文本检测模型（DBNet）对纯图形 Logo（相机、社交图标、电台标）零召回，
 * 此模块限定在「角落 + 底边条带」这些水印高发区做低频亮度异常检测：
 * 大半径背景估计 → |灰度-背景| → 自适应阈值二值化 → 连通域，
 * 并要求实心覆盖物特征（高填充率 + 成员偏移方向一致 + 内部均匀），
 * 全力避免重蹈全图启发式误伤场景内容的覆辙。
 */

const CORNER = 0.22;    // 角落区域边长占图比例
const STRIP = 0.12;     // 底边条带高度占图比例
const MIN_AREA = 500;   // 最小图标面积（原图像素）
const MAX_AREA = 0.08;  // 最大面积占图比例
const FILL_MIN = 0.28;  // 连通域填充率下限（实心图形特征）
const UNIFORM = 0.6;    // 成员偏移标准差 ≤ 均值×此比例（均匀覆盖物特征）
const SIGN_RATIO = 0.8; // 同方向偏移成员占比下限（纯变亮或纯变暗）
const MAX_SHIFT = 48;   // 成员平均偏移上限：实心高对比场景元素（海报色块等）偏移远超半透明水印
const MAX_IN_REGION = 0.6; // 图标框占所在角落/条带区域比例上限
/* 小图形水印通道（星形/小台标等稀疏小图标，solid 规则的面积与半透明限制会漏掉它们）：
 * 只接受「紧贴角落 + 对比度显著强于外围背景波动」的紧凑小块，纹理区宁可漏检不误标 */
const SMALL_MIN = 160;   // 小块 bbox 面积下限（原图像素，约 13×13）
const SMALL_MAX = 6400;  // 小块 bbox 面积上限（原图像素，约 80×80）
const SMALL_ASPECT = 3;  // 长宽比上限（紧凑图形）
const SMALL_FILL = 0.15; // 填充率下限（星形等稀疏形状可低至 0.2 以下）
const SMALL_CONTRAST = 2.5; // 小块偏移均值 ≥ 外围环带标准差×此倍数（纹理背景上区分覆盖物与杂斑）
const SMALL_CORNER = 0.07; // 小图形必须紧贴角落：bbox 近角边距 ≤ 图短边×此比例（平台标识位置固定，自然散景光斑不会全挤在极角）
const SOLID_CORNER = 0.2;  // 实心 Logo 在角落区域内的离角边距上限（树叶光斑等自然斑块不会恰好贴近角落）
const CRISP_MAX = 0.9;     // 边缘锐利度上限（弱响应/强响应）：水印是数字合成的硬边，云/散景/皮肤阴影是光学软边

export function detectIcons(imgCanvas, opts) {
  const sens = (opts && opts.sensitivity) || 'mid';
  const allowSmall = sens !== 'low'; // 小图形通道：低灵敏度档保持保守
  const W = imgCanvas.width, H = imgCanvas.height;
  const k = 0.5; // 半分辨率工作
  const w = Math.max(8, Math.round(W * k)), h = Math.max(8, Math.round(H * k));
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(imgCanvas, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;

  const cw = Math.round(w * CORNER), ch = Math.round(h * CORNER);
  const sh = Math.round(h * STRIP);
  const regions = [
    { x: 0, y: 0, w: cw, h: ch, corner: [0, 0] },           // 左上
    { x: w - cw, y: 0, w: cw, h: ch, corner: [w, 0] },      // 右上
    { x: 0, y: h - ch, w: cw, h: ch, corner: [0, h] },      // 左下
    { x: w - cw, y: h - ch, w: cw, h: ch, corner: [w, h] }, // 右下
    { x: 0, y: h - sh, w: w, h: sh, corner: 'bottom' },     // 底边条带
  ];

  const boxes = [];
  const minArea = MIN_AREA * k * k;
  const maxArea = w * h * MAX_AREA;
  for (const rg of regions) {
    // 大半径盒式模糊估计背景（半径 ≈ 区域短边 25%，须大于常见图标尺寸，避免背景被图标自身污染）
    const r = Math.max(6, Math.round(Math.min(rg.w, rg.h) * 0.25));
    const bg = boxBlur(g, w, h, r);

    // 区域内 |diff| 统计 → 自适应阈值
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
    if (thresh > 60) continue; // 区域本身纹理过强（复杂场景），放弃启发式

    // 二值化 + 连通域
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
          if (nx < rg.x || nx >= rg.x + rg.w || ny < rg.y || ny >= rg.y + rg.h) continue;
          if (!visited[ni] && bin[ni]) { visited[ni] = 1; stack.push(ni); }
        }
      }
      const bw = maxX - minX + 1, bh = maxY - minY + 1;
      const area = bw * bh;
      const dMean = dSum / count;
      const dStd = Math.sqrt(Math.max(0, dSq / count - dMean * dMean));
      const crisp = edgeCrisp(g, bg, w, h, minX, minY, maxX, maxY, dMean);
      // 位置先验：平台标识总贴着角落/底边，自然斑块位置随机
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
      // 规则一：实心半透明覆盖物（平台 Logo 等）
      const isSolid = nearSolid && crisp <= CRISP_MAX
        && area >= minArea && area <= maxArea
        && area <= rg.w * rg.h * MAX_IN_REGION
        && count / area >= FILL_MIN
        && Math.min(bw, bh) >= 7 && Math.max(bw, bh) / Math.min(bw, bh) <= 6
        && dMean <= MAX_SHIFT
        && dStd <= dMean * UNIFORM
        && (pos / count >= SIGN_RATIO || (count - pos) / count >= SIGN_RATIO);
      // 规则二：紧贴角落的紧凑小块（星形点缀、小台标；允许近纯白/纯黑，
      // 用「偏移均值显著高于外围背景波动」在纹理背景上区分覆盖物与杂斑）
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

  // 跨区域去重（角落与底边条带重叠）
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

/* bbox 外围 4px 环带的灰度标准差：衡量局部背景是否平滑（小块水印判据） */
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
  if (n < 8) return 999; // 环带样本不足，按非平滑处理（宁可漏检）
  const mean = sum / n;
  return Math.sqrt(Math.max(0, sum2 / n - mean * mean));
}

/* 边缘锐利度：扩展框内「弱响应像素 / 强响应像素」比值。
 * 数字合成的水印边缘只有 1-2px 抗锯齿过渡 → 比值低（星形实测 0.4）；
 * 云、散景光斑、皮肤阴影等光学软边有过渡晕带 → 比值高（实测 1.2-8）。 */
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
