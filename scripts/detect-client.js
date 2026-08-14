/* 源图 Dumark — 文本检测客户端（DBNet / PP-OCRv4）
 * 预处理：等比缩放（长边 ≤736，取整到 32 倍数）→ ImageNet 标准化 → NCHW
 * 后处理：概率图二值化 → 膨胀 → 连通域 → 分数过滤 → unclip 扩框 → 映射回原图
 * 水印绝大多数是文字/文字 Logo，OCR 文本检测对任意颜色、任意透明度的文字水印都稳健。
 */
const MAX_SIDE = 960;    // 检测分辨率（密集小字需要更高输入分辨率）
const THRESH = 0.25;     // 概率图二值化阈值
const BOX_THRESH = 0.45; // 连通域平均分数下限
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

  /* 输入原图画布，返回原图坐标系下的检测框 [{x,y,w,h,conf}] */
  async detect(imageCanvas) {
    if (!this.ready) throw new Error('检测模型尚未就绪');
    if (this._pending) throw new Error('已有检测任务进行中');

    const prep = this._preprocess(imageCanvas);
    const result = await new Promise((resolve, reject) => {
      this._pending = { resolve, reject };
      this.worker.postMessage(
        { type: 'detect', imgArr: prep.tensor.buffer, h: prep.h, w: prep.w },
        [prep.tensor.buffer],
      );
    });
    return this._postprocess(result, prep);
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
  _postprocess(result, prep) {
    const prob = new Float32Array(result.outArr);
    const rw = result.w, rh = result.h;
    const n = rw * rh;

    // 二值化 + 2×2 膨胀（合并断裂的笔画碎片）
    const bin = new Uint8Array(n);
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        const i = y * rw + x;
        if (prob[i] <= THRESH) continue;
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
      if (score < BOX_THRESH) continue;

      // unclip：按面积/周长外扩，覆盖文字边缘
      const d = (count * UNCLIP) / (2 * (bw + bh));
      let x = Math.max(0, minX - d), y = Math.max(0, minY - d);
      let x2 = Math.min(rw - 1, maxX + d), y2 = Math.min(rh - 1, maxY + d);

      // 映射回原图坐标
      let bx = Math.round(x * prep.scaleX);
      let by = Math.round(y * prep.scaleY);
      let bw2 = Math.round((x2 - x + 1) * prep.scaleX);
      let bh2 = Math.round((y2 - y + 1) * prep.scaleY);
      // 关键：再向外扩边，确保 mask 完整覆盖文字（含抗锯齿描边）。
      // LaMa 的全局感受野会把 mask 外残留的笔画尖端「延伸」补全成文字，导致残留。
      const padY = Math.max(8, Math.round(bh2 * 0.4));
      const padX = Math.max(8, Math.round(bh2 * 0.3));
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
