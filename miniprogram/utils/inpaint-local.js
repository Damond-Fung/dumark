/* 源图 Dumark 小程序 — 端上轻量修复引擎
 * 小程序无法运行 200MB 的 LaMa 模型，这里用「多尺度调和填充」重建背景：
 * 由粗到细逐级求解 mask 区域的拉普拉斯方程（与周围像素平滑衔接），
 * 对纯色 / 渐变 / 简单纹理背景效果好，速度快、无需联网。
 * 与电脑版保持同一套调用方式：输入 ROI 像素 + mask，输出修复后的 ROI 像素。
 */

/* rgba: Uint8ClampedArray（ROI），mask: Uint8Array 0/1（ROI），返回修复后的 RGBA */
export function fillRegion(rgba, mask, w, h) {
  const out = new Uint8ClampedArray(rgba.length);
  out.set(rgba);
  let maskedCount = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) maskedCount++;
  if (!maskedCount) return out;

  // 顶部（最细）层级
  const levels = [buildLevel(rgba, mask, w, h)];
  while (levels[0].w > 32 && levels[0].h > 32) {
    const prev = levels[0];
    levels.unshift(downsample(prev));
  }

  // 由粗到细：粗层用最近有效像素初始化后迭代，再逐级上采样 + 迭代
  const coarsest = levels[0];
  initNearest(coarsest);
  solve(coarsest, 60);

  let current = coarsest;
  for (let i = 1; i < levels.length; i++) {
    const lv = levels[i];
    upsampleInto(current, lv);
    solve(lv, i === levels.length - 1 ? 18 : 28);
    current = lv;
  }

  // 写回 RGBA（保留原 alpha）
  const fine = current;
  for (let i = 0; i < fine.w * fine.h; i++) {
    if (!fine.mask[i]) continue;
    out[i * 4] = clamp255(fine.rgb[i * 3]);
    out[i * 4 + 1] = clamp255(fine.rgb[i * 3 + 1]);
    out[i * 4 + 2] = clamp255(fine.rgb[i * 3 + 2]);
  }
  return out;
}

function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function buildLevel(rgba, mask, w, h) {
  const rgb = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    rgb[i * 3] = rgba[i * 4];
    rgb[i * 3 + 1] = rgba[i * 4 + 1];
    rgb[i * 3 + 2] = rgba[i * 4 + 2];
  }
  return { w, h, rgb, mask: new Uint8Array(mask) };
}

/* 2×2 平均降采样；只要有一个子像素被 mask，粗像素即视为待修复 */
function downsample(lv) {
  const w = Math.max(1, Math.floor(lv.w / 2));
  const h = Math.max(1, Math.floor(lv.h / 2));
  const rgb = new Float32Array(w * h * 3);
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = x * 2, sy = y * 2;
      let r = 0, g = 0, b = 0, n = 0, anyMask = 0;
      for (let dy = 0; dy < 2; dy++) {
        const yy = sy + dy;
        if (yy >= lv.h) continue;
        for (let dx = 0; dx < 2; dx++) {
          const xx = sx + dx;
          if (xx >= lv.w) continue;
          const si = yy * lv.w + xx;
          if (lv.mask[si]) { anyMask = 1; continue; }
          r += lv.rgb[si * 3]; g += lv.rgb[si * 3 + 1]; b += lv.rgb[si * 3 + 2]; n++;
        }
      }
      const di = y * w + x;
      if (n > 0) {
        rgb[di * 3] = r / n; rgb[di * 3 + 1] = g / n; rgb[di * 3 + 2] = b / n;
      } else {
        // 全为待修复像素：用全图有效均值兜底，后续迭代会修正
        rgb[di * 3] = 0; rgb[di * 3 + 1] = 0; rgb[di * 3 + 2] = 0;
      }
      mask[di] = anyMask;
    }
  }
  return { w, h, rgb, mask };
}

