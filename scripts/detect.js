/* 源图 Dumark — 水印自动检测引擎
 * 基于边缘密度分析 + 高频梯度 + 区域形态学，纯前端图像处理。
 * 无需额外模型下载，即点即用。
 */

export const WATERMARK_DETECT = {
  /* 分析整张图片，返回检测到的水印区域列表 [{x,y,w,h,conf}] */
  analyze(canvas, opts) {
    opts = opts || {};
    const minArea = opts.minArea || 400;      // 最小关注面积
    const maxArea = opts.maxArea || (canvas.width * canvas.height * 0.4); // 最大面积不超过图40%
    const edgeThreshold = opts.edgeThreshold != null ? opts.edgeThreshold : 58; // 边缘阈值(0-255)
    const mergeDist = opts.mergeDist || 16;   // 区域合并距离
    const confBoost = opts.confBoost || 0.05; // 高频区域置信度加成
    const minFill = opts.minFill || 0.06;     // 区域填充率下限（稀疏噪声块过滤）
    const maxCoverage = opts.maxCoverage || 0.5; // 总覆盖率上限，超限按置信度从低到高丢弃

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const { data, width: W, height: H } = ctx.getImageData(0, 0, canvas.width, canvas.height);

    // 1. 灰度图 + Sobel 边缘 + 局部方差(高频)
    const gray = new Uint8Array(W * H);
    const edge = new Uint8Array(W * H);
    const freq = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const p = i * 4;
        gray[i] = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000 | 0;
      }
    }

    // Sobel X/Y
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        const gx =
          -gray[i - W - 1] - 2 * gray[i - 1] - gray[i + W - 1] +
          gray[i - W + 1] + 2 * gray[i + 1] + gray[i + W + 1];
        const gy =
          -gray[i - W - 1] - 2 * gray[i - W] - gray[i - W + 1] +
          gray[i + W - 1] + 2 * gray[i + W] + gray[i + W + 1];
        edge[i] = Math.min(255, Math.abs(gx) + Math.abs(gy));

        // 局部方差 = 高频/纹理密度
        let mean = 0, n = 0;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const yy = y + dy, xx = x + dx;
            if (yy >= 0 && yy < H && xx >= 0 && xx < W) { mean += gray[yy * W + xx]; n++; }
          }
        }
        mean /= n;
        let varSum = 0;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const yy = y + dy, xx = x + dx;
            if (yy >= 0 && yy < H && xx >= 0 && xx < W) { const d = gray[yy * W + xx] - mean; varSum += d * d; }
          }
        }
        freq[i] = Math.min(255, Math.sqrt(varSum / n) * 2);
      }
    }

    // 2. 二值化：边缘强 或 高频纹理 的点标记为候选
    const binary = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) {
      binary[i] = (edge[i] > edgeThreshold || freq[i] > edgeThreshold) ? 1 : 0;
    }

    // 3. 形态学闭运算：合并邻近边缘（小膨胀 + 小腐蚀）
    this._morphClose(binary, W, H, 2);

    // 4. 连通域标记，提取外接矩形（过滤填充率过低的稀疏噪声块）
    const rects = this._findRects(binary, W, H, minArea, maxArea)
      .filter((r) => r.count / (r.w * r.h) >= minFill);

    // 5. 置信度打分 + 邻近合并
    const merged = this._mergeRects(this._scoreRects(rects, edge, freq, W, H, confBoost), mergeDist);

    // 6. 过滤被包含区域 + 总覆盖率上限控制
    let result = this._filterContained(merged);
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
    if (opts.debug) {
      let binCount = 0;
      for (let i = 0; i < binary.length; i++) binCount += binary[i];
      result._debug = { binaryPixels: binCount, rawRects: rects.length, scored: merged.length };
    }
    return result;
  },

  /* 像素级精修：在检测框内，用盒式模糊估计局部背景，
   * 只把「与局部背景颜色差异大」的像素标为水印（Uint8Array 0/1，原图尺寸）。
   * 阈值按框内差异直方图 Otsu 自适应：低对比半透明水印能召回，
   * 近乎均匀的误检框（阈值低于 skipT）自动整框跳过，矩形内均匀区域不误标。 */
  refineMask(canvas, rects, opts) {
    opts = opts || {};
    const diffCap = opts.diffThreshold || 24;  // 自适应阈值上限
    const minT = opts.minThreshold != null ? opts.minThreshold : 8; // 阈值下限
    const skipT = opts.skipThreshold != null ? opts.skipThreshold : 6; // 低于此判定均匀框
    const dilateR = opts.dilate != null ? opts.dilate : 3; // 膨胀半径，保证覆盖描边
    const blurR = opts.blurRadius || 7;
    const W = canvas.width, H = canvas.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const d = ctx.getImageData(0, 0, W, H).data;

    // 积分图（盒式模糊估计局部背景，三通道合并亮度即可）
    const integral = new Float64Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++) {
      let rowSum = 0;
      for (let x = 0; x < W; x++) {
        const p = (y * W + x) * 4;
        const lum = d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114;
        rowSum += lum;
        integral[(y + 1) * (W + 1) + x + 1] = integral[y * (W + 1) + x + 1] + rowSum;
      }
    }
    const boxMean = (x, y) => {
      const x0 = Math.max(0, x - blurR), x1 = Math.min(W - 1, x + blurR);
      const y0 = Math.max(0, y - blurR), y1 = Math.min(H - 1, y + blurR);
      const a = y0 * (W + 1) + x0, b = y0 * (W + 1) + x1 + 1;
      const c2 = (y1 + 1) * (W + 1) + x0, e = (y1 + 1) * (W + 1) + x1 + 1;
      return (integral[e] - integral[b] - integral[c2] + integral[a]) / ((x1 - x0 + 1) * (y1 - y0 + 1));
    };

    const mask = new Uint8Array(W * H);
    const hist = new Uint32Array(64);
    for (const r of rects) {
      const x0 = Math.max(0, r.x), y0 = Math.max(0, r.y);
      const x1 = Math.min(W, r.x + r.w), y1 = Math.min(H, r.y + r.h);
      if (x1 <= x0 || y1 <= y0) continue;

      // 框内 |像素-局部背景| 直方图（4 灰度级/桶）
      hist.fill(0);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * W + x, p = i * 4;
          const lum = d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114;
          const v = Math.abs(lum - boxMean(x, y)) | 0;
          hist[Math.min(63, v >> 2)]++;
        }
      }
      // Otsu 求水印/背景双峰分界
      let t = this._otsu(hist) * 4;
      if (t < skipT) continue; // 框内近乎均匀 → 误检框，跳过
      t = Math.max(minT, Math.min(diffCap, t));

      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * W + x, p = i * 4;
          const lum = d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114;
          if (Math.abs(lum - boxMean(x, y)) > t) mask[i] = 1;
        }
      }
    }

    // 膨胀：覆盖水印描边边缘
    if (dilateR > 0) this._dilateMask(mask, W, H, dilateR);
    return mask;
  },

  /* 64 桶直方图 Otsu 阈值，返回桶下标 */
  _otsu(hist) {
    let total = 0, sum = 0;
    for (let i = 0; i < 64; i++) { total += hist[i]; sum += hist[i] * i; }
    if (!total) return 0;
    let wB = 0, sumB = 0, best = 0, bestT = 0;
    for (let i = 0; i < 63; i++) {
      wB += hist[i]; sumB += hist[i] * i;
      if (!wB || wB === total) continue;
      const mB = sumB / wB, mF = (sum - sumB) / (total - wB);
      const between = wB * (total - wB) * (mB - mF) * (mB - mF);
      if (between > best) { best = between; bestT = i; }
    }
    return bestT;
  },

  /* 矩形结构元膨胀（水平/垂直两趟滑窗，O(n)；run 初始为 r+1 表示「尚无前景」，防止边缘误标） */
  _dilateMask(buf, W, H, r) {
    const tmp = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      const row = y * W;
      let run = r + 1;
      for (let x = 0; x < W; x++) {
        run = buf[row + x] ? 0 : run + 1;
        tmp[row + x] = run <= r ? 1 : 0;
      }
      run = r + 1;
      for (let x = W - 1; x >= 0; x--) {
        run = buf[row + x] ? 0 : run + 1;
        if (run <= r) tmp[row + x] = 1;
      }
    }
    for (let x = 0; x < W; x++) {
      let run = r + 1;
      for (let y = 0; y < H; y++) {
        run = tmp[y * W + x] ? 0 : run + 1;
        if (run <= r) buf[y * W + x] = 1;
      }
      run = r + 1;
      for (let y = H - 1; y >= 0; y--) {
        run = tmp[y * W + x] ? 0 : run + 1;
        if (run <= r) buf[y * W + x] = 1;
      }
    }
  },

  /* 形态学闭运算（简化版：膨胀+腐蚀） */
  _morphClose(buf, W, H, r) {
    const tmp = new Uint8Array(buf);
    // 膨胀
    for (let y = r; y < H - r; y++) {
      for (let x = r; x < W - r; x++) {
        const i = y * W + x;
        if (buf[i]) continue;
        let found = false;
        for (let dy = -r; dy <= r && !found; dy++) {
          for (let dx = -r; dx <= r && !found; dx++) {
            if (buf[(y + dy) * W + (x + dx)]) found = true;
          }
        }
        if (found) tmp[i] = 1;
      }
    }
    buf.set(tmp);
    // 腐蚀
    for (let y = r; y < H - r; y++) {
      for (let x = r; x < W - r; x++) {
        const i = y * W + x;
        if (!buf[i]) continue;
        let ok = true;
        for (let dy = -r; dy <= r && ok; dy++) {
          for (let dx = -r; dx <= r && ok; dx++) {
            if (!buf[(y + dy) * W + (x + dx)]) ok = false;
          }
        }
        if (!ok) tmp[i] = 0;
      }
    }
    buf.set(tmp);
  },

  /* 连通域扫描（4-连通），返回矩形列表 */
  _findRects(buf, W, H, minArea, maxArea) {
    const visited = new Uint8Array(W * H);
    const rects = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (!buf[i] || visited[i]) continue;
        // BFS
        const stack = [i];
        visited[i] = 1;
        let minX = x, maxX = x, minY = y, maxY = y, count = 0;
        while (stack.length) {
          const ci = stack.pop();
          const cx = ci % W, cy = (ci / W) | 0;
          count++;
          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;
          const nbs = [ci - 1, ci + 1, ci - W, ci + W];
          for (const ni of nbs) {
            const nx = ni % W, ny = (ni / W) | 0;
            if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
            if (!visited[ni] && buf[ni]) { visited[ni] = 1; stack.push(ni); }
          }
        }
        const area = (maxX - minX + 1) * (maxY - minY + 1);
        if (area >= minArea && area <= maxArea) {
          rects.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, count });
        }
      }
    }
    return rects;
  },

  /* 给矩形打分：结合边缘密度、高频纹理、长宽比、位置偏好 */
  _scoreRects(rects, edge, freq, W, H, boost) {
    return rects.map(r => {
      let eSum = 0, fSum = 0, n = 0;
      for (let y = r.y; y < r.y + r.h; y++) {
        for (let x = r.x; x < r.x + r.w; x++) {
          const i = y * W + x;
          eSum += edge[i]; fSum += freq[i]; n++;
        }
      }
      const eAvg = eSum / n, fAvg = fSum / n;
      // 长宽比惩罚（太扁或太方的区域降低分数）
      const aspect = Math.max(r.w, r.h) / Math.max(1, Math.min(r.w, r.h));
      const aspectScore = aspect > 1 && aspect < 15 ? 1 : 0.6;
      // 位置偏好：角落和边缘更可能是水印
      const cx = (r.x + r.w / 2) / W, cy = (r.y + r.h / 2) / H;
      const distToEdge = Math.min(cx, 1 - cx, cy, 1 - cy);
      const posScore = distToEdge < 0.15 ? 1.15 : (distToEdge < 0.3 ? 1.05 : 1.0);
      // 面积惩罚：太大或太小的区域降低分数
      const areaRatio = (r.w * r.h) / (W * H);
      const areaScore = areaRatio < 0.25 ? 1.0 : 0.7;

      let conf = Math.min(0.99, (eAvg / 255 * 0.45 + fAvg / 255 * 0.45 + 0.1) * aspectScore * posScore * areaScore + boost);
      // 增加最低置信度保护
      if (r.count / (r.w * r.h) > 0.6) conf = Math.min(0.99, conf + 0.08); // 填充率高的区域更可能是水印
      return { ...r, conf: Math.round(conf * 100) / 100 };
    }).filter(r => r.conf > 0.15);
  },

  /* 合并距离较近的区域 */
  _mergeRects(rects, dist) {
    if (!rects.length) return [];
    const out = [];
    const used = new Set();
    rects.sort((a, b) => b.conf - a.conf);
    for (let i = 0; i < rects.length; i++) {
      if (used.has(i)) continue;
      let r = { ...rects[i] };
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
      let contained = false;
      for (const o of out) {
        if (r.x >= o.x - 2 && r.y >= o.y - 2 && r.x + r.w <= o.x + o.w + 2 && r.y + r.h <= o.y + o.h + 2) {
          contained = true; break;
        }
      }
      if (!contained) out.push(r);
    }
    return out;
  }
};
