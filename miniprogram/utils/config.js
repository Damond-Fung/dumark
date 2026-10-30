/* 源图 Dumark 小程序 — 运行配置
 * 与电脑版保持同一套业务参数：图片上限、检测分辨率、分区域修复的分组尺度。
 * 修复引擎默认走端上轻量算法；配置远程服务后可切换到远端 AI 修复。
 */

/* 小程序环境：develop（开发者工具/真机调试）| trial（体验版）| release（正式版） */
export function envVersion() {
  try {
    return wx.getAccountInfoSync().miniProgram.envVersion || 'develop';
  } catch (e) {
    return 'develop';
  }
}

export const LIMITS = {
  maxFileMB: 10,
  maxSide: 1080,    // 小程序内存与耗时上限，等比缩小
  detectSide: 1024, // 与电脑版启发式检测的降采样分辨率一致
};

/* 修复引擎配置 */
export const REPAIR = {
  engine: 'local',            // 'local' | 'remote'
  roiPad: 64,                 // ROI 扩边（与电脑版一致）
  maxGroupSide: 640,          // 检测框分组合并后的边长上限（与电脑版一致）
  feather: 2,                 // 合成羽化半径（像素）
  // 远程 AI 修复地址；各环境单独配置，留空表示未部署
  remoteBase: {
    develop: '',
    trial: '',
    release: '',
  },
};

/* 检测灵敏度：与电脑版启发式降级路径一致的阈值档位 */
export const SENSITIVITY = {
  low: { edgeThreshold: 72, minFill: 0.08 },
  mid: { edgeThreshold: 58, minFill: 0.06 },
  high: { edgeThreshold: 46, minFill: 0.05 },
};
