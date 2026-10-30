/* 源图 Dumark 小程序 — 修复编排
 * 与电脑版 scripts/inpaint.js 相同的分区域策略：
 *   手动涂抹 → mask 外接矩形 ROI；自动检测 → 相邻检测框合并成组后逐组修复；
 *   修复结果以羽化 mask 为 alpha 写回原图，其余区域保持像素无损。
 * 差异仅在推理后端：小程序使用端上轻量引擎（utils/inpaint-local.js）。
 */
import { REPAIR } from './config.js';
import { groupRects, roiFromRect, maskBBox, roiHasMask } from './region.js';
import { fillRegion } from './inpaint-local.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* imgData / maskData 为整图 ImageData；rects 为检测框（可为空）
 * 返回修复后的整图 Uint8ClampedArray；无有效修复区返回 null */
export async function repairImage(imgData, maskData, rects, onProgress) {
  const W = imgData.width, H = imgData.height;
  let rois;
  if (rects && rects.length) {
    rois = groupRects(rects, W, H, REPAIR.roiPad, REPAIR.maxGroupSide);
  } else {
    const bbox = maskBBox(maskData, W, H);
    if (!bbox) return null;
    rois = [roiFromRect(bbox, W, H, REPAIR.roiPad)];
  }
  rois = rois.filter((roi) => roi.s > 4 && roiHasMask(maskData, roi));
  if (!rois.length) return null;

  const work = new Uint8ClampedArray(imgData.data);
  const total = rois.length;
  for (let i = 0; i < total; i++) {
    if (onProgress) onProgress(Math.round(i / total * 90), '修复区域 ' + (i + 1) + ' / ' + total);
    const roi = rois[i];
    const sub = extractRoi(work, maskData, W, roi);
    const patch = fillRegion(sub.rgba, sub.mask, roi.s, roi.s);
    blendRoi(work, patch, sub.alpha, W, roi, REPAIR.feather);
    await sleep(0); // 让出主线程，保持加载动画流畅
  }
  if (onProgress) onProgress(100, '修复完成');
  return work;
}

/* 取出 ROI 的 RGBA / 0-1 mask / 原始 alpha */
function extractRoi(work, maskData, W, roi) {
  const s = roi.s;
  const rgba = new Uint8ClampedArray(s * s * 4);
  const mask = new Uint8Array(s * s);
  const alpha = new Float32Array(s * s);
  const md = maskData.data;
  for (let y = 0; y < s; y++) {
    const srcRow = ((roi.y + y) * W + roi.x) * 4;
    const dstRow = y * s * 4;
    rgba.set(work.subarray(srcRow, srcRow + s * 4), dstRow);
    for (let x = 0; x < s; x++) {
      const a = md[srcRow + x * 4 + 3];
      const i = y * s + x;
      alpha[i] = a;
      mask[i] = a > 10 ? 1 : 0;
    }
  }
  return { rgba, mask, alpha };
}

/* 羽化 mask + 按 alpha 混合修复结果 */
function blendRoi(work, patch, alpha, W, roi, feather) {
  const s = roi.s;
  const soft = featherAlpha(alpha, s, s, feather);
  for (let y = 0; y < s; y++) {
    const row = ((roi.y + y) * W + roi.x) * 4;
    for (let x = 0; x < s; x++) {
      const i = y * s + x;
      const a = soft[i];
      if (a <= 0) continue;
      const p = row + x * 4;
      work[p] = work[p] * (1 - a) + patch[i * 4] * a;
      work[p + 1] = work[p + 1] * (1 - a) + patch[i * 4 + 1] * a;
      work[p + 2] = work[p + 2] * (1 - a) + patch[i * 4 + 2] * a;
    }
  }
}

/* 可分离盒式模糊 alpha（近似高斯羽化），输出 0-1 权重 */
function featherAlpha(alpha, w, h, radius) {
  if (radius <= 0) {
    const out = new Float32Array(w * h);
    for (let i = 0; i < out.length; i++) out[i] = alpha[i] / 255;
    return out;
  }
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  boxPass(alpha, tmp, w, h, true, radius);
  boxPass(tmp, out, w, h, false, radius);
  for (let i = 0; i < out.length; i++) out[i] = Math.min(1, out[i] / 255);
  return out;
}

function boxPass(src, dst, w, h, horizontal, r) {
  const len = horizontal ? w : h;
  const outer = horizontal ? h : w;
  for (let o = 0; o < outer; o++) {
    let sum = 0, count = 0;
    const base = horizontal ? o * w : o;
    for (let k = -r; k <= r; k++) {
      const t = Math.min(len - 1, Math.max(0, k));
      const idx = horizontal ? base + t : t * w + base;
      sum += src[idx]; count++;
    }
    for (let k = 0; k < len; k++) {
      const idx = horizontal ? base + k : k * w + base;
      dst[idx] = sum / count;
      const add = Math.min(len - 1, Math.max(0, k + r + 1));
      const rem = Math.min(len - 1, Math.max(0, k - r));
      sum += src[horizontal ? base + add : add * w + base]
        - src[horizontal ? base + rem : rem * w + base];
    }
  }
}
