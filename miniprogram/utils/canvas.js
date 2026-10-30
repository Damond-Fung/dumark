/* 源图 Dumark 小程序 — 画布工具
 * 统一封装离屏画布与尺寸计算，让检测/修复算法与电脑版保持同一套写法。
 */

/* 创建离屏 2D 画布（小程序基础库 2.16.1+ 支持） */
export function createCanvas(w, h) {
  return wx.createOffscreenCanvas({
    type: '2d',
    width: Math.max(1, Math.round(w)),
    height: Math.max(1, Math.round(h)),
  });
}

export function context(canvas) {
  return canvas.getContext('2d');
}

/* 读取整张画布的 ImageData */
export function readPixels(canvas) {
  return context(canvas).getImageData(0, 0, canvas.width, canvas.height);
}

/* 等比缩放到长边上限 */
export function fitWithin(w, h, maxSide) {
  const k = Math.min(1, maxSide / Math.max(w, h));
  return {
    width: Math.max(1, Math.round(w * k)),
    height: Math.max(1, Math.round(h * k)),
    scale: k,
  };
}

/* 等比适配到容器内（不放大） */
export function fitBox(w, h, boxW, boxH) {
  const k = Math.min(boxW / w, boxH / h, 1);
  return {
    width: Math.max(1, Math.round(w * k)),
    height: Math.max(1, Math.round(h * k)),
    scale: k,
  };
}

/* 灰度亮度（0-255） */
export function luminance(r, g, b) {
  return r * 0.299 + g * 0.587 + b * 0.114;
}

/* 区域平均降采样（纯 JS，避免依赖跨画布 drawImage 的平台差异） */
export function resizeImage(img, dw, dh) {
  const { data, width: W, height: H } = img;
  if (dw === W && dh === H) return img;
  if (dw < W || dh < H) {
    const out = new Uint8ClampedArray(dw * dh * 4);
    const sx = W / dw, sy = H / dh;
    for (let y = 0; y < dh; y++) {
      const y0 = Math.floor(y * sy);
      const y1 = Math.max(y0 + 1, Math.min(H, Math.floor((y + 1) * sy)));
      for (let x = 0; x < dw; x++) {
        const x0 = Math.floor(x * sx);
        const x1 = Math.max(x0 + 1, Math.min(W, Math.floor((x + 1) * sx)));
        let r = 0, g = 0, b = 0, a = 0, n = 0;
        for (let yy = y0; yy < y1; yy++) {
          let p = (yy * W + x0) * 4;
          for (let xx = x0; xx < x1; xx++, p += 4) {
            r += data[p]; g += data[p + 1]; b += data[p + 2]; a += data[p + 3]; n++;
          }
        }
        const q = (y * dw + x) * 4;
        out[q] = r / n; out[q + 1] = g / n; out[q + 2] = b / n; out[q + 3] = a / n;
      }
    }
    return { data: out, width: dw, height: dh };
  }
  // 放大的场景仅用于结果合成，使用最近邻即可
  const out = new Uint8ClampedArray(dw * dh * 4);
  const sx = W / dw, sy = H / dh;
  for (let y = 0; y < dh; y++) {
    const sy0 = Math.min(H - 1, Math.floor(y * sy));
    for (let x = 0; x < dw; x++) {
      const sx0 = Math.min(W - 1, Math.floor(x * sx));
      const q = (y * dw + x) * 4, p = (sy0 * W + sx0) * 4;
      out[q] = data[p]; out[q + 1] = data[p + 1]; out[q + 2] = data[p + 2]; out[q + 3] = data[p + 3];
    }
  }
  return { data: out, width: dw, height: dh };
}
