const app = getApp();
const MAX_FILE_MB = 10;

Page({
  data: {
    engine: '端上轻量引擎',
    recent: null,
    busy: false,
  },

  onShow() {
    const last = app.globalData.lastResult;
    this.setData({ recent: last || null });
  },

  /* 相册 / 拍照统一入口 */
  pickImage(e) {
    if (this.data.busy) return;
    const source = e.currentTarget.dataset.source || 'album';
    this.setData({ busy: true });
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: [source === 'camera' ? 'camera' : 'album'],
      sizeType: ['original', 'compressed'],
      success: (res) => {
        const file = (res.tempFiles || [])[0];
        if (!file) { this.setData({ busy: false }); return; }
        if (file.size > MAX_FILE_MB * 1024 * 1024) {
          this.setData({ busy: false });
          wx.showToast({ title: '图片超过 10MB 限制', icon: 'none' });
          return;
        }
        this.loadImage(file.tempFilePath);
      },
      fail: (err) => {
        this.setData({ busy: false });
        if (!/cancel/.test(err.errMsg || '')) {
          wx.showToast({ title: '选择图片失败', icon: 'none' });
        }
      },
    });
  },

  loadImage(path) {
    wx.getImageInfo({
      src: path,
      success: (info) => {
        app.globalData.imagePath = path;
        app.globalData.imageSize = { width: info.width, height: info.height };
        this.setData({ busy: false });
        wx.navigateTo({ url: '/pages/editor/editor' });
      },
      fail: () => {
        this.setData({ busy: false });
        wx.showToast({ title: '图片读取失败', icon: 'none' });
      },
    });
  },

  /* 打开本次会话最近一次处理结果 */
  openRecent() {
    const last = app.globalData.lastResult;
    if (!last) return;
    wx.navigateTo({ url: '/pages/result/result?from=recent' });
  },

  onShareAppMessage() {
    return {
      title: '源图 Dumark — 手机本地去水印',
      path: '/pages/index/index',
    };
  },
});
