/* 源图 Dumark — 推理客户端
 * 负责：与 Worker 通信、mask ROI 裁剪、张量打包/解包、结果原位合成
 * 策略：
 *  - 单区域：mask 外接矩形（方形化 + 扩边）缩放到 512×512 送模型；
 *  - 多区域（自动检测）：按检测框分组合并，每组在接近原生分辨率下逐一修复，
 *    避免整图强压 512 导致的画质损失；
 *  - 修复结果以羽化 mask 为 alpha 写回原图，其余区域无损。
 */
const INFER_SIZE = 512;
const ROI_PAD = 64;
const MAX_GROUP_SIDE = 640; // 分组合并后的 ROI 边长上限（超过则拆分为独立修复）
const MASK_FEATHER = 2;     // 合成时 mask 边缘羽化半径（像素）

export class InpaintClient {
  constructor(callbacks) {
    this.cb = callbacks || {};
    this.worker = new Worker('scripts/inpaint.worker.js');
    this.ready = false;
    this._pending = null;
    this.worker.onmessage = (e) => this._onMessage(e);
    this.worker.onerror = (e) => this._onError(e.message || 'Worker 异常');
  }

  init(modelUrl) {
    const preferWebGPU = typeof navigator !== 'undefined' && !!navigator.gpu;
    this.worker.postMessage({ type: 'init', modelUrl, size: INFER_SIZE, preferWebGPU });
  }

  _onMessage(e) {
    const m = e.data || {};
    if (m.type === 'progress' && this.cb.onProgress) this.cb.onProgress(m);
    else if (m.type === 'ready') { this.ready = true; this.cb.onReady && this.cb.onReady(m); }
    else if (m.type === 'error') this._onError(m.text);
    else if (m.type === 'result' && this._pending) {
      const p = this._pending;
      this._pending = null;
      p.resolve(m);
    }
  }

  _onError(text) {
    if (this._pending) { this._pending.reject(new Error(text)); this._pending = null; }
    this.cb.onError && this.cb.onError(text);
  }

  /* 整 mask 单 ROI 修复（手动涂抹路径）。返回合成后的 result canvas，mask 为空返回 null。 */
  async run(imageCanvas, maskCanvas) {
    return this._runOnce(imageCanvas, maskCanvas, null);
  }

  /* 多区域修复（自动检测路径）：检测框分组合并 → 逐组原生比例修复 → 累积合成 */
  async runRegions(imageCanvas, maskCanvas, rects) {
    if (!this.ready) throw new Error('模型尚未就绪');
    const W = imageCanvas.width, H = imageCanvas.height;
    const rois = this._groupRects(rects, W, H);
    if (!rois.length) return null;

    // 累积工作画布
    let work = document.createElement('canvas');
    work.width = W; work.height = H;
    work.getContext('2d').drawImage(imageCanvas, 0, 0);

    let done = 0;
    for (const roi of rois) {
      if (this.cb.onProgress) {
        this.cb.onProgress({ pct: Math.round(done / rois.length * 90), label: '修复区域 ' + (done + 1) + ' / ' + rois.length + '…' });
      }
      const next = await this._runOnce(work, maskCanvas, roi);
      if (next) work = next;
      done++;
    }
    return done ? work : null;
  }

  /* 单次修复：prepare → worker → composite。roi 为空时取整个 mask 的外接矩形。 */
  async _runOnce(imageCanvas, maskCanvas, roi) {
    if (!this.ready) throw new Error('模型尚未就绪');
    if (this._pending) throw new Error('已有修复任务进行中');

    const prep = this._prepare(imageCanvas, maskCanvas, roi);
    if (!prep) return null; // 该 ROI 内无 mask 像素

    const msg = {
      type: 'run', size: INFER_SIZE,
      imgArr: prep.img.buffer, maskArr: prep.mask.buffer,
    };
    const result = await new Promise((resolve, reject) => {
      this._pending = { resolve, reject };
      this.worker.postMessage(msg, [msg.imgArr, msg.maskArr]);
    });
    return this._composite(imageCanvas, maskCanvas, prep.roi, result);
  }

