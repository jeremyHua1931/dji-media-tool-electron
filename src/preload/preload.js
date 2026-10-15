// preload.js —— 预加载脚本（安全桥接层）
// ============================================================
// 在隔离的上下文里把主进程能力暴露为受控的 window.api，
// 渲染进程只通过这些方法请求文件系统操作，无法直接访问 Node。
// 沙箱已开启（sandbox: true），本文件只用 contextBridge + ipcRenderer.invoke/on，
// 不依赖任何 Node 模块。
//
// 桥接原则：
//   - 只暴露固定的一组方法，不提供任何"通用转发通道"（如 ipcRenderer.send 透传）；
//   - 方法名与 ipc.js 的 channel 一一对应，参数直接透传给主进程做类型收敛；
//   - 事件订阅返回"取消订阅"函数，防止界面反复调用时监听器叠加。

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// exposeInMainWorld 会把下面整个对象挂到 window.api 上（冻结不可篡改）
contextBridge.exposeInMainWorld('api', {
  // 主进程下发的界面常量（缩略图/网格尺寸、扩展名白名单）
  readConfig: () => ipcRenderer.invoke('app:config'),

  // 磁盘 / 相机
  listVolumes: () => ipcRenderer.invoke('drives:list'),
  detectCameras: () => ipcRenderer.invoke('drives:detect'),

  // 建议的素材来源（相机 -> DCIM -> 素材最多的子文件夹）
  suggestMediaRoot: () => ipcRenderer.invoke('camera:suggest'),

  // 选择文件夹（返回路径或 null）
  pickFolder: (title) => ipcRenderer.invoke('dialog:pickFolder', title),

  // 扫描：payload 见 ipc.js 的 scan:start
  scan: (payload) => ipcRenderer.invoke('scan:start', payload),

  // 缩略图：返回 { ok, data?:Uint8Array, error? }
  getThumbnail: (filePath, size) => ipcRenderer.invoke('thumb:get', filePath, size),

  // 系统默认应用打开 / 在文件管理器中定位
  openPath: (targetPath) => ipcRenderer.invoke('shell:open', targetPath),
  revealPath: (targetPath) => ipcRenderer.invoke('shell:reveal', targetPath),

  // 复制前检查：目标不能落在源盘/源目录内，且目标盘空间要够
  preflightCopy: (payload) => ipcRenderer.invoke('copy:preflight', payload),

  // 复制
  startCopy: (payload) => ipcRenderer.invoke('copy:start', payload),
  cancelCopy: () => ipcRenderer.invoke('copy:cancel'),

  // 主进程事件订阅（返回取消订阅函数）
  // 订阅前先移除同通道的旧监听，保证多次调用不会叠加
  onCopyProgress: (cb) => {
    const listener = (_e, info) => cb(info);
    ipcRenderer.on('copy:progress', listener);
    return () => ipcRenderer.removeListener('copy:progress', listener);
  },
  onCopyDone: (cb) => {
    const listener = (_e, summary) => cb(summary);
    ipcRenderer.on('copy:done', listener);
    return () => ipcRenderer.removeListener('copy:done', listener);
  },
});
