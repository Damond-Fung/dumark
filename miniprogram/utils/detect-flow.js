/* 源图 Dumark 小程序 — 自动检测流程
 * 对应电脑版「检测模型未就绪」时的降级路径：
 * 降采样到 1024 → 启发式 analyze → 坐标映射回原图 → 像素级 refineMask。
 * 小程序端没有 DBNet 模型可用，因此这是唯一的检测路径，参数与电脑版一致。
 */
import { resizeImage } from './canvas.js';
import { WATERMARK_DETECT } from './detect.js';
import { LIMITS, SENSITIVITY } from './config.js';

export function detectWatermarks(imgData, sensitivity) {
  const W = imgData.width, H = imgData.height;
  const k = Math.min(1, LIMITS.detectSide / Math.max(W, H));
  const small = resizeImage(imgData, Math.round(W * k), Math.round(H * k));
  const sens = SENSITIVITY[sensitivity] || SENSITIVITY.mid;

  const rects = WATERMARK_DETECT.analyze(small, {
    edgeThreshold: sens.edgeThreshold,
    minFill: sens.minFill,
  }).map((r) => ({
    x: Math.round(r.x / k),
    y: Math.round(r.y / k),
    w: Math.round(r.w / k),
    h: Math.round(r.h / k),
    conf: r.conf,
  }));
  if (!rects.length) return { empty: '未检测到明显水印，请手动涂抹' };

  // 与电脑版降级路径相同的精修参数
  const bits = WATERMARK_DETECT.refineMask(imgData, rects, { diffThreshold: 20, dilate: 4 });
  let count = 0;
  for (let i = 0; i < bits.length; i++) if (bits[i]) count++;
  if (!count) return { empty: '检测区域无需修复，请手动涂抹' };
  return { rects, bits, count };
}
