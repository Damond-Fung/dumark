/* 源图 Dumark — 手机 App 版控制器
 * 复用主站模块：MaskEditor / InpaintClient / DetectClient / 检测增强
 * 屏幕流：首页 → 涂抹编辑 → 自动检测/修复 → 拖动对比 → 保存
 */
import { MaskEditor } from './editor.js';
import { InpaintClient } from './inpaint.js';
import { DetectClient } from './detect-client.js';
import { detectWatermarks } from './mobile-detect.js';
import { MODELS } from './models.config.js';
import { initCompare } from './mobile-compare.js';

const $ = (id) => document.getElementById(id);
const els = {
  home: $('screenHome'), editorScreen: $('screenEditor'),
  enginePill: $('enginePill'),
  album: $('btnAlbum'), camera: $('btnCamera'),
  fileInput: $('fileInput'), cameraInput: $('cameraInput'),
  recentCard: $('recentCard'), recentThumb: $('recentThumb'), recentMeta: $('recentMeta'),
  btnRecentOpen: $('btnRecentOpen'),
  stage: $('stage'), stageEmpty: $('stageEmpty'), editorTitle: $('editorTitle'),
  btnBack: $('btnBack'), btnUndo: $('btnUndo'), btnClear: $('btnClear'),
  btnBrush: $('btnBrush'), btnEraser: $('btnEraser'),
  brushSize: $('brushSize'), sizeVal: $('sizeVal'),
  btnAutoDetect: $('btnAutoDetect'), btnRun: $('btnRun'),
  sensSeg: $('sensSeg'), hint: $('hint'),
  loading: $('loading'), progressFill: $('progressFill'), loadingText: $('loadingText'),
  result: $('resultOverlay'), resultSub: $('resultSub'),
  btnDownload: $('btnDownload'), btnReEdit: $('btnReEdit'),
};

const MAX_FILE_MB = 10;
let editor = null;
let modelReady = false;
let detectReady = false;
let busy = false;
let hasMask = false;
let detectRects = null;
let originalCanvas = null;   // 修复前原图（对比用）
let lastResult = null;       // 本次会话最近一次结果（首页「本次处理」）
let lastOriginal = null;     // 最近一次结果的修复前原图
let lastMeta = '';
let compare = null;
let sens = localStorage.getItem('dumark.detect.sens') || 'mid';

/* ── 通用 UI ── */
function showScreen(name) {
  const isEditor = name === 'editor';
  els.home.classList.toggle('is-active', !isEditor);
  els.editorScreen.classList.toggle('is-active', isEditor);
}
function setHint(text, cls) {
  els.hint.textContent = text;
  els.hint.className = 'hint' + (cls ? ' ' + cls : '');
}
function setPill(text, cls) {
  els.enginePill.textContent = text;
  els.enginePill.className = 'pill' + (cls ? ' ' + cls : '');
}
function setLoading(show, text) {
  els.loading.classList.toggle('hidden', !show);
  if (text) els.loadingText.textContent = text;
}
function setProgress(pct) { els.progressFill.style.width = Math.min(100, pct) + '%'; }

/* mask 状态变化时刷新按钮（修复后 mask 清空 → 按钮禁用） */
function onMaskChange(v) {
  hasMask = v;
  els.btnRun.disabled = !(modelReady && v && !busy);
}

/* ── 推理客户端 ── */
const client = new InpaintClient({
  onProgress: (m) => {
    if (busy) { setProgress(m.pct); els.loadingText.textContent = m.label || '正在修复…'; }
    else setPill('引擎 ' + m.pct + '%');
  },
  onReady: (m) => {
    modelReady = true;
    setPill('引擎就绪', 'ok');
    if (editor) onMaskChange(hasMask);
  },
  onError: (text) => {
    setPill('引擎异常', 'err');
    busy = false; setLoading(false);
    setHint(text, 'err');
  },
});
client.init(MODELS.inpaint);

const detector = new DetectClient({ onReady: () => { detectReady = true; }, onError: () => { detectReady = false; } });
detector.init(MODELS.detect);

