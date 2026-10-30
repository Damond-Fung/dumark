/* 源图 Dumark — 平铺水印覆盖补全扩展
 * 原理：文本检测对斜向平铺水印常输出大片合并框并漏掉边缘角落（被裁切/对比度弱的
 * 实例）。将已检框并集按水印尺度做形态学膨胀，膨胀出的「未覆盖连通区」即疑似
 * 漏检带；用高通能量校验（须达已检框中位能量）过滤空白区后回补为检测框。
 * 对行间错位、实例被边缘裁切、点阵不规则均稳健。
 */

const MIN_INSTANCES = 3;   // 启用补全所需的最少已检出实例
const MAX_ADD = 20;        // 最多补齐区域数
const MAX_AREA_RATIO = 0.35; // 补全总面积占图片比例上限，超出视为误判放弃
const GRID = 8;            // 覆盖位图降采样因子（性能）
const ENERGY_MAX = 480;    // 能量校验用降采样分辨率（长边）
const ENERGY_REL = 0.45;   // 候选区能量 ≥ 已检框中位能量的此比例才补
const ENERGY_ABS = 1.5;    // 能量绝对下限（灰度级），避免平坦区
const SIZE_CV_MAX = 0.6;   // 实例尺寸一致性：平铺水印各实例同尺度，框高标准差/均值超过此值判定为自然纹理误检，不做扩展

export function extendTiled(imgCanvas, boxes) {
  if (!boxes || boxes.length < MIN_INSTANCES) return boxes;
  // 尺寸一致性门控：真实平铺水印实例同尺度重复；岩石/树叶等纹理误检框大小参差，直接放弃扩展
  const hs = boxes.map((b) => b.h).sort((a, b) => a - b);
  const hMean = hs.reduce((s, v) => s + v, 0) / hs.length;
  const hStd = Math.sqrt(hs.reduce((s, v) => s + (v - hMean) * (v - hMean), 0) / hs.length);
  if (hStd / hMean > SIZE_CV_MAX) return boxes;
  const W = imgCanvas.width, H = imgCanvas.height;

  // 1. 降采样覆盖位图：已检框并集
  const gw = Math.ceil(W / GRID), gh = Math.ceil(H / GRID);
  const cov = new Uint8Array(gw * gh);
  for (const b of boxes) {
    const x0 = Math.max(0, Math.floor(b.x / GRID)), y0 = Math.max(0, Math.floor(b.y / GRID));
    const x1 = Math.min(gw - 1, Math.ceil((b.x + b.w) / GRID)), y1 = Math.min(gh - 1, Math.ceil((b.y + b.h) / GRID));
    for (let y = y0; y <= y1; y++) cov.fill(1, y * gw + x0, y * gw + x1 + 1);
  }

  // 2. 按水印尺度膨胀（约为图短边的 12%，限幅），补上相邻漏检带
  const r = Math.max(3, Math.round(Math.min(140, Math.max(40, Math.min(W, H) * 0.12)) / GRID));
  const dil = dilate(cov, gw, gh, r);

  // 3. 新增区 = 膨胀 - 原覆盖，连通域提取
  const diff = new Uint8Array(gw * gh);
  let diffCells = 0;
  for (let i = 0; i < dil.length; i++) { if (dil[i] && !cov[i]) { diff[i] = 1; diffCells++; } }
  if (!diffCells) return boxes;
  if (diffCells > gw * gh * MAX_AREA_RATIO) return boxes; // 膨胀出大半张图 → 判定失效

  // 4. 能量校验基准：已检框的中位高通能量
  const energy = buildEnergy(imgCanvas);
  const medE = median(boxes.map((b) => regionEnergy(energy, b.x, b.y, b.w, b.h, W, H)));
  if (medE < ENERGY_ABS) return boxes;

  // 5. 连通域 → 单元级能量过滤（保留水印纹理格）→ 膨胀 → 子带矩形
  //    对角带状未覆盖区连成大组件时，bbox 会把干净背景也圈进来，必须按格过滤
  const { hp, k: ek, W: eW } = energy;
  const cellThresh = Math.max(2, medE * 0.9);
  const cellEnergy = (gx, gy) => {
    const ex = Math.min(eW - 1, Math.round((gx * GRID + GRID / 2) * ek));
    const ey = Math.min(hp.length / eW - 1, Math.round((gy * GRID + GRID / 2) * ek));
    return hp[ey * eW + ex];
  };

  const kept = new Uint8Array(gw * gh);
  const visited = new Uint8Array(gw * gh);
  const minCells = Math.max(16, Math.round(600 / (GRID * GRID)));
  for (let s = 0; s < diff.length; s++) {
    if (!diff[s] || visited[s]) continue;
    const cells = [];
    const stack = [s];
    visited[s] = 1;
    while (stack.length) {
      const ci = stack.pop();
      cells.push(ci);
      const cx = ci % gw, cy = (ci / gw) | 0;
      if (cx > 0 && diff[ci - 1] && !visited[ci - 1]) { visited[ci - 1] = 1; stack.push(ci - 1); }
      if (cx < gw - 1 && diff[ci + 1] && !visited[ci + 1]) { visited[ci + 1] = 1; stack.push(ci + 1); }
      if (cy > 0 && diff[ci - gw] && !visited[ci - gw]) { visited[ci - gw] = 1; stack.push(ci - gw); }
      if (cy < gh - 1 && diff[ci + gw] && !visited[ci + gw]) { visited[ci + gw] = 1; stack.push(ci + gw); }
    }
    if (cells.length < minCells) continue;
    for (const ci of cells) {
      if (cellEnergy(ci % gw, (ci / gw) | 0) >= cellThresh) kept[ci] = 1;
    }
  }

  // 高能量格膨胀 2 格（覆盖纹理边缘），再提取子带 bbox
  const grown = dilate(kept, gw, gh, 2);
  const added = [];
  const seen = new Uint8Array(gw * gh);
  for (let s = 0; s < grown.length && added.length < MAX_ADD; s++) {
    if (!grown[s] || seen[s]) continue;
    const stack = [s];
    seen[s] = 1;
    let minX = gw, minY = gh, maxX = -1, maxY = -1;
    while (stack.length) {
      const ci = stack.pop();
      const cx = ci % gw, cy = (ci / gw) | 0;
      if (cx < minX) minX = cx;
      if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy;
      if (cy > maxY) maxY = cy;
      if (cx > 0 && grown[ci - 1] && !seen[ci - 1]) { seen[ci - 1] = 1; stack.push(ci - 1); }
      if (cx < gw - 1 && grown[ci + 1] && !seen[ci + 1]) { seen[ci + 1] = 1; stack.push(ci + 1); }
      if (cy > 0 && grown[ci - gw] && !seen[ci - gw]) { seen[ci - gw] = 1; stack.push(ci - gw); }
      if (cy < gh - 1 && grown[ci + gw] && !seen[ci + gw]) { seen[ci + gw] = 1; stack.push(ci + gw); }
    }
    const cells = (maxX - minX + 1) * (maxY - minY + 1);
    if (cells < minCells) continue;
    const bx = minX * GRID, by = minY * GRID;
    const bw = Math.min(W - bx, (maxX + 1) * GRID - bx), bh = Math.min(H - by, (maxY + 1) * GRID - by);
    added.push({ x: bx, y: by, w: bw, h: bh, conf: 0.6 });
  }
  if (!added.length) return boxes;

  return boxes.concat(added);
}

