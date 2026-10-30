/* 源图 Dumark 小程序 — 涂抹编辑器
 * 两层画布：imgCanvas（原图 / 修复结果）与 maskCanvas（红se涂抹层）。
 * 为了让手机内存可控，撤销采用「笔画动作日志 + 重放」，而不是保存整张
 * mask 的 ImageData 快照（1080×1440 单张快照约 6MB）。
 */
const MASK_COLOR = 'rgba(255, 79, 94, 0.62)';

export class MaskEditor {
  constructor({ imgCanvas, maskCanvas, onMaskChange }) {
    this.imgCanvas = imgCanvas;
    this.maskCanvas = maskCanvas;
    this.imgCtx = imgCanvas.getContext('2d');
    this.maskCtx = maskCanvas.getContext('2d');
    this.cb = { onMaskChange };
    this.mode = 'brush';
    this.brushSize = 36;      // CSS px
    this.ratio = 1;           // 画布内部像素 / CSS 像素
    this.actions = [];
    this.painting = false;
    this._last = null;
    this.hasMask = false;
  }

  /* 设定图片尺寸并重置全部状态 */
  setImageSize(w, h) {
    [this.imgCanvas, this.maskCanvas].forEach((c) => {
      c.width = w; c.height = h;
    });
    this.imgCtx = this.imgCanvas.getContext('2d');
    this.maskCtx = this.maskCanvas.getContext('2d');
    this.actions = [];
    this.hasMask = false;
    this._emit();
  }

  /* CSS 显示尺寸（用于触点坐标换算） */
  setViewport(cssW) {
    this.ratio = this.maskCanvas.width / Math.max(1, cssW);
  }

  setMode(mode) { this.mode = mode; }

  setBrushSize(cssPx) { this.brushSize = cssPx; }

  _pos(x, y) {
    return [x * this.ratio, y * this.ratio];
  }

  _brushInternal() {
    return Math.max(4, this.brushSize * this.ratio);
  }

  begin(x, y) {
    if (!this.imgCanvas.width) return;
    const p = this._pos(x, y);
    this.painting = true;
    this._last = p;
    const action = { type: 'stroke', mode: this.mode, size: this._brushInternal(), points: [p] };
    this.actions.push(action);
    this._dot(p, action.size, this.mode);
    this._markMask(true);
  }

  move(x, y) {
    if (!this.painting) return;
    const p = this._pos(x, y);
    const action = this.actions[this.actions.length - 1];
    action.points.push(p);
    this._line(this._last, p, action.size, this.mode);
    this._last = p;
  }

  end() {
    if (!this.painting) return;
    this.painting = false;
    this._refreshMaskFlag();
  }

  undo() {
    if (!this.actions.length) return;
    this.actions.pop();
    this._replay();
  }

  clear() {
    this.actions = [];
    this._replay();
  }

  /* 把像素级 mask（0/1，画布分辨率）替换进涂抹层，返回标记像素数 */
  applyMaskBits(bits) {
    if (!bits) return 0;
    let count = 0;
    for (let i = 0; i < bits.length; i++) if (bits[i]) count++;
    if (!count) return 0;
    this.actions = [{ type: 'bits', bits }];
    this._replay();
    return count;
  }

  _replay() {
    const ctx = this.maskCtx;
    ctx.clearRect(0, 0, this.maskCanvas.width, this.maskCanvas.height);
    for (const action of this.actions) {
      if (action.type === 'bits') {
        this._paintBits(action.bits);
      } else {
        const pts = action.points;
        if (pts.length === 1) this._dot(pts[0], action.size, action.mode);
        for (let i = 1; i < pts.length; i++) this._line(pts[i - 1], pts[i], action.size, action.mode);
      }
    }
    this._refreshMaskFlag();
  }

  _paintBits(bits) {
    const w = this.maskCanvas.width, h = this.maskCanvas.height;
    const img = this.maskCtx.createImageData(w, h);
    for (let i = 0; i < bits.length && i < w * h; i++) {
      if (!bits[i]) continue;
      const p = i * 4;
      img.data[p] = 255; img.data[p + 1] = 79; img.data[p + 2] = 94; img.data[p + 3] = 158;
    }
    this.maskCtx.putImageData(img, 0, 0);
  }

  _dot(p, size, mode) {
    const ctx = this.maskCtx;
    ctx.globalCompositeOperation = mode === 'eraser' ? 'destination-out' : 'source-over';
    ctx.fillStyle = MASK_COLOR;
    ctx.beginPath();
    ctx.arc(p[0], p[1], size / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }

  _line(a, b, size, mode) {
    const ctx = this.maskCtx;
    ctx.globalCompositeOperation = mode === 'eraser' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = MASK_COLOR;
    ctx.lineWidth = size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
  }

  /* 抽样扫描判断是否仍有涂抹（避免每次全量扫描卡顿） */
  _refreshMaskFlag() {
    if (!this.actions.length) { this._markMask(false); return; }
    const w = this.maskCanvas.width, h = this.maskCanvas.height;
    const d = this.maskCtx.getImageData(0, 0, w, h).data;
    let found = false;
    for (let i = 3; i < d.length; i += 64) {
      if (d[i] > 0) { found = true; break; }
    }
    this._markMask(found);
  }

  _markMask(v) {
    if (this.hasMask === v) return;
    this.hasMask = v;
    this._emit();
  }

  _emit() {
    if (this.cb.onMaskChange) this.cb.onMaskChange(this.hasMask);
  }

  readImageData() {
    return this.imgCtx.getImageData(0, 0, this.imgCanvas.width, this.imgCanvas.height);
  }

  readMaskData() {
    return this.maskCtx.getImageData(0, 0, this.maskCanvas.width, this.maskCanvas.height);
  }

  /* 把修复后的整图像素写回图像层，并清空涂抹层 */
  writeResult(pixels) {
    const w = this.imgCanvas.width, h = this.imgCanvas.height;
    const img = this.imgCtx.createImageData(w, h);
    img.data.set(pixels);
    this.imgCtx.putImageData(img, 0, 0);
    this.actions = [];
    this.maskCtx.clearRect(0, 0, w, h);
    this._markMask(false);
  }
}
