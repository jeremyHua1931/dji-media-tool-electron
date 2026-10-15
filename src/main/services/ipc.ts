// ipc.ts —— 注册所有主进程 IPC 处理器
// ============================================================
// 从主入口抽出，便于主程序与冒烟测试共用。
// getWindow() 返回当前主窗口，用于弹对话框与推送进度事件。
//
// 安全约束（渲染进程即使被注入也无法越权）：
//   1. thumb:get 只允许请求「本次扫描命中过的目录」里的文件，且尺寸受限；
//   2. scan:start 只接受字符串根路径，参数做类型收敛；
//   3. 不向渲染进程暴露任何通用的 ipcRenderer 转发通道。

import path from 'path';
import { ipcMain, dialog, shell } from 'electron';
import type { BrowserWindow, OpenDialogOptions } from 'electron';
import { listVolumes, detectCameras, suggestMediaRoot } from './drives';
import { scanMedia } from './scanner';
import type { MediaFile } from './scanner';
import { copyFiles } from './copier';
import { getThumbnail } from './thumbnails';
import { rendererConfig } from './config';
import { checkCopyPreflight } from './preflight';

let cancelCopy = false; // 当前复制任务的取消标志（单窗口应用，够用）

// 允许取缩略图的目录白名单：每次扫描成功后刷新为「命中素材所在目录 + 扫描根」
let thumbRoots: string[] = [];

/**
 * 跨平台路径相等判断（Windows 忽略大小写，类 Unix 严格区分）。
 * 先 resolve 成绝对路径并去掉末尾的分隔符，再比较，避免 "F:\" 与 "F:"、"F:\\DCIM" 之类的写法差异。
 * @param a 第一个路径
 * @param b 第二个路径
 * @returns 是否指向同一个路径
 */
function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => path.resolve(p).replace(/[\\/]+$/, '');
  const na = norm(a);
  const nb = norm(b);
  return process.platform === 'win32'
    ? na.toLowerCase() === nb.toLowerCase()
    : na === nb;
}

/**
 * 判断 child 是否位于 parent 目录内部（含二者相等的情况）。
 * 通过 path.relative 判断：相对路径为空（相等）或不以 ".." 开头且不是绝对路径即视为在内部。
 * 用于「只读保证」与「缩略图目录白名单」两类安全检查。
 * @param child 待判断的子路径
 * @param parent 父目录路径
 * @returns child 是否在 parent 之内
 */
function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 缩略图文件白名单检查：只有"本次扫描命中过的目录（thumbRoots）内部"的文件才允许取图。
 * 这样即使渲染进程被注入恶意脚本，也无法用它去解码磁盘上任意文件的缩略图。
 * @param filePath 待校验的文件路径（非字符串或空串直接拒绝）
 * @returns 是否允许读取该文件的缩略图
 */
function thumbAllowed(filePath: unknown): boolean {
  if (typeof filePath !== 'string' || !filePath) return false;
  return thumbRoots.some((root) => isInside(filePath, root));
}

/**
 * 注册全部 IPC 处理器（主进程能力入口）。
 * 所有处理器都在主进程执行，渲染进程只通过 window.api 调用；
 * 参数一律做类型收敛，避免渲染进程传任意对象进来。
 * @param getWindow 返回当前主窗口的闭包
 *   （窗口可能尚未创建或已销毁，send 时统一判空），用于弹对话框与推送进度事件
 */
