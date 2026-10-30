/* 源图 Dumark — 文本检测客户端（DBNet / PP-OCRv4）
 * 预处理：等比缩放（长边 ≤2048，取整到 32 倍数）→ ImageNet 标准化 → NCHW
 * 后处理：概率图二值化 → 膨胀 → 连通域 → 分数过滤 → unclip 扩框 → 映射回原图
 * 水印绝大多数是文字/文字 Logo，OCR 文本检测对任意颜色、任意透明度的文字水印都稳健。
 */
const MAX_SIDE = 2048;   // 检测分辨率（画布上限 2048，即原生分辨率送检，小字水印不丢失）
/* 灵敏度分档：高=阈值低漏检最少（可能误标，可橡皮擦除），低=只留高置信框 */
const SENS = {
  low:  { thresh: 0.25, box: 0.45 },
  mid:  { thresh: 0.20, box: 0.35 },
  high: { thresh: 0.15, box: 0.30 },
};
const DEFAULT_SENS = 'mid';
const UNCLIP = 1.6;      // 外扩比例（覆盖文字描边）
const MAX_BOXES = 200;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

export class DetectClient {
  constructor(callbacks) {
    this.cb = callbacks || {};
    this.worker = new Worker('scripts/detect.worker.js');
    this.ready = false;
    this._pending = null;
    this.worker.onmessage = (e) => this._onMessage(e);
    this.worker.onerror = (e) => this._onError(e.message || '检测 Worker 异常');
  }

  init(modelUrl) {
    const preferWebGPU = typeof navigator !== 'undefined' && !!navigator.gpu;
    this.worker.postMessage({ type: 'init', modelUrl, preferWebGPU });
  }

  _onMessage(e) {
    const m = e.data || {};
    if (m.type === 'progress' && this.cb.onProgress) this.cb.onProgress(m);
    else if (m.type === 'ready') { this.ready = true; this.cb.onReady && this.cb.onReady(m); }
    else if (m.type === 'error') this._onError(m.text);
    else if (m.type === 'boxes' && this._pending) {
      const p = this._pending;
      this._pending = null;
      p.resolve(m);
    }
  }

  _onError(text) {
    if (this._pending) { this._pending.reject(new Error(text)); this._pending = null; }
    this.cb.onError && this.cb.onError(text);
  }

  /* 输入原图画布，返回原图坐标系下的检测框 [{x,y,w,h,conf}]
   * 双路检测：原图一路 + USM 锐化增强一路（放大半透明/低对比水印的模型响应），
   * 两路结果按重叠度合并。opts.sensitivity: 'low' | 'mid' | 'high'，默认 mid */
  async detect(imageCanvas, opts) {
    if (!this.ready) throw new Error('检测模型尚未就绪');
    if (this._pending) throw new Error('已有检测任务进行中');

    const sens = SENS[(opts && opts.sensitivity) || DEFAULT_SENS];
    const prep = this._preprocess(imageCanvas);
    const result = await this._infer(prep);
    let boxes = this._postprocess(result, prep, sens);

    // 第二路：锐化增强图用高灵敏度档召回弱水印（canvas filter 不可用时跳过）
    const sharp = this._sharpen(imageCanvas, 1.2, 2);
    if (sharp) {
      const prep2 = this._preprocess(sharp);
      const result2 = await this._infer(prep2);
      boxes = this._mergeBoxes(boxes, this._postprocess(result2, prep2, SENS.high));
    }
    return boxes;
  }

  /* 跑一次 Worker 推理 */
  _infer(prep) {
    return new Promise((resolve, reject) => {
      this._pending = { resolve, reject };
      this.worker.postMessage(
        { type: 'detect', imgArr: prep.tensor.buffer, h: prep.h, w: prep.w },
        [prep.tensor.buffer],
      );
    });
  }

