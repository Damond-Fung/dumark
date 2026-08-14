/* 源图 Dumark — 主控制器
 * 串联：上传（点击/拖放/粘贴）→ 涂抹编辑 → LaMa 修复 → 对比/下载
 */
import { MaskEditor } from './editor.js';
import { InpaintClient } from './inpaint.js';
import { DetectClient } from './detect-client.js';
import { WATERMARK_DETECT } from './detect.js';
import { MODELS } from './models.config.js';

const $ = (id) => document.getElementById(id);

const els = {
  uploadZone: $('uploadZone'), fileInput: $('fileInput'),
  editor: $('editor'), stage: $('canvasStage'), stageEmpty: $('stageEmpty'),
  btnBrush: $('btnBrush'), btnEraser: $('btnEraser'),
  brushSize: $('brushSize'), brushSizeVal: $('brushSizeVal'),
  btnUndo: $('btnUndo'), btnClear: $('btnClear'), btnAutoDetect: $('btnAutoDetect'),
  btnRun: $('btnRun'), btnReEdit: $('btnReEdit'), btnCompare: $('btnCompare'),
  btnDownload: $('btnDownload'), btnNew: $('btnNew'), fmtSeg: $('fmtSeg'),
  progressFill: $('progressFill'), statusText: $('statusText'),
};

const MAX_FILE_MB = 10;
let editor = null;
let hasMask = false;
let modelReady = false;
let busy = false;
let exportFmt = 'png';
let originalCanvas = null; // 修复前原图（用于按住对比）
let detectReady = false;   // YOLO 检测模型就绪
let detectRects = null;    // 最近一次 AI 检测框（用于分区域高质量修复）

/* ── 状态栏 ── */
function setStatus(text, cls) {
  els.statusText.textContent = text;
  els.statusText.className = 'status-text' + (cls ? ' ' + cls : '');
}
function setProgress(pct) { els.progressFill.style.width = Math.min(100, pct) + '%'; }

function refreshButtons() {
  els.btnRun.disabled = !(modelReady && hasMask && !busy);
  els.btnDownload.disabled = busy || !editor;
}

/* ── 推理客户端（页面加载即预热模型） ── */
const client = new InpaintClient({
  onProgress: (m) => { setProgress(m.pct); setStatus(m.label); },
  onReady: (m) => {
    modelReady = true;
    setProgress(100);
    setStatus('修复引擎就绪（' + (m.ep === 'webgpu' ? 'WebGPU 加速' : 'WASM') + '），涂抹水印后点击「开始修复」', 'ok');
    refreshButtons();
  },
  onError: (text) => { setStatus(text, 'err'); busy = false; refreshButtons(); },
});
client.init(MODELS.inpaint);

/* ── YOLO 水印检测模型（静默预热，失败时自动降级启发式） ── */
const detector = new DetectClient({
  onReady: () => { detectReady = true; },
  onError: () => { detectReady = false; }, // 静默降级，不打扰主流程
});
detector.init(MODELS.detect);

/* ── 图片载入 ── */
function loadFile(file) {
  if (!file) return;
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { setStatus('仅支持 PNG / JPG / WEBP', 'err'); return; }
  if (file.size > MAX_FILE_MB * 1048576) { setStatus('图片超过 10MB 限制', 'err'); return; }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    els.editor.classList.remove('hidden');
    els.editor.scrollIntoView({ behavior: 'smooth' });
    els.stageEmpty.classList.remove('hidden');
    if (!editor) {
      editor = new MaskEditor(els.stage, { onMaskChange: (v) => { hasMask = v; refreshButtons(); } });
    }
    const size = editor.loadImage(img);
    originalCanvas = null;
    els.btnReEdit.classList.add('hidden');
    els.btnCompare.classList.add('hidden');
    els.stageEmpty.classList.add('hidden');
    hasMask = false;
    detectRects = null;
    setStatus(modelReady
      ? '已载入 ' + size.width + '×' + size.height + '，请涂抹水印区域'
      : '图片已载入，模型仍在加载中…');
    refreshButtons();
  };
  img.onerror = () => setStatus('图片解码失败', 'err');
  img.src = url;
}

/* ── 上传交互 ── */
els.uploadZone.addEventListener('click', () => els.fileInput.click());
els.uploadZone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') els.fileInput.click(); });
els.fileInput.addEventListener('change', (e) => loadFile(e.target.files[0]));
['dragover', 'dragleave', 'drop'].forEach((ev) => {
  els.uploadZone.addEventListener(ev, (e) => {
    e.preventDefault();
    els.uploadZone.classList.toggle('dragover', ev === 'dragover');
    if (ev === 'drop') loadFile(e.dataTransfer.files[0]);
  });
});
window.addEventListener('paste', (e) => {
  const item = Array.from(e.clipboardData.items).find((i) => i.type.startsWith('image/'));
  if (item) loadFile(item.getAsFile());
});

/* ── 工具栏 ── */
function setMode(mode) {
  editor && editor.setMode(mode);
  els.btnBrush.classList.toggle('active', mode === 'brush');
  els.btnEraser.classList.toggle('active', mode === 'eraser');
}
els.btnBrush.addEventListener('click', () => setMode('brush'));
els.btnEraser.addEventListener('click', () => setMode('eraser'));
els.brushSize.addEventListener('input', () => {
  els.brushSizeVal.textContent = els.brushSize.value;
  editor && editor.setBrushSize(+els.brushSize.value);
});
els.btnUndo.addEventListener('click', () => { detectRects = null; editor && editor.undo(); });
els.btnClear.addEventListener('click', () => { detectRects = null; editor && editor.clear(); });
/* 手动涂抹后，AI 检测框不再代表当前 mask，分区域修复失效 */
els.stage.addEventListener('pointerdown', () => { detectRects = null; });