export function registerIpc(getWindow: () => BrowserWindow | null): void {
  const send = (channel: string, data: unknown): void => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, data);
  };

  // 渲染进程需要的常量（网格/缩略图尺寸、扩展名白名单），单一来源
  ipcMain.handle('app:config', () => rendererConfig());

  // 磁盘 / 相机
  ipcMain.handle('drives:list', () => listVolumes());
  ipcMain.handle('drives:detect', () => detectCameras());

  // 建议的素材来源：相机卷 -> DCIM -> 素材最多的子文件夹（如 F:\DCIM\DJI_001）
  ipcMain.handle('camera:suggest', () => suggestMediaRoot());

  // 选择文件夹（返回路径或 null）
  ipcMain.handle('dialog:pickFolder', async (_e, title) => {
    const win = getWindow();
    const opts: OpenDialogOptions = {
      title: typeof title === 'string' && title ? title : '选择文件夹',
      properties: ['openDirectory'],
    };
    const res = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths[0];
  });

  // 扫描
  ipcMain.handle('scan:start', async (_e, payload) => {
    const p = (payload || {}) as Record<string, unknown>;
    if (typeof p.root !== 'string' || !p.root.trim()) {
      throw new Error('素材来源无效');
    }
    const start = typeof p.startISO === 'string' ? new Date(p.startISO) : null;
    const end = typeof p.endISO === 'string' ? new Date(p.endISO) : null;

    const files = await scanMedia(p.root, {
      start: start && !Number.isNaN(start.getTime()) ? start : null,
      end: end && !Number.isNaN(end.getTime()) ? end : null,
      wantPhoto: p.wantPhoto !== false,
      wantVideo: p.wantVideo !== false,
      dcimOnly: p.dcimOnly !== false,
    });

    // 刷新缩略图白名单：命中的目录 + 扫描根（用户可能直接选到 DCIM 上级）
    const dirs = new Set([path.resolve(p.root)]);
    for (const f of files) dirs.add(path.dirname(f.path));
    thumbRoots = [...dirs];
    return files;
  });

  // 缩略图（受白名单与尺寸限制）
  ipcMain.handle('thumb:get', async (_e, filePath, size) => {
    if (!thumbAllowed(filePath)) return { ok: false, error: 'forbidden' };
    const res = await getThumbnail(filePath, size);
    if (!res.ok) return { ok: false, error: res.error };
    // Buffer -> Uint8Array 走结构化克隆，渲染端拿到的是 Uint8Array
    return { ok: true, data: new Uint8Array(res.data as Buffer) };
  });

  // 系统默认应用打开文件
  ipcMain.handle('shell:open', async (_e, targetPath) => {
    if (typeof targetPath !== 'string' || !targetPath) return '路径无效';
    const err = await shell.openPath(targetPath);
    return err || '';
  });

  // 在文件管理器中定位（选中该文件）
  ipcMain.handle('shell:reveal', (_e, targetPath) => {
    if (typeof targetPath !== 'string' || !targetPath) return false;
    shell.showItemInFolder(targetPath);
    return true;
  });

  // 复制前检查：目标是否落在源盘/源目录内、目标盘剩余空间是否足够。
  // 单独开一个通道，界面可以在用户选完文件夹后立刻给出提示。
  ipcMain.handle('copy:preflight', async (_e, payload) => {
    const p = (payload || {}) as Record<string, unknown>;
    return checkCopyPreflight({
      dest: typeof p.dest === 'string' ? p.dest : '',
      sourceRoot: typeof p.sourceRoot === 'string' ? p.sourceRoot : '',
      totalBytes: Number(p.totalBytes) || 0,
      fileCount: Number(p.fileCount) || 0,
    });
  });

  // 复制
  ipcMain.handle('copy:start', async (_e, payload) => {
    const p = (payload || {}) as Record<string, unknown>;
    const files = Array.isArray(p.files) ? (p.files as MediaFile[]) : [];
    const dest = typeof p.dest === 'string' ? p.dest.trim() : '';
    const sourceRoot = typeof p.sourceRoot === 'string' ? p.sourceRoot.trim() : '';
    if (files.length === 0) throw new Error('没有要复制的文件');
    if (!dest) throw new Error('目标文件夹无效');

    // 主进程侧再校验一次：界面被绕过也必须挡住"往相机里写"的操作
    const totalBytes = files.reduce((s, f) => s + (Number(f && f.size) || 0), 0);
    const gate = await checkCopyPreflight({
      dest, sourceRoot: sourceRoot || dest, totalBytes, fileCount: files.length,
    });
    if (!gate.ok && gate.code !== 'NO_SOURCE') {
      const err = new Error(gate.message || '复制前检查未通过');
      (err as Error & { code?: string }).code = gate.code;
      throw err;
    }

    cancelCopy = false;
    const summary = await copyFiles(files, dest, {
      byDate: !!p.byDate,
      onConflict: typeof p.onConflict === 'string' ? (p.onConflict as 'skip' | 'overwrite' | 'rename') : 'skip',
      onlyNew: !!p.onlyNew,
      verify: p.verify !== false,
      isCancelled: () => cancelCopy,
      progress: (info) => send('copy:progress', info),
    });
    send('copy:done', summary);
    return summary;
  });

  ipcMain.handle('copy:cancel', () => {
    cancelCopy = true;
    return true;
  });
}
