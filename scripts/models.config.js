/* 源图 Dumark — 模型下载配置
 * 模型文件过大，不随仓库上传；首次运行时下载并缓存在 IndexedDB。
 * 本地开发（localhost/127.0.0.1）：直接使用仓库内 models/ 目录，避免远程 404；
 * 生产环境：从 GitHub Release 下载。切换托管源只需改 PROD_BASE。
 */
const IS_LOCAL = ['localhost', '127.0.0.1', ''].includes(location.hostname);
const PROD_BASE = 'https://github.com/Damond-Fung/dumark/releases/latest/download/';
// 转为绝对 URL：fetch 发生在 Worker 内，相对路径会按 Worker 脚本位置解析
const BASE = IS_LOCAL ? new URL('./models/', location.href).href : PROD_BASE;

export const MODELS = {
  // LaMa 图像修复模型（约 200MB，fp32）
  inpaint: BASE + 'lama_fp32.onnx',
  // PP-OCRv4 DBNet 文本检测模型（约 4.5MB）
  detect: BASE + 'ppocr4_det.onnx',
};