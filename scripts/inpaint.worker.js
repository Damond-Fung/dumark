/* 源图 Dumark — LaMa 推理 Worker
 * 职责：加载 onnxruntime-web、缓存/加载 LaMa ONNX 模型、执行 inpainting 推理
 * 输入: image [1,3,S,S] float32(0..1, RGB, CHW) + mask [1,1,S,S] float32(1=待修复)
 * 输出: [1,3,S,S] float32(0..1)
 */
'use strict';

const ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.3/dist/';
let session = null;
let inferSize = 512;

function post(type, extra) { self.postMessage(Object.assign({ type }, extra || {})); }

/* ── IndexedDB 模型缓存 ── */
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

/* ONNX protobuf 首字段必为 0x08(ir_version)；且 big-lama 模型应 >100MB */
function isValidModel(buf) {
  return buf && buf.byteLength > 104857600 && new Uint8Array(buf, 0, 1)[0] === 0x08;
}

async function fetchModel(url) {
  let db = null;
  try { db = await openDB(); } catch (e) { /* 私密模式等场景降级为不缓存 */ }
  if (db) {
    try {
      const cached = await dbGet(db, url);
      if (isValidModel(cached)) { post('progress', { pct: 96, label: '从本地缓存加载模型…' }); return cached; }
    } catch (e) { /* 缓存读取失败则重新下载 */ }
  }
  post('progress', { pct: 0, label: '首次使用需下载 AI 模型（约 200MB，仅此一次）…' });
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) throw new Error('模型下载失败 HTTP ' + resp.status);
  const reader = resp.body.getReader();
  const total = parseInt(resp.headers.get('content-length') || '0', 10);
  const chunks = [];
  let received = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    chunks.push(part.value);
    received += part.value.length;
    if (total > 0) {
      post('progress', {
        pct: Math.round(received / total * 92),
        label: '下载模型 ' + Math.round(received / 1048576) + ' / ' + Math.round(total / 1048576) + ' MB',
      });
    }
  }
  const buf = new Uint8Array(received);
  let off = 0;
  chunks.forEach(function (c) { buf.set(c, off); off += c.length; });
  if (!isValidModel(buf.buffer)) throw new Error('模型文件校验失败（可能被缓存污染），请刷新重试');
  if (db) { try { await dbPut(db, url, buf.buffer); } catch (e) { /* 缓存失败不影响使用 */ } }
  return buf.buffer;
}

async function init(msg) {
  try {
    importScripts(ORT_BASE + 'ort.min.js');
    inferSize = msg.size || inferSize;
    const buf = await fetchModel(msg.modelUrl);
    post('progress', { pct: 97, label: '初始化推理会话…' });
    const eps = ['wasm'];
    if (msg.preferWebGPU) {
      try { if (navigator.gpu) eps.unshift('webgpu'); } catch (e) { /* 保持 wasm */ }
    }
    ort.env.wasm.wasmPaths = ORT_BASE;
    ort.env.wasm.simd = true;
    ort.env.wasm.numThreads = 1; // 无 COOP/COEP 环境下 SharedArrayBuffer 不可用，单线程最稳
    session = await ort.InferenceSession.create(buf, {
      executionProviders: eps,
      graphOptimizationLevel: 'all',
    });
    post('ready', { ep: session.executionProvider || eps[0] });
  } catch (e) {
    post('error', { text: '引擎初始化失败：' + String(e && e.message || e) });
  }
}

async function run(msg) {
  try {
    const S = msg.size || inferSize;
    const imgF32 = new Float32Array(msg.imgArr);
    const maskF32 = new Float32Array(msg.maskArr);
    const imgT = new ort.Tensor('float32', imgF32, [1, 3, S, S]);
    const maskT = new ort.Tensor('float32', maskF32, [1, 1, S, S]);
    const feeds = {};
    session.inputNames.forEach(function (name) {
      feeds[name] = /mask/i.test(name) ? maskT : imgT;
    });
    const t0 = performance.now();
    const res = await session.run(feeds);
    const elapsed = performance.now() - t0;
    const out = res[session.outputNames[0]].data;
    post('result', { outArr: out.buffer, size: S, elapsed: Math.round(elapsed) }, [out.buffer]);
  } catch (e) {
    post('error', { text: '修复失败：' + String(e && e.message || e) });
  }
}

self.onmessage = function (e) {
  const msg = e.data || {};
  if (msg.type === 'init') init(msg);
  else if (msg.type === 'run') run(msg);
};
