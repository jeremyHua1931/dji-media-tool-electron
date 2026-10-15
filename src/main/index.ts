// index.ts —— Electron 主进程（应用入口，electron-vite + TS 版）
// ============================================================
// 职责：
//   1. 创建应用主窗口（BrowserWindow），并配置窗口尺寸、标题与安全选项；
//   2. 调用 ipc.ts 的 registerIpc 注册所有 IPC 处理器；
//   3. 处理应用生命周期事件（ready / activate / window-all-closed）。
//
// electron-vite 会把主进程构建到 out/main/，因此：
//   - preload 指向 out/preload/index.js（join(__dirname, '../preload/index.js')）；
//   - 渲染进程在「开发模式」由 vite dev server 提供（ELECTRON_RENDERER_URL），
//     「生产模式」加载构建产物 out/renderer/index.html。
//
// 安全策略（Electron 官方推荐的最小权限模型）：
//   - contextIsolation = true ：渲染进程与 preload 各自独立上下文，页面脚本拿不到 Node 能力；
//   - nodeIntegration = false ：渲染进程禁用 Node 集成；
//   - sandbox = true          ：preload 也运行在沙箱中，只能使用 contextBridge / ipcRenderer；
//   - 渲染进程一切文件系统操作都通过 preload 暴露的 window.api 走 IPC 到主进程完成。

import path from 'path';
import { app, BrowserWindow } from 'electron';
import { registerIpc } from './services/ipc';

// 全局持有主窗口引用：防止窗口对象被 GC 回收，也供 IPC 处理器弹对话框 / 推送进度事件用
let mainWindow: BrowserWindow | null = null;

/**
 * 创建应用主窗口。
 * - 默认尺寸 1080x780，最小 900x640（保证窄屏下界面不挤坏）；
 * - autoHideMenuBar 隐藏菜单栏，界面更贴近"工具"而非"应用"；
 * - webPreferences.preload 指向 preload 脚本（构建产物 out/preload/index.js）；
 * - 开发模式加载 vite dev server（支持热更新），生产模式加载本地 index.html。
 * @returns 创建好的主窗口实例
 */
function createWindow(): BrowserWindow {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 780,
    minWidth: 900,
    minHeight: 640,
    title: 'DJI Pocket 素材筛选复制工具',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true, // preload 只用 contextBridge/ipcRenderer，无需 Node，保持沙箱
    },
  });

  // 开发模式：electron-vite 会注入 ELECTRON_RENDERER_URL（指向 vite dev server），
  // 支持 HMR 与实时调试；生产模式：加载 electron-vite 构建出的本地页面。
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  return mainWindow;
}

app.whenReady().then(() => {
  // 应用就绪：先注册 IPC（此时主窗口可能还不存在，getWindow 闭包会等窗口创建后生效），
  // 再创建主窗口。注意 registerIpc 必须在 createWindow 之前调用，
  // 否则渲染进程一加载就可能请求接口而处理器尚未注册。
  registerIpc(() => mainWindow);
  createWindow();

  // macOS 专属：点击 Dock 图标且没有窗口时重建一个（macOS 习惯是关窗不退出应用）
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// 所有窗口都关闭时退出应用；macOS 例外（保留进程，等 activate 事件再开窗）
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
