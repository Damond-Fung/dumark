/* 源图 Dumark 小程序 — 修复区域规划
 * 与电脑版 scripts/inpaint.js 的 ROI 策略完全一致：
 *   手动涂抹 → mask 外接矩形；
 *   自动检测 → 相邻检测框合并成组，组内 ROI 边长不超过 maxGroupSide。
 * ROI 一律扩边 + 方形化 + 边界裁剪，避免分块接缝。
 */

/* mask 外接矩形（maskData 为画布 ImageData，按 alpha 判断） */
export function maskBBox(maskData, W, H) {
  const d = maskData.data;
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let y = 0; y < H; y++) {
    let p = (y * W) * 4 + 3;
    for (let x = 0; x < W; x++, p += 4) {
      if (d[p] > 10) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/* 任意矩形 → ROI（扩边 + 方形化 + 边界裁剪） */
export function roiFromRect(rect, W, H, pad) {
  const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
  const side = Math.min(Math.max(rect.w, rect.h) + pad * 2, W, H);
  const sx = Math.round(Math.min(Math.max(cx - side / 2, 0), W - side));
  const sy = Math.round(Math.min(Math.max(cy - side / 2, 0), H - side));
  return { x: sx, y: sy, s: side };
}

function unionRect(a, b) {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  const x2 = Math.max(a.x + a.w, b.x + b.w), y2 = Math.max(a.y + a.h, b.y + b.h);
  return { x, y, w: x2 - x, h: y2 - y };
}

/* 检测框分组合并：并集 ROI 边长不超上限的框归为一组，减少修复次数 */
export function groupRects(rects, W, H, pad, maxGroupSide) {
  const sorted = rects.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const groups = [];
  for (const r of sorted) {
    let placed = false;
    for (const g of groups) {
      const u = unionRect(g.bbox, r);
      if (Math.max(u.w, u.h) + pad * 2 <= maxGroupSide) {
        g.bbox = u;
        placed = true;
        break;
      }
    }
    if (!placed) groups.push({ bbox: { x: r.x, y: r.y, w: r.w, h: r.h } });
  }
  return groups.map((g) => roiFromRect(g.bbox, W, H, pad));
}

/* ROI 内是否存在 mask 像素 */
export function roiHasMask(maskData, roi) {
  const { data, width: W } = maskData;
  for (let y = roi.y; y < roi.y + roi.s; y++) {
    let p = (y * W + roi.x) * 4 + 3;
    for (let x = 0; x < roi.s; x++, p += 4) {
      if (data[p] > 10) return true;
    }
  }
  return false;
}
