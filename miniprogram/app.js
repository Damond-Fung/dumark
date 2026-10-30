/* 源图 Dumark 小程序 — 全局数据
 * 只保存本次会话的真实处理上下文，不做持久化缓存。
 */
App({
  globalData: {
    imagePath: '',      // 待处理图片临时路径
    imageSize: null,    // { width, height }
    lastResult: null,   // { path, width, height, meta }
    lastOriginal: '',   // 最近一次结果的修复前图片路径
  },

  onLaunch() {
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    this.globalData.window = info;
  },
});