/* ── 自动检测水印（YOLO 优先，未就绪时降级启发式） ── */
els.btnAutoDetect.addEventListener('click', async () => {
  if (!editor || busy) return;
  busy = true; refreshButtons();

  try {
    let rects = null;
    if (detectReady) {
      setStatus('AI 正在检测水印…');
      rects = await detector.detect(editor.imgCanvas);
      if (!rects.length) {
        setStatus('AI 未检测到水印，可尝试手动涂抹');
        return;
      }
    } else {
      // 降级：启发式分析（降采样提速，坐标映射回原图）
      setStatus('检测模型未就绪，使用快速检测…');
      const W = editor.imgCanvas.width, H = editor.imgCanvas.height;
      const k = Math.min(1, 1024 / Math.max(W, H));
      const small = document.createElement('canvas');
      small.width = Math.round(W * k); small.height = Math.round(H * k);
      small.getContext('2d').drawImage(editor.imgCanvas, 0, 0, small.width, small.height);
      rects = WATERMARK_DETECT.analyze(small).map((r) => ({
        x: Math.round(r.x / k), y: Math.round(r.y / k),
        w: Math.round(r.w / k), h: Math.round(r.h / k), conf: r.conf,
      }));
      if (!rects.length) {
        setStatus('未检测到明显水印，请手动涂抹');
        return;
      }
    }

    let px;
    if (detectReady) {
      // AI 文本检测框：整体填满为 mask，保证文字笔画完整覆盖、无残留
      px = editor.applyMaskRects(rects);
    } else {
      // 启发式降级路径：框内像素级精修，避免整框误涂
      const bits = WATERMARK_DETECT.refineMask(editor.imgCanvas, rects, { diffThreshold: 20, dilate: 4 });
      px = editor.applyMaskBits(bits);
    }
    if (!px) {
      setStatus('检测区域无需修复的内容，请手动涂抹');
      return;
    }
    detectRects = rects;
    setStatus('检测到 ' + rects.length + ' 处水印，已自动标记，可直接点「开始修复」', 'ok');
  } catch (err) {
    setStatus('自动检测失败：' + String(err.message || err) + '，请手动涂抹', 'err');
  } finally {
    busy = false; refreshButtons();
  }
});
els.fmtSeg.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-fmt]');
  if (!btn) return;
  exportFmt = btn.dataset.fmt;
  els.fmtSeg.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
});

/* ── 修复 ── */
els.btnRun.addEventListener('click', async () => {
  if (!editor || busy) return;
  busy = true; refreshButtons();
  setStatus('正在修复，请稍候…'); setProgress(0);
  // 保存原图用于对比
  originalCanvas = document.createElement('canvas');
  originalCanvas.width = editor.imgCanvas.width;
  originalCanvas.height = editor.imgCanvas.height;
  originalCanvas.getContext('2d').drawImage(editor.imgCanvas, 0, 0);
  const t0 = performance.now();
  try {
    // AI 检测路径：按检测框分区域原生分辨率修复（画质更好）；否则整 mask 单 ROI
    const result = detectRects
      ? await client.runRegions(editor.imgCanvas, editor.maskCanvas, detectRects)
      : await client.run(editor.imgCanvas, editor.maskCanvas);
    if (!result) {
      setStatus('请先涂抹要去除的水印区域');
    } else {
      editor.setImage(result);
      detectRects = null;
      const sec = ((performance.now() - t0) / 1000).toFixed(1);
      setStatus('修复完成，用时 ' + sec + ' 秒。可下载，或返回继续涂抹细节', 'ok');
      setProgress(100);
      els.btnCompare.classList.remove('hidden');
    }
  } catch (err) {
    setStatus(String(err.message || err), 'err');
  }
  busy = false; refreshButtons();
});

/* ── 按住对比原图 ── */
function showOriginal(show) {
  if (!editor || !originalCanvas) return;
  if (show) {
    editor.imgCtx.clearRect(0, 0, editor.imgCanvas.width, editor.imgCanvas.height);
    editor.imgCtx.drawImage(originalCanvas, 0, 0);
    els.btnCompare.textContent = '松开查看结果';
  } else {
    // 重新合成当前结果：originalCanvas 之后的内容即 imgCanvas 修复态
    // 结果已在 setImage 写入，需重画：保存结果副本
    if (els._resultBackup) editor.imgCtx.drawImage(els._resultBackup, 0, 0);
    els.btnCompare.textContent = '按住查看原图';
  }
}
els.btnCompare.addEventListener('pointerdown', () => {
  // 进入对比前先备份当前结果
  els._resultBackup = document.createElement('canvas');
  els._resultBackup.width = editor.imgCanvas.width;
  els._resultBackup.height = editor.imgCanvas.height;
  els._resultBackup.getContext('2d').drawImage(editor.imgCanvas, 0, 0);
  showOriginal(true);
});
['pointerup', 'pointerleave'].forEach((ev) =>
  els.btnCompare.addEventListener(ev, () => showOriginal(false)));

/* ── 下载 / 换图 ── */
els.btnDownload.addEventListener('click', () => {
  if (!editor) return;
  const mime = 'image/' + exportFmt;
  const ext = exportFmt === 'jpeg' ? 'jpg' : exportFmt;
  editor.imgCanvas.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '源图-' + Date.now() + '.' + ext;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, mime, 0.95);
});
els.btnNew.addEventListener('click', () => {
  els.editor.classList.add('hidden');
  els.fileInput.value = '';
  window.scrollTo({ top: 0, behavior: 'smooth' });
});
