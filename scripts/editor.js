/* 源图 Dumark — 涂抹编辑器
 * 三层画布：imgCanvas(原图/结果) / maskCanvas(涂抹层) / cursorCanvas(笔刷光标)
 * 支持画笔、橡皮、撤销、清空；画布以图片原始分辨率为基准，CSS 负责缩放显示。
 */
export class MaskEditor {
  constructor(stage, callbacks) {
    this.stage = stage;
    this.cb = callbacks || {};
    this.imgCanvas = stage.querySelector('#imgCanvas');
    this.maskCanvas = stage.querySelector('#maskCanvas');
    this.cursorCanvas = stage.querySelector('#cursorCanvas');
    this.imgCtx = this.imgCanvas.getContext('2d', { willReadFrequently: true });
    this.maskCtx = this.maskCanvas.getContext('2d', { willReadFrequently: true });
    this.curCtx = this.cursorCanvas.getContext('2d');
    this.mode = 'brush';       // 'brush' | 'eraser'
    this.brushSize = 36;
    this.painting = false;
    this.undoStack = [];
    this.hasMask = false;
    this._bindEvents();
  }

  loadImage(img) {
    const MAX = 2048; // 超出则等比缩小，控制内存与推理耗时
    let w = img.naturalWidth, h = img.naturalHeight;
    if (Math.max(w, h) > MAX) {
      const k = MAX / Math.max(w, h);
      w = Math.round(w * k); h = Math.round(h * k);
    }
    [this.imgCanvas, this.maskCanvas, this.cursorCanvas].forEach((c) => {
      c.width = w; c.height = h;
      c.style.width = ''; c.style.height = '';
    });
    this._fitToStage();
    this.imgCtx.drawImage(img, 0, 0, w, h);
    this.maskCtx.clearRect(0, 0, w, h);
    this.undoStack.length = 0;
    this.hasMask = false;
    this._emitMask();
    return { width: w, height: h };
  }

  /* 让画布在 stage 内完整显示（保持比例） */
  _fitToStage() {
    const rect = this.stage.getBoundingClientRect();
    const w = this.imgCanvas.width, h = this.imgCanvas.height;
    const scale = Math.min((rect.width - 24) / w, (rect.height - 24) / h, 1);
    [this.imgCanvas, this.maskCanvas, this.cursorCanvas].forEach((c) => {
      c.style.width = Math.round(w * scale) + 'px';
      c.style.height = Math.round(h * scale) + 'px';
    });
    this.scale = scale;
  }

  setMode(mode) { this.mode = mode; }
  setBrushSize(px) { this.brushSize = px; }

  undo() {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.maskCtx.putImageData(prev, 0, 0);
    this._refreshMaskFlag();
  }

  clear() {
    this._pushUndo();
    this.maskCtx.clearRect(0, 0, this.maskCanvas.width, this.maskCanvas.height);
    this._refreshMaskFlag();
  }

  /* 用给定画布内容替换当前图像层（修复结果写回） */
  setImage(sourceCanvas) {
    this.imgCtx.clearRect(0, 0, this.imgCanvas.width, this.imgCanvas.height);
    this.imgCtx.drawImage(sourceCanvas, 0, 0);
    this.maskCtx.clearRect(0, 0, this.maskCanvas.width, this.maskCanvas.height);
    this.undoStack.length = 0;
    this._refreshMaskFlag();
  }

  _bindEvents() {
    const el = this.stage;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.painting = true;
      el.setPointerCapture(e.pointerId);
      this._pushUndo();
      const pos = this._pos(e);
      this._lastPos = pos;
      this._paint(pos);
    });
    el.addEventListener('pointermove', (e) => {
      const pos = this._pos(e);
      this._drawCursor(pos);
      if (this.painting) {
        this._stroke(this._lastPos, pos);
        this._lastPos = pos;
      }
    });
    const stop = () => { this.painting = false; };
    el.addEventListener('pointerup', stop);
    el.addEventListener('pointercancel', stop);
    el.addEventListener('pointerleave', () => {
      this.curCtx.clearRect(0, 0, this.cursorCanvas.width, this.cursorCanvas.height);
      stop();
    });
    window.addEventListener('resize', () => { if (this.imgCanvas.width) this._fitToStage(); });
  }

  _pos(e) {
    const rect = this.maskCanvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (this.maskCanvas.width / rect.width),
      y: (e.clientY - rect.top) * (this.maskCanvas.height / rect.height),
    };
  }

  _paint(pos) {
    const ctx = this.maskCtx;
    ctx.globalCompositeOperation = this.mode === 'eraser' ? 'destination-out' : 'source-over';
    ctx.fillStyle = '#ff4f5e';
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, this.brushSize / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    this._refreshMaskFlag();
  }

  /* 两点间以圆头线插值，快速移动不留断点 */
  _stroke(from, to) {
    const ctx = this.maskCtx;
    ctx.globalCompositeOperation = this.mode === 'eraser' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = '#ff4f5e';
    ctx.lineWidth = this.brushSize;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
    this._refreshMaskFlag();
  }

  _drawCursor(pos) {
    const ctx = this.curCtx;
    ctx.clearRect(0, 0, this.cursorCanvas.width, this.cursorCanvas.height);
    ctx.strokeStyle = this.mode === 'eraser' ? '#3ddc97' : '#ff4f5e';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, this.brushSize / 2, 0, Math.PI * 2);
    ctx.stroke();
  }

  /* 将像素级 bitmask(0/1, 画布分辨率) 写入 mask 层（支持撤销），返回标记像素数 */
  applyMaskBits(bits) {
    if (!bits) return 0;
    const w = this.maskCanvas.width, h = this.maskCanvas.height;
    this._pushUndo();
    const img = this.maskCtx.createImageData(w, h);
    let count = 0;
    for (let i = 0; i < bits.length && i < w * h; i++) {
      if (!bits[i]) continue;
      const p = i * 4;
      img.data[p] = 255; img.data[p + 1] = 79; img.data[p + 2] = 94; img.data[p + 3] = 255;
      count++;
    }
    this.maskCtx.putImageData(img, 0, 0);
    this._refreshMaskFlag();
    return count;
  }

  /* 将一组矩形区域整体写入 mask 层（AI 检测框路径，支持撤销），返回标记像素数 */
  applyMaskRects(rects) {
    if (!rects || !rects.length) return 0;
    const w = this.maskCanvas.width, h = this.maskCanvas.height;
    this._pushUndo();
    const ctx = this.maskCtx;
    ctx.fillStyle = '#ff4f5e';
    let count = 0;
    for (const r of rects) {
      const x = Math.max(0, r.x), y = Math.max(0, r.y);
      const rw = Math.min(w - x, r.w), rh = Math.min(h - y, r.h);
      if (rw <= 0 || rh <= 0) continue;
      ctx.fillRect(x, y, rw, rh);
      count += rw * rh;
    }
    this._refreshMaskFlag();
    return count;
  }

  _pushUndo() {
    if (this.undoStack.length >= 15) this.undoStack.shift();
    this.undoStack.push(this.maskCtx.getImageData(0, 0, this.maskCanvas.width, this.maskCanvas.height));
  }

  _refreshMaskFlag() {
    const d = this.maskCtx.getImageData(0, 0, this.maskCanvas.width, this.maskCanvas.height).data;
    let found = false;
    for (let i = 3; i < d.length; i += 16) { // 抽样检测，避免全量扫描卡顿
      if (d[i] > 0) { found = true; break; }
    }
    this.hasMask = found;
    this._emitMask();
  }

  _emitMask() { this.cb.onMaskChange && this.cb.onMaskChange(this.hasMask); }
}