  /* USM 锐化：out = img + amount × (img − blur(img))，增强弱边缘对比度 */
  _sharpen(canvas, amount, radius) {
    const probe = document.createElement('canvas').getContext('2d');
    if (typeof probe.filter !== 'string') return null;
    const W = canvas.width, H = canvas.height;
    const blurred = document.createElement('canvas');
    blurred.width = W; blurred.height = H;
    const bCtx = blurred.getContext('2d', { willReadFrequently: true });
    bCtx.filter = 'blur(' + radius + 'px)';
    bCtx.drawImage(canvas, 0, 0);
    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    const oCtx = out.getContext('2d', { willReadFrequently: true });
    oCtx.drawImage(canvas, 0, 0);
    const src = oCtx.getImageData(0, 0, W, H);
    const blr = bCtx.getImageData(0, 0, W, H);
    const d = src.data, b = blr.data;
    for (let i = 0; i < d.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const v = d[i + c] + amount * (d[i + c] - b[i + c]);
        d[i + c] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
    oCtx.putImageData(src, 0, 0);
    // 修复模糊在画布边缘的黑边伪影：USM 会把边缘亮边放大成「假文字带」，
    // 用原图边带覆盖回去（带宽 = 模糊半径×3+2，覆盖伪影影响范围）
    const s = Math.min(W, H, radius * 3 + 2);
    oCtx.drawImage(canvas, 0, 0, W, s, 0, 0, W, s);
    oCtx.drawImage(canvas, 0, H - s, W, s, 0, H - s, W, s);
    oCtx.drawImage(canvas, 0, 0, s, H, 0, 0, s, H);
    oCtx.drawImage(canvas, W - s, 0, s, H, W - s, 0, s, H);
    return out;
  }

  /* 双路结果合并：重叠框（IoU > 0.2）取并集 + 最高置信度，其余直接保留 */
  _mergeBoxes(primary, extra) {
    const out = primary.slice();
    for (const bb of extra) {
      let hit = null;
      for (const o of out) {
        const ix = Math.max(0, Math.min(o.x + o.w, bb.x + bb.w) - Math.max(o.x, bb.x));
        const iy = Math.max(0, Math.min(o.y + o.h, bb.y + bb.h) - Math.max(o.y, bb.y));
        const inter = ix * iy;
        if (inter && inter / (o.w * o.h + bb.w * bb.h - inter) > 0.2) { hit = o; break; }
      }
      if (hit) {
        const x2 = Math.max(hit.x + hit.w, bb.x + bb.w);
        const y2 = Math.max(hit.y + hit.h, bb.y + bb.h);
        hit.x = Math.min(hit.x, bb.x); hit.y = Math.min(hit.y, bb.y);
        hit.w = x2 - hit.x; hit.h = y2 - hit.y;
        hit.conf = Math.max(hit.conf, bb.conf);
      } else {
        out.push(bb);
      }
    }
    return out;
  }

  /* 等比缩放 + 32 对齐 + ImageNet 标准化，打包 RGB CHW */
  _preprocess(imageCanvas) {
    const W = imageCanvas.width, H = imageCanvas.height;
    const ratio = Math.min(1, MAX_SIDE / Math.max(W, H));
    const rw = Math.max(32, Math.round(W * ratio / 32) * 32);
    const rh = Math.max(32, Math.round(H * ratio / 32) * 32);

    const c = document.createElement('canvas');
    c.width = rw; c.height = rh;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(imageCanvas, 0, 0, rw, rh);

    const px = ctx.getImageData(0, 0, rw, rh).data;
    const n = rw * rh;
    const tensor = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) {
      tensor[i] = (px[i * 4] / 255 - MEAN[0]) / STD[0];
      tensor[n + i] = (px[i * 4 + 1] / 255 - MEAN[1]) / STD[1];
      tensor[2 * n + i] = (px[i * 4 + 2] / 255 - MEAN[2]) / STD[2];
    }
    return { tensor, w: rw, h: rh, scaleX: W / rw, scaleY: H / rh, imgW: W, imgH: H };
  }

