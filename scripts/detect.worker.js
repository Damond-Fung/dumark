/* 源图 Dumark — 文本检测 Worker
 * PP-OCRv4 DBNet（百度开源文本检测，ONNX）在 Worker 中运行。
 * 输入: x [1,3,H,W] float32(ImageNet 标准化, RGB, CHW, H/W 为 32 的倍数)
 * 输出: [1,1,H,W] float32 文本概率图（已 sigmoid，0..1）
 */
'use strict';

const ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.3/dist/';
let session = null;

function post(type, extra) { self.postMessage(Object.assign({ type }, extra || {})); }

/* ── IndexedDB 模型缓存（与 inpaint worker 同一策略） ── */
function openDB() {
  return new Promise(function (res, rej) {
    const r = indexedDB.open('demark-model-cache', 1);
    r.onupgradeneeded = function (e) { e.target.result.createObjectStore('models'); };
    r.onsuccess = function (e) { res(e.target.result); };
    r.onerror = function (e) { rej(e.target.error); };
  });
}
function dbGet(db, key) {
  return new Promise(function (res, rej) {
    const r = db.transaction('models', 'readonly').objectStore('models').get(key);
    r.onsuccess = function () { res(r.result); };
    r.onerror = function () { rej(r.error); };
  });
}
function dbPut(db, key, val) {
  return new Promise(function (res, rej) {
    const r = db.transaction('models', 'readwrite').objectStore('models').put(val, key);
    r.onsuccess = function () { res(); };
    r.onerror = function () { rej(r.error); };
  });
}

function isValidModel(buf) {
  return buf && buf.byteLength > 1048576 && new Uint8Array(buf, 0, 1)[0] === 0x08;
}

async function fetchModel(url) {
  let db = null;
  try { db = await openDB(); } catch (e) { /* 不缓存降级 */ }
  if (db) {
    try {
      const cached = await dbGet(db, url);
      if (isValidModel(cached)) return cached;
    } catch (e) { /* 重新下载 */ }
  }
  post('progress', { pct: 10, label: '下载检测模型（约 5MB）…' });
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) throw new Error('检测模型下载失败 HTTP ' + resp.status);
  const buf = await resp.arrayBuffer();
  if (!isValidModel(buf)) throw new Error('检测模型校验失败');
  if (db) { try { await dbPut(db, url, buf); } catch (e) { /* 忽略 */ } }
  return buf;
}

async function init(msg) {
  try {
    importScripts(ORT_BASE + 'ort.min.js');
    const buf = await fetchModel(msg.modelUrl);
    const eps = ['wasm'];
    try { if (msg.preferWebGPU && navigator.gpu) eps.unshift('webgpu'); } catch (e) { /* 保持 wasm */ }
    ort.env.wasm.wasmPaths = ORT_BASE;
    ort.env.wasm.simd = true;
    ort.env.wasm.numThreads = 1;
    session = await ort.InferenceSession.create(buf, {
      executionProviders: eps,
      graphOptimizationLevel: 'all',
    });
    post('ready', { ep: eps[0] });
  } catch (e) {
    post('error', { text: '检测引擎初始化失败：' + String(e && e.message || e) });
  }
}

async function detect(msg) {
  try {
    const imgF32 = new Float32Array(msg.imgArr);
    const t = new ort.Tensor('float32', imgF32, [1, 3, msg.h, msg.w]);
    const feeds = {};
    feeds[session.inputNames[0]] = t;
    const res = await session.run(feeds);
    const out = res[session.outputNames[0]];
    post('boxes', { outArr: out.data.buffer, h: msg.h, w: msg.w }, [out.data.buffer]);
  } catch (e) {
    post('error', { text: '检测失败：' + String(e && e.message || e) });
  }
}

self.onmessage = function (e) {
  const msg = e.data || {};
  if (msg.type === 'init') init(msg);
  else if (msg.type === 'detect') detect(msg);
};
