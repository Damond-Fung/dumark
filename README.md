# 源图 Dumark — 本地 AI 去水印

在浏览器本地运行的 AI 去水印工具：上传图片 → 自动检测 / 手动涂抹水印 → LaMa 修复模型重建背景 → 对比并下载。图片不上传服务器。

- 桌面/网页版：`index.html`（无构建静态站，ES Modules + onnxruntime-web）
- 手机网页版：`mobile.html`（手机端全屏，桌面端手机壳预览）
- 离线交互 Demo：`dumark-demo.html`（单文件，内置样例，无需模型）
- 微信小程序版：`miniprogram/`（见该目录内说明）

## 本地运行

模型文件不随仓库上传（单文件超过 GitHub 100MB 限制）。首次运行前将以下文件放入 `models/`：

| 文件 | 用途 | 大小 |
|---|---|---|
| `lama_fp32.onnx` | LaMa 图像修复 | 约 203MB |
| `ppocr4_det.onnx` | PP-OCRv4 DBNet 文本检测 | 约 4.5MB |

启动静态服务后访问：

```powershell
python -m http.server 8000
# 桌面版 http://127.0.0.1:8000/
# 手机版 http://127.0.0.1:8000/mobile.html
```

本地访问（localhost / 127.0.0.1）直接读取仓库内 `models/`；生产环境从 GitHub Release 下载（见 `scripts/models.config.js`）。浏览器优先使用 WebGPU，不可用时自动回退 WASM。

## 目录结构

```
index.html              桌面版页面
mobile.html             手机网页版页面
dumark-demo.html        单文件离线演示
scripts/
  app.js                桌面版控制器
  editor.js             画笔 / 橡皮 / 撤销 / mask 导入
  inpaint.js            修复客户端（ROI 裁剪、分区域、羽化合成）
  inpaint.worker.js     LaMa 推理 Worker
  detect-client.js      DBNet 检测客户端（灵敏度分档、双路合并）
  detect.worker.js      DBNet 推理 Worker
  detect.js             启发式检测与像素级精修（降级路径）
  detect-template.js    平铺水印覆盖补全
  detect-icons.js       图标 / Logo 水印补检
  models.config.js      模型来源（本地 / Release）
  mobile-app.js         手机版控制器
  mobile-detect.js      手机版检测流程
  mobile-compare.js     拖动对比
styles/                 样式
assets/                 品牌资源
test-assets/            测试样例图
models/                 ONNX 模型（不提交，见上）
```

## 版本标签

| 标签 | 内容 |
|---|---|
| `v1.0.0` | 桌面版首发：上传 / 涂抹 / LaMa 修复 / 下载 |
| `v1.1.0` | 检测优化（灵敏度、平铺与图标补检、像素级精修、分区域修复）+ 手机网页版 |
| `v1.2.0` | 微信小程序版 |

## 许可

MIT，见 `LICENSE`。请仅处理你拥有版权或已获授权的图片。
