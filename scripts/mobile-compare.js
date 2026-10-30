/* 源图 Dumark 手机版 — 拖动式前后对比
 * 两层画布叠加：底层修复前，顶层修复后按 --clip 左侧裁剪，手柄可拖动。
 */
export function initCompare(wrap) {
  const orig = wrap.querySelector('#cmpOrig');
  const after = wrap.querySelector('#cmpAfterCanvas');
  const handle = wrap.querySelector('.cmp-handle');
  let dragging = false;

  const setClip = (pct) => {
    const v = Math.max(2, Math.min(98, pct));
    wrap.style.setProperty('--clip', v + '%');
  };

  const move = (e) => {
    const rect = wrap.getBoundingClientRect();
    setClip(((e.clientX - rect.left) / rect.width) * 100);
  };

  wrap.addEventListener('pointerdown', (e) => {
    dragging = true;
    wrap.setPointerCapture(e.pointerId);
    move(e);
  });
  wrap.addEventListener('pointermove', (e) => { if (dragging) move(e); });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) =>
    wrap.addEventListener(ev, () => { dragging = false; }));

  /* 用原始图和修复结果重绘两层画布 */
  function paint(originalCanvas, resultCanvas) {
    if (!originalCanvas || !resultCanvas) return;
    wrap.style.aspectRatio = resultCanvas.width + ' / ' + resultCanvas.height;
    [orig, after].forEach((c) => {
      c.width = resultCanvas.width;
      c.height = resultCanvas.height;
    });
    orig.getContext('2d').drawImage(originalCanvas, 0, 0);
    after.getContext('2d').drawImage(resultCanvas, 0, 0);
    setClip(50);
  }

  setClip(50);
  return { paint, reset: () => setClip(50) };
}