/* 最近有效像素初始化：从 mask 边界向内 BFS 扩散，避免迭代从纯黑起步收敛过慢 */
function initNearest(lv) {
  const { w, h, rgb, mask } = lv;
  const known = new Uint8Array(w * h);
  const queue = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (mask[i]) continue;
      known[i] = 1;
      queue.push(i);
    }
  }
  if (!queue.length) {
    // 整块都在 mask 内（异常）：用中性灰
    for (let i = 0; i < w * h; i++) { rgb[i * 3] = 128; rgb[i * 3 + 1] = 128; rgb[i * 3 + 2] = 128; }
    return;
  }
  // 多源 BFS：每个待修复像素取最早触达的有效邻居颜色
  let head = 0;
  let filled = 0;
  const totalMasked = mask.reduce((s, v) => s + v, 0);
  while (head < queue.length && filled < totalMasked) {
    const ci = queue[head++];
    const cx = ci % w, cy = (ci / w) | 0;
    const nbs = [ci - 1, ci + 1, ci - w, ci + w];
    for (const ni of nbs) {
      if (ni < 0 || ni >= w * h) continue;
      const nx = ni % w;
      if (Math.abs(nx - cx) > 1) continue;
      if (known[ni]) continue;
      rgb[ni * 3] = rgb[ci * 3];
      rgb[ni * 3 + 1] = rgb[ci * 3 + 1];
      rgb[ni * 3 + 2] = rgb[ci * 3 + 2];
      known[ni] = 1;
      filled++;
      queue.push(ni);
    }
  }
}

/* 高斯-赛德尔迭代：待修复像素向四邻域均值收敛（有效像素保持原值） */
function solve(lv, iterations) {
  const { w, h, rgb, mask } = lv;
  const idx = [];
  for (let i = 0; i < w * h; i++) if (mask[i]) idx.push(i);
  if (!idx.length) return;
  for (let it = 0; it < iterations; it++) {
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k];
      const x = i % w;
      let r = 0, g = 0, b = 0, n = 0;
      if (x > 0) { const j = i - 1; r += rgb[j * 3]; g += rgb[j * 3 + 1]; b += rgb[j * 3 + 2]; n++; }
      if (x < w - 1) { const j = i + 1; r += rgb[j * 3]; g += rgb[j * 3 + 1]; b += rgb[j * 3 + 2]; n++; }
      if (i - w >= 0) { const j = i - w; r += rgb[j * 3]; g += rgb[j * 3 + 1]; b += rgb[j * 3 + 2]; n++; }
      if (i + w < w * h) { const j = i + w; r += rgb[j * 3]; g += rgb[j * 3 + 1]; b += rgb[j * 3 + 2]; n++; }
      if (!n) continue;
      rgb[i * 3] = r / n; rgb[i * 3 + 1] = g / n; rgb[i * 3 + 2] = b / n;
    }
  }
}

/* 双线性上采样父层结果作为细层初值 */
function upsampleInto(parent, child) {
  const { w, h, rgb, mask } = child;
  const pw = parent.w, ph = parent.h;
  for (let y = 0; y < h; y++) {
    const sy = Math.min(ph - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
    const y0 = Math.floor(sy), y1 = Math.min(ph - 1, y0 + 1);
    const wy = sy - y0;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      const sx = Math.min(pw - 1, Math.max(0, (x + 0.5) / 2 - 0.5));
      const x0 = Math.floor(sx), x1 = Math.min(pw - 1, x0 + 1);
      const wx = sx - x0;
      const i00 = (y0 * pw + x0) * 3, i10 = (y0 * pw + x1) * 3;
      const i01 = (y1 * pw + x0) * 3, i11 = (y1 * pw + x1) * 3;
      for (let c = 0; c < 3; c++) {
        const top = rgb[i00 + c] * (1 - wx) + rgb[i10 + c] * wx;
        const bottom = rgb[i01 + c] * (1 - wx) + rgb[i11 + c] * wx;
        rgb[i * 3 + c] = top * (1 - wy) + bottom * wy;
      }
    }
  }
}
