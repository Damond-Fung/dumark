/* 源图 Dumark 手机版 — 自动检测流程（复用主站检测增强）
 * 输入原图画布，输出 { rects, bits, extra, empty }：
 *   rects 检测框；bits 像素级精修掩码；extra 状态补充说明；empty 未检出原因。
 */
import { WATERMARK_DETECT } from './detect.js';
import { extendTiled } from './detect-template.js';
import { detectIcons } from './detect-icons.js';

export async function detectWatermarks(canvas, detector, { ready, sensitivity }) {
  let rects;

  if (ready) {
    rects = await detector.detect(canvas, { sensitivity });
    if (!rects.length) return { empty: 'AI 未检测到水印，请手动涂抹' };
  } else {
    // 降级：启发式分析（降采样提速，坐标映射回原图）
    const W = canvas.width, H = canvas.height;
    const k = Math.min(1, 1024 / Math.max(W, H));
    const small = document.createElement('canvas');
    small.width = Math.round(W * k); small.height = Math.round(H * k);
    small.getContext('2d').drawImage(canvas, 0, 0, small.width, small.height);
    rects = WATERMARK_DETECT.analyze(small).map((r) => ({
      x: Math.round(r.x / k), y: Math.round(r.y / k),
      w: Math.round(r.w / k), h: Math.round(r.h / k), conf: r.conf,
    }));
    if (!rects.length) return { empty: '未检测到明显水印，请手动涂抹' };
  }

  let extra = '';
  if (ready) {
    // 平铺水印：≥3 实例时按能量门控膨胀补齐漏检带
    const before = rects.length;
    rects = extendTiled(canvas, rects);
    const tiled = rects.length - before;
    // 图标/Logo 水印：DBNet 检不到纯图形，角落+底边条带启发式补检
    const icons = detectIcons(canvas, { sensitivity }).filter((ic) =>
      !rects.some((r) => ic.x + ic.w > r.x - 8 && ic.x < r.x + r.w + 8
        && ic.y + ic.h > r.y - 8 && ic.y < r.y + r.h + 8));
    rects = rects.concat(icons);
    extra = (tiled > 0 ? '（平铺扩展 ' + tiled + '）' : '') + (icons.length ? '（图标 ' + icons.length + '）' : '');
  }

  // 像素级精修：只标记与局部背景差异明显的水印像素，避免整框重绘误伤背景
  const bits = WATERMARK_DETECT.refineMask(canvas, rects, { diffThreshold: 24, dilate: 4, blurRadius: 15 });
  return { rects, bits, extra };
}