  /* 概率图 → 二值化膨胀 → 连通域 → unclip → 原图坐标 */
  _postprocess(result, prep, sens) {
    const prob = new Float32Array(result.outArr);
    const rw = result.w, rh = result.h;
    const n = rw * rh;

    // 二值化 + 2×2 膨胀（合并断裂的笔画碎片）
    const bin = new Uint8Array(n);
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        const i = y * rw + x;
        if (prob[i] <= sens.thresh) continue;
        bin[i] = 1;
        if (x + 1 < rw) bin[i + 1] = 1;
        if (y + 1 < rh) { bin[i + rw] = 1; if (x + 1 < rw) bin[i + rw + 1] = 1; }
      }
    }

    // 连通域（4-连通 BFS）
    const visited = new Uint8Array(n);
    const boxes = [];
    for (let s = 0; s < n; s++) {
      if (!bin[s] || visited[s]) continue;
      const stack = [s];
      visited[s] = 1;
      let minX = rw, minY = rh, maxX = -1, maxY = -1, count = 0, scoreSum = 0;
      while (stack.length) {
        const ci = stack.pop();
        const cx = ci % rw, cy = (ci / rw) | 0;
        count++; scoreSum += prob[ci];
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        if (cx > 0 && bin[ci - 1] && !visited[ci - 1]) { visited[ci - 1] = 1; stack.push(ci - 1); }
        if (cx < rw - 1 && bin[ci + 1] && !visited[ci + 1]) { visited[ci + 1] = 1; stack.push(ci + 1); }
        if (cy > 0 && bin[ci - rw] && !visited[ci - rw]) { visited[ci - rw] = 1; stack.push(ci - rw); }
        if (cy < rh - 1 && bin[ci + rw] && !visited[ci + rw]) { visited[ci + rw] = 1; stack.push(ci + rw); }
      }
      const bw = maxX - minX + 1, bh = maxY - minY + 1;
      if (Math.min(bw, bh) < 3) continue;
      const score = scoreSum / count;
      if (score < sens.box) continue;

      // unclip：按面积/周长外扩，覆盖文字边缘
      const d = (count * UNCLIP) / (2 * (bw + bh));
      let x = Math.max(0, minX - d), y = Math.max(0, minY - d);
      let x2 = Math.min(rw - 1, maxX + d), y2 = Math.min(rh - 1, maxY + d);

      // 映射回原图坐标
      let bx = Math.round(x * prep.scaleX);
      let by = Math.round(y * prep.scaleY);
      let bw2 = Math.round((x2 - x + 1) * prep.scaleX);
      let bh2 = Math.round((y2 - y + 1) * prep.scaleY);
      // 适度外扩：像素级精修只标记框内与背景差异大的像素，
      // 无需整框填满时代的大扩边，避免框内圈入过多背景纹理被误标。
      const padY = Math.min(24, Math.max(6, Math.round(bh2 * 0.15)));
      const padX = Math.min(20, Math.max(6, Math.round(bh2 * 0.12)));
      bx = Math.max(0, bx - padX);
      by = Math.max(0, by - padY);
      bw2 = Math.min(prep.imgW - bx, bw2 + padX * 2);
      bh2 = Math.min(prep.imgH - by, bh2 + padY * 2);
      boxes.push({ x: bx, y: by, w: bw2, h: bh2, conf: Math.round(score * 100) / 100 });
    }

    // 按面积降序截断，过滤被包含的重复框
    boxes.sort((a, b) => b.w * b.h - a.w * a.h);
    const kept = [];
    for (const b of boxes) {
      if (kept.length >= MAX_BOXES) break;
      let contained = false;
      for (const k of kept) {
        if (b.x >= k.x && b.y >= k.y && b.x + b.w <= k.x + k.w && b.y + b.h <= k.y + k.h) { contained = true; break; }
      }
      if (!contained) kept.push(b);
    }
    return kept;
  }
}
