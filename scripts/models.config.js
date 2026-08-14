/* 源图 Dumark — 模型下载配置
 * 模型文件过大，不随仓库上传；首次运行时从远程 URL 下载并缓存在 IndexedDB。
 * 修改这里的 URL 即可切换模型托管源（GitHub Release / CDN / 对象存储）。
 */
export const MODELS = {
  // LaMa 图像修复模型（约 200MB，fp32）
  inpaint: 'https://github.com/Damond-Fung/dumark/releases/latest/download/lama_fp32.onnx',
  // PP-OCRv4 DBNet 文本检测模型（约 4.5MB）
  detect: 'https://github.com/Damond-Fung/dumark/releases/latest/download/ppocr4_det.onnx',
};