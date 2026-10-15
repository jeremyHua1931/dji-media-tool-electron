// index.d.ts —— preload 暴露给渲染进程的 window.api 类型声明
// ============================================================
// 仅供编辑器 / tsc 做类型提示，不参与 electron-vite 构建（preload 入口是 index.js）。
// 与 preload/index.js 的 contextBridge.exposeInMainWorld('api', {...}) 保持一致。

// 复制进度事件（copy:progress）
export interface CopyProgressInfo {
  idx: number;          // 当前第几个
  total: number;        // 总数
  name: string;         // 当前文件名
  doneBytes: number;    // 已完成字节
  totalBytes: number;   // 总字节
}

// 复制完成汇总（copy:done / startCopy 返回）
export interface CopySummary {
  copied: number;                 // 成功写入数
  alreadyExists: number;          // 已存在跳过（onlyNew）数
  skipped: number;                // 撞名跳过（conflict=skip）数
  renamed: number;                // 自动改名数
  verified: number;               // 校验通过数
  failed: { name: string; error: string }[]; // 失败明细
  cancelled: boolean;             // 是否被取消
  bytesCopied: number;            // 累计写入字节
}

// 扫描命中的单个素材文件
export interface MediaFile {
  path: string;                   // 完整路径
  name: string;                   // 文件名
  size: number;                   // 字节数
  mtime: string;                  // 拍摄/修改时间（ISO）
  kind: 'photo' | 'video';
  dir: string;                    // 所在文件夹
}

// 检测到的相机/存储卡
export interface CameraInfo { name: string; root: string }

// 复制前检查结果（copy:preflight）
export interface PreflightResult {
  ok: boolean;
  code?: string;
  message?: string;
  availableBytes?: number;        // 目标盘可用空间（跨盘放行时）
}

// preload 暴露到 window.api 的完整能力面（与 index.js 一一对应）
export interface Api {
  readConfig(): Promise<Record<string, unknown>>;
  listVolumes(): Promise<string[]>;
  detectCameras(): Promise<CameraInfo[]>;
  suggestMediaRoot(): Promise<{ root: string; fileCount?: number } | null>;
  pickFolder(title: string): Promise<string | null>;
  scan(payload: unknown): Promise<MediaFile[]>;
  getThumbnail(filePath: string, size: number): Promise<{ ok: boolean; data?: Uint8Array; error?: string }>;
  openPath(targetPath: string): Promise<string>;
  revealPath(targetPath: string): Promise<boolean>;
  preflightCopy(payload: unknown): Promise<PreflightResult>;
  startCopy(payload: unknown): Promise<CopySummary>;
  cancelCopy(): Promise<boolean>;
  onCopyProgress(cb: (info: CopyProgressInfo) => void): () => void;
  onCopyDone(cb: (summary: CopySummary) => void): () => void;
}

// 挂到全局 window 上，渲染进程里 window.api.xxx 有完整类型
declare global {
  interface Window { api: Api }
}