/* ── 工具 ── */
function median(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[s.length >> 1];
}

/* 矩形结构元膨胀（水平/垂直两趟滑窗最大值，O(n) 每趟；run 初始为 r+1 表示「尚无前景」，防止网格边缘出现假覆盖带） */
function dilate(src, W, H, r) {
  const tmp = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    let run = r + 1; // 距最近前景的距离
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

/* 降采样灰度 → 高通（原图 - 盒式模糊），返回 |hp| 图 */
function buildEnergy(imgCanvas) {
  const k = Math.min(1, ENERGY_MAX / Math.max(imgCanvas.width, imgCanvas.height));
  const W = Math.max(16, Math.round(imgCanvas.width * k));
  const H = Math.max(16, Math.round(imgCanvas.height * k));
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(imgCanvas, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;
  const g = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) g[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;

  const r = 4; // 高通半径
  const IW = W + 1;
  const integ = new Float64Array(IW * (H + 1));
  for (let y = 0; y < H; y++) {
    let s = 0;
    for (let x = 0; x < W; x++) {
      s += g[y * W + x];
      integ[(y + 1) * IW + x + 1] = integ[y * IW + x + 1] + s;
    }
  }
  const hp = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(H - 1, y + r);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(W - 1, x + r);
      const a = y0 * IW + x0, b = y0 * IW + x1 + 1, c = (y1 + 1) * IW + x0, e = (y1 + 1) * IW + x1 + 1;
      const mean = (integ[e] - integ[b] - integ[c] + integ[a]) / ((x1 - x0 + 1) * (y1 - y0 + 1));
      hp[y * W + x] = Math.abs(g[y * W + x] - mean);
    }
  }
  return { hp, W, H, k };
}

/* 原图坐标区域的平均能量（映射到能量图） */
function regionEnergy(energy, x, y, w, h, imgW, imgH) {
  x = Math.max(0, Math.min(imgW - 1, x));
  y = Math.max(0, Math.min(imgH - 1, y));
  w = Math.max(1, Math.min(imgW - x, w));
  h = Math.max(1, Math.min(imgH - y, h));
  const { hp, W, H, k } = energy;
  const x0 = Math.floor(x * k), y0 = Math.floor(y * k);
  const x1 = Math.min(W - 1, Math.ceil((x + w) * k));
  const y1 = Math.min(H - 1, Math.ceil((y + h) * k));
  let sum = 0, n = 0;
  for (let yy = y0; yy <= y1; yy++) {
    for (let xx = x0; xx <= x1; xx++) { sum += hp[yy * W + xx]; n++; }
  }
  return n ? sum / n : 0;
}
