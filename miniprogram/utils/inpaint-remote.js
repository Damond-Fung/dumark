/* 源图 Dumark 小程序 — 远程 AI 修复接口（预留）
 * 端上引擎画质有限；当 REPAIR.engine 切到 'remote' 且当前环境配置了
 * remoteBase 时，把原图与 mask 图上传到自建服务，由服务端跑 DBNet + LaMa。
 *
 * 接口约定（POST multipart/form-data）：
 *   image  原图文件
 *   mask   mask PNG（白色为待修复区域，透明为保留）
 *   sens   检测灵敏度 low | mid | high
 * 期望响应：{ code: 0, data: { url: '修复结果图片地址' } }
 * 返回结果图片临时路径（已下载到本地）。
 */
import { REPAIR, envVersion } from './config.js';

export function remoteBase() {
  const env = envVersion();
  const base = (REPAIR.remoteBase || {})[env] || '';
  return base ? base.replace(/\/$/, '') : '';
}

export function remoteReady() {
  return REPAIR.engine === 'remote' && !!remoteBase();
}

export function repairByRemote({ imagePath, maskPath, sensitivity }) {
  const base = remoteBase();
  if (!base) {
    return Promise.reject(new Error('未配置远程修复服务地址'));
  }
  return upload(base, imagePath, maskPath, sensitivity).then(download);
}

function upload(base, imagePath, maskPath, sensitivity) {
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: base + '/repair',
      files: [
        { name: 'image', filePath: imagePath },
        { name: 'mask', filePath: maskPath },
      ],
      formData: { sens: sensitivity || 'mid' },
      timeout: 60000,
      success: (res) => {
        let body = null;
        try { body = JSON.parse(res.data); } catch (e) { /* 非 JSON 响应 */ }
        if (res.statusCode !== 200 || !body || body.code !== 0 || !body.data || !body.data.url) {
          reject(new Error('远程修复失败：' + (body && body.message ? body.message : '响应异常')));
          return;
        }
        resolve(body.data.url);
      },
      fail: (err) => reject(new Error('远程修复请求失败：' + (err.errMsg || '网络异常'))),
    });
  });
}

function download(url) {
  return new Promise((resolve, reject) => {
    wx.downloadFile({
      url,
      timeout: 60000,
      success: (res) => {
        if (res.statusCode === 200) resolve(res.tempFilePath);
        else reject(new Error('结果下载失败（HTTP ' + res.statusCode + '）'));
      },
      fail: (err) => reject(new Error('结果下载失败：' + (err.errMsg || '网络异常'))),
    });
  });
}
