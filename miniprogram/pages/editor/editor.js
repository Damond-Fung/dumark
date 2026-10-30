import { MaskEditor } from '../../utils/editor.js';
import { fitWithin, fitBox } from '../../utils/canvas.js';
import { detectWatermarks } from '../../utils/detect-flow.js';
import { repairImage } from '../../utils/inpaint.js';
import { repairByRemote, remoteReady } from '../../utils/inpaint-remote.js';
import { LIMITS, REPAIR } from '../../utils/config.js';

const app = getApp();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

Page({
  data: {
    cssW: 0,
    cssH: 0,
    imageLabel: '',
    engineLabel: REPAIR.engine === 'remote' ? '远程 AI' : '端上轻量引擎',
    mode: 'brush',
    brushSize: 36,
    sens: 'mid',
    hasMask: false,
    status: '正在载入图片…',
    statusType: '',
    loading: false,
    progress: 0,
    progressText: '',
    busy: false,
  },

  onLoad() {
    this.detectRects = null;
    this.editor = null;
    const path = app.globalData.imagePath;
    const size = app.globalData.imageSize;
    if (!path || !size) {
      wx.showToast({ title: '请先选择图片', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    this.imagePath = path;
    this.imageSize = size;
    this.setData({ imageLabel: size.width + ' × ' + size.height });
    wx.nextTick(() => this.initCanvas());
  },

  initCanvas() {
    const query = wx.createSelectorQuery();
    query.select('#imgCanvas').fields({ node: true });
    query.select('#maskCanvas').fields({ node: true });
    query.select('#stage').boundingClientRect();
    query.exec((res) => {
      const imgNode = res[0] && res[0].node;
      const maskNode = res[1] && res[1].node;
      const stage = res[2];
      if (!imgNode || !maskNode || !stage) {
        this.setStatus('画布初始化失败，请返回重试', 'err');
        return;
      }
      this.imgNode = imgNode;
      this.maskNode = maskNode;

      const internal = fitWithin(this.imageSize.width, this.imageSize.height, LIMITS.maxSide);
      const box = fitBox(internal.width, internal.height, stage.width - 24, stage.height - 24);

      this.setData({ cssW: box.width, cssH: box.height }, () => {
        this.editor = new MaskEditor({
          imgCanvas: imgNode,
          maskCanvas: maskNode,
          onMaskChange: (v) => {
            this.setData({ hasMask: v, statusType: v ? 'ok' : '' });
          },
        });
        this.editor.setImageSize(internal.width, internal.height);
        this.editor.setViewport(box.width);
        this.loadImageIntoCanvas(internal);
      });
    });
  },

  loadImageIntoCanvas(internal) {
    const img = this.imgNode.createImage();
    img.onload = () => {
      this.editor.imgCtx.drawImage(img, 0, 0, internal.width, internal.height);
      this.setStatus('已载入 ' + internal.width + '×' + internal.height + '，涂抹水印或点「自动检测」');
    };
    img.onerror = () => this.setStatus('图片解码失败，请返回重选', 'err');
    img.src = this.imagePath;
  },

  setStatus(text, type) {
    this.setData({ status: text, statusType: type || '' });
  },

  noop() {},

  setLoading(show, text, pct) {
    this.setData({
      loading: show,
      progressText: text != null ? text : this.data.progressText,
      progress: pct != null ? pct : this.data.progress,
    });
  },

  /* ── 涂抹交互 ── */
  onTouchStart(e) {
    if (this.data.busy || !this.editor) return;
    const t = e.touches[0];
    this.detectRects = null; // 手动修改后，检测框不再代表当前 mask
    this.editor.begin(t.x, t.y);
  },

  onTouchMove(e) {
    if (this.data.busy || !this.editor) return;
    const t = e.touches[0];
    this.editor.move(t.x, t.y);
  },

  onTouchEnd() {
    if (!this.editor) return;
    this.editor.end();
  },

  setMode(e) {
    const mode = e.currentTarget.dataset.mode;
    this.editor && this.editor.setMode(mode);
    this.setData({ mode });
  },

  onBrushSize(e) {
    this.editor && this.editor.setBrushSize(e.detail.value);
    this.setData({ brushSize: e.detail.value });
  },

  onSens(e) {
    this.setData({ sens: e.currentTarget.dataset.sens });
  },

  onUndo() {
    if (this.data.busy || !this.editor) return;
    this.detectRects = null;
    this.editor.undo();
  },

  onClear() {
    if (this.data.busy || !this.editor) return;
    this.detectRects = null;
    this.editor.clear();
  },

  /* ── 自动检测（电脑版降级启发式路径） ── */
  async onDetect() {
    if (this.data.busy || !this.editor) return;
    this.setData({ busy: true });
    this.setLoading(true, '正在检测水印…', 0);
    await sleep(80); // 先渲染遮罩，再执行同步计算
    try {
      const imgData = this.editor.readImageData();
      const result = detectWatermarks(imgData, this.data.sens);
      if (result.empty) {
        this.setStatus(result.empty, 'err');
        return;
      }
      const px = this.editor.applyMaskBits(result.bits);
      if (!px) {
        this.setStatus('检测区域无需修复，请手动涂抹', 'err');
        return;
      }
      this.detectRects = result.rects;
      this.setStatus('检测到 ' + result.rects.length + ' 处水印，已自动标记，可直接修复', 'ok');
    } catch (err) {
      this.setStatus('自动检测失败：' + (err.message || err), 'err');
    } finally {
      this.setLoading(false);
      this.setData({ busy: false });
    }
  },

  /* ── 修复 ── */
  async onRepair() {
    if (this.data.busy || !this.editor || !this.data.hasMask) return;
    this.setData({ busy: true });
    this.setLoading(true, '正在修复，请稍候…', 0);
    await sleep(80);
    const t0 = Date.now();
    const lastPct = { v: 0 };
    try {
      const originalPath = await this.exportCanvas(this.imgNode);

      let resultPath;
      if (remoteReady()) {
        resultPath = await this.repairRemote();
      } else {
        const imgData = this.editor.readImageData();
        const maskData = this.editor.readMaskData();
        const pixels = await repairImage(imgData, maskData, this.detectRects, (pct, label) => {
          if (pct - lastPct.v >= 5) {
            lastPct.v = pct;
            this.setLoading(true, label + ' · ' + pct + '%', pct);
          }
        });
        if (!pixels) {
          this.setStatus('请先涂抹或检测要去除的水印区域', 'err');
          return;
        }
        this.editor.writeResult(pixels);
        resultPath = await this.exportCanvas(this.imgNode);
      }

      const sec = ((Date.now() - t0) / 1000).toFixed(1);
      const meta = this.editor.imgCanvas.width + '×' + this.editor.imgCanvas.height + ' · ' + sec + 's';
      app.globalData.lastResult = { path: resultPath, thumb: resultPath, meta };
      app.globalData.lastOriginal = originalPath;
      app.globalData.lastResultSize = {
        width: this.editor.imgCanvas.width,
        height: this.editor.imgCanvas.height,
      };
      this.detectRects = null;
      this.setStatus('修复完成，用时 ' + sec + ' 秒', 'ok');
      this.setLoading(false);
      wx.navigateTo({ url: '/pages/result/result' });
    } catch (err) {
      this.setStatus(String(err.message || err), 'err');
    } finally {
      this.setLoading(false);
      this.setData({ busy: false });
    }
  },

  /* 远程 AI 修复：按约定上传原图与 mask 图，返回结果图片临时路径 */
  async repairRemote() {
    this.setLoading(true, '上传到远程修复服务…', 0);
    const maskPath = await this.exportCanvas(this.maskNode);
    const path = await repairByRemote({
      imagePath: this.imagePath,
      maskPath,
      sensitivity: this.data.sens,
    });
    await this.drawPathToCanvas(path);
    this.editor.clear();
    return path;
  },

  /* 把外部图片路径绘制到编辑画布（远程结果预览 / 继续精修） */
  drawPathToCanvas(path) {
    return new Promise((resolve, reject) => {
      const img = this.imgNode.createImage();
      img.onload = () => {
        this.editor.imgCtx.drawImage(img, 0, 0, this.editor.imgCanvas.width, this.editor.imgCanvas.height);
        resolve();
      };
      img.onerror = () => reject(new Error('结果图片解码失败'));
      img.src = path;
    });
  },

  exportCanvas(node) {
    return new Promise((resolve, reject) => {
      wx.canvasToTempFilePath({
        canvas: node,
        x: 0,
        y: 0,
        width: node.width,
        height: node.height,
        destWidth: node.width,
        destHeight: node.height,
        fileType: 'png',
        quality: 1,
        success: (res) => resolve(res.tempFilePath),
        fail: () => reject(new Error('导出图片失败')),
      }, this);
    });
  },
});
