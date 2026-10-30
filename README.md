# 源图 Dumark — 本地 AI 去水印

在浏览器本地运行的 AI 去水印工具：上传图片 → 自动检测 / 手动涂抹水印 → LaMa 修复模型重建背景 → 对比并下载。图片不上传服务器。

- 桌面/网页版：`index.html`（无构建静态站，ES Modules + onnxruntime-web）
- 手机网页版：`mobile.html`（手机端全屏，桌面端手机壳预览）
- 离线交互 Demo：`dumark-demo.html`（单文件，内置样例，无需模型）
- 微信小程序版：`miniprogram/`（端上轻量修复引擎，无需模型与服务器）

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
miniprogram/            微信小程序项目（导入该目录到微信开发者工具）
  project.config.json   小程序工程配置（appid 为测试号，可按需替换）
  app.json / app.js / app.wxss
  pages/
    index/              首页：相册/拍照选图、本次处理结果
    editor/             涂抹编辑：画笔/橡皮、自动检测、修复
    result/             修复前后拖动对比、保存相册
  utils/
    config.js           图片上限、检测分辨率、修复引擎与远程接口配置
    canvas.js           离屏画布、尺寸计算、降采样
    image-ops.js        积分图/盒式均值/Otsu/膨胀/闭运算/连通域
    detect.js           启发式水印检测 + 像素级精修（同电脑版）
    detect-icons.js     图标/Logo 水印补检（同电脑版）
    detect-flow.js      检测流程编排（降采样 → 检测 → 映射 → 精修）
    region.js           ROI 规划与检测框分组（同电脑版）
    inpaint-local.js    端上轻量修复引擎（多尺度调和填充）
    inpaint.js          分区域修复编排 + 羽化合成
    inpaint-remote.js   远程 AI 修复接口（预留，按环境配置）
    editor.js           涂抹编辑器（动作日志撤销）
  assets/               品牌资源
scripts/                桌面版脚本
styles/                 样式
assets/                 品牌资源
test-assets/            测试样例图
models/                 ONNX 模型（不提交，见上）
```

## 微信小程序

小程序无法在端上运行 200MB 的 LaMa 模型（主包 2MB / 总分包 30MB，且不支持 onnxruntime-web），因此：

- 检测：使用电脑版「检测模型未就绪」时的启发式路径（`analyze` + `refineMask`），参数一致
- 修复：端上轻量引擎（多尺度调和填充），分区域 ROI 分组与羽化合成策略与电脑版一致
- 远程：`utils/inpaint-remote.js` 预留上传接口，按 develop/trial/release 配置服务地址后可切换为服务端 LaMa

导入运行：微信开发者工具 → 导入项目 → 目录选择 `miniprogram/`（AppID 可先用测试号）。

## 版本标签

| 标签 | 内容 |
|---|---|
| `v1.0.0` | 桌面版首发：上传 / 涂抹 / LaMa 修复 / 下载 |
| `v1.1.0` | 检测优化（灵敏度、平铺与图标补检、像素级精修、分区域修复）+ 手机网页版 |
| `v1.2.0` | 微信小程序版 |

## 许可

MIT，见 `LICENSE`。请仅处理你拥有版权或已获授权的图片。
