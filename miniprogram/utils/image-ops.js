/* 源图 Dumark 小程序 — 图像处理基础算子
 * 与电脑版 scripts/detect.js 内部工具一一对应，供水印检测与平铺补全复用。
 */

/* 积分图（Float64），返回 {integral, IW}，用于 O(1) 盒式均值 */
export function buildIntegral(data, W, H) {
  const IW = W + 1;
  const integral = new Float64Array(IW * (H + 1));
  for (let y = 0; y < H; y++) {
    let rowSum = 0;
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4;
      rowSum += data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114;
      integral[(y + 1) * IW + x + 1] = integral[y * IW + x + 1] + rowSum;
    }
  }
  return { integral, IW };
}

/* 积分图盒式均值（边界自动裁剪） */
export function boxMean(integ, W, H, x, y, r) {
  const x0 = Math.max(0, x - r), x1 = Math.min(W - 1, x + r);
  const y0 = Math.max(0, y - r), y1 = Math.min(H - 1, y + r);
  const IW = W + 1;
  const a = y0 * IW + x0, b = y0 * IW + x1 + 1;
  const c = (y1 + 1) * IW + x0, e = (y1 + 1) * IW + x1 + 1;
  const area = (x1 - x0 + 1) * (y1 - y0 + 1);
  return (integ[e] - integ[b] - integ[c] + integ[a]) / area;
}

/* 64 桶直方图 Otsu 阈值，返回桶下标 */
export function otsu(hist) {
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
}

/* 矩形结构元膨胀（水平/垂直两趟滑窗，O(n)） */
export function dilate(src, W, H, r) {
  const tmp = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    let run = r + 1;
    for (let x = 0; x < W; x++) {
      run = src[row + x] ? 0 : run + 1;
      tmp[row + x] = run <= r ? 1 : 0;
    }
    run = r + 1;
    for (let x = W - 1; x >= 0; x--) {
      run = src[row + x] ? 0 : run + 1;
      if (run <= r) tmp[row + x] = 1;
    }
  }
  const out = new Uint8Array(W * H);
  for (let x = 0; x < W; x++) {
    let run = r + 1;
    for (let y = 0; y < H; y++) {
      run = tmp[y * W + x] ? 0 : run + 1;
      if (run <= r) out[y * W + x] = 1;
    }
    run = r + 1;
    for (let y = H - 1; y >= 0; y--) {
      run = tmp[y * W + x] ? 0 : run + 1;
      if (run <= r) out[y * W + x] = 1;
    }
  }
  return out;
}

/* 原地膨胀（检测精修用） */
export function dilateInPlace(buf, W, H, r) {
  const out = dilate(buf, W, H, r);
  buf.set(out);
}

/* 形态学闭运算（膨胀 + 腐蚀，合并断裂边缘） */
export function morphClose(buf, W, H, r) {
  const dilated = dilate(buf, W, H, r);
  const inv = new Uint8Array(W * H);
  for (let i = 0; i < inv.length; i++) inv[i] = dilated[i] ? 0 : 1;
  const erodedInv = dilate(inv, W, H, r);
  for (let i = 0; i < buf.length; i++) buf[i] = erodedInv[i] ? 0 : 1;
}

/* 4-连通域扫描，返回矩形列表 */
export function findRects(buf, W, H, minArea, maxArea) {
  const visited = new Uint8Array(W * H);
  const rects = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!buf[i] || visited[i]) continue;
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
          if (ni < 0 || ni >= W * H) continue;
          const nx = ni % W;
          if (Math.abs(nx - cx) > 1) continue; // 排除跨行邻点
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
}