/* ── 图片载入 ── */
function loadFile(file) {
  if (!file) return;
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { setHint('仅支持 PNG / JPG / WEBP', 'err'); return; }
  if (file.size > MAX_FILE_MB * 1048576) { setHint('图片超过 10MB 限制', 'err'); return; }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    showScreen('editor');
    els.result.classList.add('hidden');
    els.editorTitle.textContent = '涂抹水印';
    els.stageEmpty.classList.remove('hidden');
    if (!editor) editor = new MaskEditor(els.stage, { onMaskChange });
    const size = editor.loadImage(img);
    originalCanvas = null;
    detectRects = null;
    els.stageEmpty.classList.add('hidden');
    onMaskChange(false);
    setHint(modelReady
      ? '已载入 ' + size.width + '×' + size.height + '，涂抹水印或点「自动检测」'
      : '图片已载入，修复引擎仍在加载…');
  };
  img.onerror = () => setHint('图片解码失败', 'err');
  img.src = url;
}

/* ── 首页交互 ── */
els.album.addEventListener('click', () => els.fileInput.click());
els.camera.addEventListener('click', () => els.cameraInput.click());
els.fileInput.addEventListener('change', (e) => { loadFile(e.target.files[0]); e.target.value = ''; });
els.cameraInput.addEventListener('change', (e) => { loadFile(e.target.files[0]); e.target.value = ''; });
els.btnRecentOpen.addEventListener('click', () => {
  if (!lastResult) return;
  const img = new Image();
  img.onload = () => {
    showScreen('editor');
    els.stageEmpty.classList.add('hidden');
    if (!editor) editor = new MaskEditor(els.stage, { onMaskChange });
    editor.loadImage(img);
    originalCanvas = lastOriginal;
    els.editorTitle.textContent = '处理结果';
    showResult(lastMeta);
    detectRects = null;
  };
  img.src = lastResult.toDataURL('image/png');
});

/* ── 编辑器工具栏 ── */
els.btnBack.addEventListener('click', () => {
  els.result.classList.add('hidden');
  showScreen('home');
});
function setMode(mode) {
  editor && editor.setMode(mode);
  els.btnBrush.classList.toggle('active', mode === 'brush');
  els.btnEraser.classList.toggle('active', mode === 'eraser');
}
els.btnBrush.addEventListener('click', () => setMode('brush'));
els.btnEraser.addEventListener('click', () => setMode('eraser'));
els.brushSize.addEventListener('input', () => {
  els.sizeVal.textContent = els.brushSize.value;
  editor && editor.setBrushSize(+els.brushSize.value);
});
els.btnUndo.addEventListener('click', () => { detectRects = null; editor && editor.undo(); });
els.btnClear.addEventListener('click', () => { detectRects = null; editor && editor.clear(); });
els.stage.addEventListener('pointerdown', () => { detectRects = null; });

/* 灵敏度分档（记忆） */
(function initSens() {
  if (!/^(low|mid|high)$/.test(sens)) sens = 'mid';
  els.sensSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.sens === sens));
})();
els.sensSeg.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-sens]');
  if (!btn) return;
  sens = btn.dataset.sens;
  localStorage.setItem('dumark.detect.sens', sens);
  els.sensSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
});

/* ── 自动检测 ── */
els.btnAutoDetect.addEventListener('click', async () => {
  if (!editor || busy) return;
  busy = true; els.btnRun.disabled = true;
  try {
    setHint(detectReady ? 'AI 正在检测水印…' : '检测模型未就绪，使用快速检测…');
    const { rects, bits, extra, empty } = await detectWatermarks(editor.imgCanvas, detector, {
      ready: detectReady, sensitivity: sens,
    });
    if (empty) { setHint(empty); return; }
    const px = editor.applyMaskBits(bits);
    if (!px) { setHint('检测区域无需修复，请手动涂抹'); return; }
    detectRects = rects;
    setHint('检测到 ' + rects.length + ' 处水印' + extra + '，可直接修复', 'ok');
  } catch (err) {
    setHint('自动检测失败：' + (err.message || err), 'err');
  } finally {
    busy = false;
    els.btnRun.disabled = !(modelReady && hasMask);
  }
});

