/* 源图 Dumark 小程序 — 水印自动检测
 * 与电脑版 scripts/detect.js 同一套算法与参数：
 *   analyze     边缘/高频形态学分析 → 候选区域 → 打分合并 → 检测框
 *   refineMask  框内局部背景差分 + Otsu 自适应阈值 → 像素级精修掩码
 * 小程序端无 DBNet 模型可用，因此固定走电脑版的「降级启发式」路径。
 */
import { buildIntegral, boxMean, otsu, dilateInPlace, morphClose, findRects } from './image-ops.js';

/* 输入统一为 { data, width, height }（ImageData 结构），算法不依赖画布 API */
export const WATERMARK_DETECT = {
  analyze(img, opts) {
    opts = opts || {};
    const W = img.width, H = img.height;
    const minArea = opts.minArea || 400;
    const maxArea = opts.maxArea || W * H * 0.4;
    const edgeThreshold = opts.edgeThreshold != null ? opts.edgeThreshold : 58;
    const mergeDist = opts.mergeDist || 16;
    const confBoost = opts.confBoost || 0.05;
    const minFill = opts.minFill || 0.06;
    const maxCoverage = opts.maxCoverage || 0.5;

    const data = img.data;

    // 1. 灰度 + Sobel 边缘 + 5×5 局部方差（高频密度）
    const gray = new Uint8Array(W * H);
    const edge = new Uint8Array(W * H);
    const freq = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x, p = i * 4;
        gray[i] = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000 | 0;
      }
    }
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        const gx = -gray[i - W - 1] - 2 * gray[i - 1] - gray[i + W - 1]
          + gray[i - W + 1] + 2 * gray[i + 1] + gray[i + W + 1];
        const gy = -gray[i - W - 1] - 2 * gray[i - W] - gray[i - W + 1]
          + gray[i + W - 1] + 2 * gray[i + W] + gray[i + W + 1];
        edge[i] = Math.min(255, Math.abs(gx) + Math.abs(gy));

        let mean = 0, n = 0;
        for (let dy = -2; dy <= 2; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= H) continue;
          for (let dx = -2; dx <= 2; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= W) continue;
            mean += gray[yy * W + xx]; n++;
          }
        }
        mean /= n;
        let varSum = 0;
        for (let dy = -2; dy <= 2; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= H) continue;
          for (let dx = -2; dx <= 2; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= W) continue;
            const d = gray[yy * W + xx] - mean;
            varSum += d * d;
          }
        }
        freq[i] = Math.min(255, Math.sqrt(varSum / n) * 2);
      }
    }

    // 2. 二值化：强边缘或高频纹理
    const binary = new Uint8Array(W * H);
    const threshold = Math.max(0, Math.min(255, edgeThreshold));
    for (let i = 0; i < W * H; i++) {
      binary[i] = edge[i] > threshold || freq[i] > threshold ? 1 : 0;
    }

    // 3. 闭运算合并邻近边缘
    morphClose(binary, W, H, 2);

    // 4. 连通域 → 外接矩形，过滤稀疏噪声块
    const raw = findRects(binary, W, H, minArea, maxArea)
      .filter((r) => r.count / (r.w * r.h) >= minFill);

    // 5. 置信度打分 + 邻近合并
    const scored = this._scoreRects(raw, edge, freq, W, H, confBoost);
    let result = this._filterContained(this._mergeRects(scored, mergeDist));

    // 6. 总覆盖率上限：超限按置信度从高到低保留
    const cap = W * H * maxCoverage;
    let total = result.reduce((s, r) => s + r.w * r.h, 0);
    if (total > cap) {
      result.sort((a, b) => b.conf - a.conf);
      const kept = [];
      let acc = 0;
      for (const r of result) {
        if (acc + r.w * r.h > cap) continue;
        kept.push(r); acc += r.w * r.h;
      }
      result = kept;
    }
    return result;
  },

  /* 像素级精修：框内局部背景差分，Otsu 自适应阈值，近乎均匀的误检框整框跳过 */
  refineMask(img, rects, opts) {
    opts = opts || {};
    const diffCap = opts.diffThreshold || 24;
    const minT = opts.minThreshold != null ? opts.minThreshold : 8;
    const skipT = opts.skipThreshold != null ? opts.skipThreshold : 6;
    const dilateR = opts.dilate != null ? opts.dilate : 3;
    const blurR = opts.blurRadius || 7;
    const W = img.width, H = img.height;
    const d = img.data;
    const { integral } = buildIntegral(d, W, H);

    const mask = new Uint8Array(W * H);
    const hist = new Uint32Array(64);

    for (const r of rects) {
      const x0 = Math.max(0, r.x), y0 = Math.max(0, r.y);
      const x1 = Math.min(W, r.x + r.w), y1 = Math.min(H, r.y + r.h);
      if (x1 <= x0 || y1 <= y0) continue;

      hist.fill(0);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * W + x, p = i * 4;
          const lum = d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114;
          const v = Math.abs(lum - boxMean(integral, W, H, x, y, blurR)) | 0;
          hist[Math.min(63, v >> 2)]++;
        }
      }
      let t = otsu(hist) * 4;
      if (t < skipT) continue;
      t = Math.max(minT, Math.min(diffCap, t));

      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * W + x, p = i * 4;
          const lum = d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114;
          if (Math.abs(lum - boxMean(integral, W, H, x, y, blurR)) > t) mask[i] = 1;
        }
      }
    }
    if (dilateR > 0) dilateInPlace(mask, W, H, dilateR);
    return mask;
  },

  /* 打分：边缘密度 + 高频 + 长宽比 + 位置偏好 + 面积惩罚 */
  _scoreRects(rects, edge, freq, W, H, boost) {
    return rects.map((r) => {
      let eSum = 0, fSum = 0, n = 0;
      for (let y = r.y; y < r.y + r.h; y++) {
        for (let x = r.x; x < r.x + r.w; x++) {
          const i = y * W + x;
          eSum += edge[i]; fSum += freq[i]; n++;
        }
      }
      const eAvg = eSum / n, fAvg = fSum / n;
      const aspect = Math.max(r.w, r.h) / Math.max(1, Math.min(r.w, r.h));
      const aspectScore = aspect > 1 && aspect < 15 ? 1 : 0.6;
      const cx = (r.x + r.w / 2) / W, cy = (r.y + r.h / 2) / H;
      const distToEdge = Math.min(cx, 1 - cx, cy, 1 - cy);
      const posScore = distToEdge < 0.15 ? 1.15 : (distToEdge < 0.3 ? 1.05 : 1.0);
      const areaRatio = (r.w * r.h) / (W * H);
      const areaScore = areaRatio < 0.25 ? 1.0 : 0.7;

      let conf = Math.min(0.99, (eAvg / 255 * 0.45 + fAvg / 255 * 0.45 + 0.1) * aspectScore * posScore * areaScore + boost);
      if (r.count / (r.w * r.h) > 0.6) conf = Math.min(0.99, conf + 0.08);
      return { x: r.x, y: r.y, w: r.w, h: r.h, conf: Math.round(conf * 100) / 100 };
    }).filter((r) => r.conf > 0.15);
  },

  /* 合并距离较近的区域 */
  _mergeRects(rects, dist) {
    if (!rects.length) return [];
    const out = [];
    const used = new Set();
    rects.sort((a, b) => b.conf - a.conf);
    for (let i = 0; i < rects.length; i++) {
      if (used.has(i)) continue;
      const r = { ...rects[i] };
      used.add(i);
      for (let j = i + 1; j < rects.length; j++) {
        if (used.has(j)) continue;
        const b = rects[j];
        const cxr = r.x + r.w / 2, cyr = r.y + r.h / 2;
        const cxb = b.x + b.w / 2, cyb = b.y + b.h / 2;
        const dx = Math.max(0, Math.abs(cxr - cxb) - (r.w + b.w) / 2);
        const dy = Math.max(0, Math.abs(cyr - cyb) - (r.h + b.h) / 2);
        if (dx <= dist && dy <= dist) {
          const x2 = Math.max(r.x + r.w, b.x + b.w);
          const y2 = Math.max(r.y + r.h, b.y + b.h);
          r.x = Math.min(r.x, b.x); r.y = Math.min(r.y, b.y);
          r.w = x2 - r.x; r.h = y2 - r.y;
          r.conf = Math.max(r.conf, b.conf);
          used.add(j);
        }
      }
      out.push(r);
    }
    return out;
  },

  /* 过滤被大面积包含的小区域 */
  _filterContained(rects) {
    if (!rects.length) return [];
    rects.sort((a, b) => (b.w * b.h) - (a.w * a.h));
    const out = [];
    for (const r of rects) {
      const contained = out.some((o) => r.x >= o.x - 2 && r.y >= o.y - 2
        && r.x + r.w <= o.x + o.w + 2 && r.y + r.h <= o.y + o.h + 2);
      if (!contained) out.push(r);
    }
    return out;
  },
};
