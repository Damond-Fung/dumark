import { fitBox } from '../../utils/canvas.js';

const app = getApp();

Page({
  data: {
    original: '',
    result: '',
    meta: '',
    cssW: 0,
    cssH: 0,
    pos: 50,
    saving: false,
  },

  onLoad() {
    const last = app.globalData.lastResult;
    const original = app.globalData.lastOriginal;
    if (!last || !original) {
      wx.showToast({ title: '没有可对比的结果', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    this.setData({ original, result: last.path, meta: last.meta || '' });
    wx.nextTick(() => this.layout());
  },

  /* 按结果图宽高比适配对比区域 */
  layout() {
    const size = app.globalData.lastResultSize || { width: 1, height: 1 };
    const query = wx.createSelectorQuery();
    query.select('#cmpArea').boundingClientRect();
    query.exec((res) => {
      const area = res[0];
      if (!area) return;
      const box = fitBox(size.width, size.height, area.width, area.height);
      this.boxW = box.width;
      this.boxH = box.height;
      this.setData({ cssW: box.width, cssH: box.height }, () => {
        wx.createSelectorQuery().select('#cmpBox').boundingClientRect().exec((r) => {
          if (r[0]) this.boxLeft = r[0].left;
        });
      });
    });
  },

  onDragStart(e) {
    this.dragging = true;
    this.moveTo(e);
  },

  onDragMove(e) {
    if (!this.dragging) return;
    this.moveTo(e);
  },

  onDragEnd() {
    this.dragging = false;
  },

  moveTo(e) {
    const t = e.touches && e.touches[0];
    if (!t || !this.boxW) return;
    const pct = Math.max(0, Math.min(100, (t.clientX - this.boxLeft) / this.boxW * 100));
    this.setData({ pos: pct });
  },

  /* 保存到相册（带授权处理） */
  save() {
    if (this.data.saving) return;
    const path = this.data.result;
    this.setData({ saving: true });
    wx.saveImageToPhotosAlbum({
      filePath: path,
      success: () => {
        this.setData({ saving: false });
        wx.showToast({ title: '已保存到相册', icon: 'success' });
      },
      fail: (err) => {
        this.setData({ saving: false });
        if (/auth|deny|authorize/i.test(err.errMsg || '')) {
          wx.showModal({
            title: '需要相册权限',
            content: '保存图片需要允许访问相册，是否前往设置？',
            confirmText: '去设置',
            success: (r) => {
              if (r.confirm) wx.openSetting();
            },
          });
          return;
        }
        wx.showToast({ title: '保存失败，请重试', icon: 'none' });
      },
    });
  },

  reEdit() {
    wx.navigateBack();
  },

  goHome() {
    wx.reLaunch({ url: '/pages/index/index' });
  },

  onShareAppMessage() {
    return {
      title: '源图 Dumark — 手机本地去水印',
      path: '/pages/index/index',
      imageUrl: this.data.result,
    };
  },
});