/* ── 修复 ── */
els.btnRun.addEventListener('click', async () => {
  if (!editor || busy) return;
  busy = true; els.btnRun.disabled = true;
  setLoading(true, '正在修复，请稍候…'); setProgress(0);

  originalCanvas = document.createElement('canvas');
  originalCanvas.width = editor.imgCanvas.width;
  originalCanvas.height = editor.imgCanvas.height;
  originalCanvas.getContext('2d').drawImage(editor.imgCanvas, 0, 0);

  const t0 = performance.now();
  try {
    const result = detectRects
      ? await client.runRegions(editor.imgCanvas, editor.maskCanvas, detectRects)
      : await client.run(editor.imgCanvas, editor.maskCanvas);
    if (!result) {
      setHint('请先涂抹要去除的水印区域', 'err');
    } else {
      editor.setImage(result);
      detectRects = null;
      const sec = ((performance.now() - t0) / 1000).toFixed(1);
      showResult(editor.imgCanvas.width + '×' + editor.imgCanvas.height + ' · ' + sec + 's');
      setHint('修复完成，用时 ' + sec + ' 秒，可拖动对比后保存', 'ok');
      setProgress(100);
      saveRecent(sec);
    }
  } catch (err) {
    setHint(String(err.message || err), 'err');
  } finally {
    busy = false;
    setLoading(false);
    els.btnRun.disabled = !(modelReady && hasMask);
  }
});

/* ── 结果视图 ── */
function showResult(meta) {
  if (!compare) compare = initCompare($('cmp'));
  compare.paint(originalCanvas, editor.imgCanvas);
  els.resultSub.textContent = meta
    ? meta + ' · 左右拖动滑块对比'
    : '左右拖动滑块，对比修复前后';
  els.editorTitle.textContent = '处理结果';
  els.result.classList.remove('hidden');
  els.btnRun.disabled = true;
}

els.btnReEdit.addEventListener('click', () => {
  els.result.classList.add('hidden');
  els.editorTitle.textContent = '继续精修';
  els.btnRun.disabled = !(modelReady && hasMask);
});

/* 最近一次处理（仅本次会话真实结果） */
function saveRecent(sec) {
  lastResult = document.createElement('canvas');
  lastResult.width = editor.imgCanvas.width;
  lastResult.height = editor.imgCanvas.height;
  lastResult.getContext('2d').drawImage(editor.imgCanvas, 0, 0);
  lastOriginal = document.createElement('canvas');
  lastOriginal.width = originalCanvas.width;
  lastOriginal.height = originalCanvas.height;
  lastOriginal.getContext('2d').drawImage(originalCanvas, 0, 0);
  lastMeta = editor.imgCanvas.width + '×' + editor.imgCanvas.height + ' · ' + sec + 's';

  const thumb = document.createElement('canvas');
  const k = 116 / Math.max(editor.imgCanvas.width, editor.imgCanvas.height);
  thumb.width = Math.round(editor.imgCanvas.width * k);
  thumb.height = Math.round(editor.imgCanvas.height * k);
  thumb.getContext('2d').drawImage(editor.imgCanvas, 0, 0, thumb.width, thumb.height);
  els.recentThumb.src = thumb.toDataURL('image/jpeg', 0.8);
  els.recentMeta.textContent = lastMeta;
  els.recentCard.classList.remove('hidden');
}

/* ── 保存（优先系统分享，回退下载） ── */
els.btnDownload.addEventListener('click', () => {
  if (!editor) return;
  editor.imgCanvas.toBlob(async (blob) => {
    if (!blob) return;
    const name = '源图-' + Date.now() + '.png';
    const file = new File([blob], name, { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: '源图 Dumark' }); return; } catch (e) { /* 用户取消则回退 */ }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    setHint('已保存图片', 'ok');
  }, 'image/png');
});