  /* mask 外接矩形 → ROI（扩边 + 方形化 + 边界裁剪） */
  _roiFromMask(maskCanvas, W, H) {
    const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });
    const mData = maskCtx.getImageData(0, 0, W, H).data;
    let minX = W, minY = H, maxX = -1, maxY = -1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (mData[(y * W + x) * 4 + 3] > 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    return this._roiFromRect({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }, W, H);
  }

  /* 任意矩形 → ROI（扩边 + 方形化 + 边界裁剪） */
  _roiFromRect(rect, W, H) {
    const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
    const side = Math.min(Math.max(rect.w, rect.h) + ROI_PAD * 2, W, H);
    const sx = Math.round(Math.min(Math.max(cx - side / 2, 0), W - side));
    const sy = Math.round(Math.min(Math.max(cy - side / 2, 0), H - side));
    return { x: sx, y: sy, s: side };
  }

  /* 检测框分组合并：并集 ROI 边长不超上限的框归为一组，减少推理次数 */
  _groupRects(rects, W, H) {
    const sorted = rects.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));
    const groups = [];
    for (const r of sorted) {
      let placed = false;
      for (const g of groups) {
        const u = this._union(g.bbox, r);
        if (Math.max(u.w, u.h) + ROI_PAD * 2 <= MAX_GROUP_SIDE) {
          g.bbox = u; g.items.push(r); placed = true; break;
        }
      }
      if (!placed) groups.push({ bbox: { x: r.x, y: r.y, w: r.w, h: r.h }, items: [r] });
    }
    return groups.map((g) => this._roiFromRect(g.bbox, W, H));
  }

  _union(a, b) {
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    const x2 = Math.max(a.x + a.w, b.x + b.w), y2 = Math.max(a.y + a.h, b.y + b.h);
    return { x, y, w: x2 - x, h: y2 - y };
  }

  /* ROI → 裁剪缩放 → 打包 NCHW 张量。roi 为空时自动取 mask 外接矩形。 */
  _prepare(imageCanvas, maskCanvas, roi) {
    const w = imageCanvas.width, h = imageCanvas.height;
    if (!roi) {
      roi = this._roiFromMask(maskCanvas, w, h);
      if (!roi) return null;
    } else if (!this._roiHasMask(maskCanvas, roi)) {
      return null;
    }

    const imgSmall = document.createElement('canvas');
    imgSmall.width = imgSmall.height = INFER_SIZE;
    const iCtx = imgSmall.getContext('2d', { willReadFrequently: true });
    iCtx.drawImage(imageCanvas, roi.x, roi.y, roi.s, roi.s, 0, 0, INFER_SIZE, INFER_SIZE);

    const maskSmall = document.createElement('canvas');
    maskSmall.width = maskSmall.height = INFER_SIZE;
    const mCtx = maskSmall.getContext('2d', { willReadFrequently: true });
    mCtx.imageSmoothingEnabled = false; // 稀疏像素 mask 禁插值，防止细化笔迹被稀释消失
    mCtx.drawImage(maskCanvas, roi.x, roi.y, roi.s, roi.s, 0, 0, INFER_SIZE, INFER_SIZE);

    const px = iCtx.getImageData(0, 0, INFER_SIZE, INFER_SIZE).data;
    const mp = mCtx.getImageData(0, 0, INFER_SIZE, INFER_SIZE).data;
    const n = INFER_SIZE * INFER_SIZE;
    const img = new Float32Array(3 * n);
    const mask = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      img[i] = px[i * 4] / 255;
      img[n + i] = px[i * 4 + 1] / 255;
      img[2 * n + i] = px[i * 4 + 2] / 255;
      mask[i] = mp[i * 4 + 3] > 128 ? 1 : 0;
    }
    return { img, mask, roi };
  }

  /* 快速判断 ROI 内是否存在 mask 像素（抽样扫描） */
  _roiHasMask(maskCanvas, roi) {
    const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });
    const d = maskCtx.getImageData(roi.x, roi.y, roi.s, roi.s).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
    return false;
  }

  /* 把 512² 输出贴回 ROI，以羽化 mask 为 alpha 写回原图 */
  _composite(imageCanvas, maskCanvas, roi, result) {
    const n = INFER_SIZE * INFER_SIZE;
    const out = new Float32Array(result.outArr);

    // 该模型输出可能为 [0,1] 或 [0,255]，按最大值自适应（参考 nezumi-inpaint 的处理）
    let max = 0;
    for (let i = 0; i < out.length; i++) if (out[i] > max) max = out[i];
    const scale = max <= 1.01 ? 255 : 1;

    const outCanvas = document.createElement('canvas');
    outCanvas.width = outCanvas.height = INFER_SIZE;
    const oCtx = outCanvas.getContext('2d');
    const outImg = oCtx.createImageData(INFER_SIZE, INFER_SIZE);
    for (let i = 0; i < n; i++) {
      outImg.data[i * 4] = Math.max(0, Math.min(255, Math.round(out[i] * scale)));
      outImg.data[i * 4 + 1] = Math.max(0, Math.min(255, Math.round(out[n + i] * scale)));
      outImg.data[i * 4 + 2] = Math.max(0, Math.min(255, Math.round(out[2 * n + i] * scale)));
      outImg.data[i * 4 + 3] = 255;
    }
    oCtx.putImageData(outImg, 0, 0);

    // 羽化后的 mask（边缘半透明过渡，消除硬边接缝；不支持 filter 时退化为原 mask）
    const soft = document.createElement('canvas');
    soft.width = roi.s; soft.height = roi.s;
    const sCtx = soft.getContext('2d');
    try { sCtx.filter = 'blur(' + MASK_FEATHER + 'px)'; } catch (e) { /* 忽略 */ }
    sCtx.drawImage(maskCanvas, roi.x, roi.y, roi.s, roi.s, 0, 0, roi.s, roi.s);

    // 合成：原图 → 结果写回 ROI → 以羽化 mask 为 alpha 裁出修复区
    const merged = document.createElement('canvas');
    merged.width = imageCanvas.width; merged.height = imageCanvas.height;
    const g = merged.getContext('2d');
    g.drawImage(imageCanvas, 0, 0);

    const patch = document.createElement('canvas');
    patch.width = roi.s; patch.height = roi.s;
    const p = patch.getContext('2d');
    p.drawImage(outCanvas, 0, 0, INFER_SIZE, INFER_SIZE, 0, 0, roi.s, roi.s);
    p.globalCompositeOperation = 'destination-in';
    p.drawImage(soft, 0, 0);
    g.drawImage(patch, roi.x, roi.y);
    return merged;
  }
}
