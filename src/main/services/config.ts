// config.ts —— 全局固定常量（跨平台共用，类似 Python 版的 config.py）
// 想调整默认行为、扩展名白名单等，集中改这里。
// 注意：渲染进程的网格/缩略图尺寸也取自这里（经 preload 的 readConfig 下发），
//       不要在界面里另写一份，避免两边不一致。

// 素材类型标识
export const KIND_PHOTO = 'photo';
export const KIND_VIDEO = 'video';

// 照片扩展名白名单（含常见 RAW 格式，统一小写）
export const PHOTO_EXTS: string[] = [
  '.jpg', '.jpeg', '.png', '.dng', '.heic', '.heif', '.webp',
  '.gif', '.tif', '.tiff', '.bmp', '.cr2', '.cr3', '.nef',
  '.arw', '.raf', '.rw2', '.orf',
];

// 视频扩展名白名单
export const VIDEO_EXTS: string[] = [
  '.mp4', '.mov', '.mkv', '.avi', '.flv', '.webm', '.m4v',
  '.3gp', '.3g2', '.mts', '.m2ts', '.mpg', '.mpeg', '.wmv',
];

// 相机/读卡器里素材所在的标准文件夹名
export const DCIM_FOLDER = 'DCIM';

// 复制时每次读写的块大小（1MB，控制进度刷新频率与内存占用）
export const COPY_CHUNK_SIZE = 1 << 20;

// 日期格式
export const DATE_FOLDER_FORMAT = 'YYYY-MM-DD'; // 按日期建子文件夹的目录名格式
export const DISPLAY_TIME_FORMAT = 'YYYY-MM-DD HH:mm:ss'; // 列表展示格式

// 缩略图规格：thumb 为请求边长(px)，cellW/cellH 为图标视图每格像素尺寸
export interface ThumbSpec {
  thumb: number;
  cellW?: number;
  cellH?: number;
}
export const THUMB_SIZES: Record<string, ThumbSpec> = {
  detail: { thumb: 22 },
  icon_small: { thumb: 48, cellW: 112, cellH: 94 },
  icon_medium: { thumb: 96, cellW: 154, cellH: 144 },
  icon_large: { thumb: 144, cellW: 204, cellH: 196 },
};

// 缩略图缓存上限（超出直接清空，缩略图可重新生成）
export const THUMB_CACHE_MAX = 2000;

// 允许渲染进程请求缩略图的目标边长（防止任意尺寸解码）
export const THUMB_ALLOWED_SIZES: number[] = [22, 48, 96, 144];

// 需要下发到渲染进程的常量子集结构
export interface RendererConfig {
  THUMB_SIZES: Record<string, ThumbSpec>;
  PHOTO_EXTS: string[];
  VIDEO_EXTS: string[];
  DCIM_FOLDER: string;
  DATE_FOLDER_FORMAT: string;
}

/**
 * 组装并返回"需要下发到渲染进程"的常量子集。
 * 界面端的网格/缩略图尺寸、扩展名白名单等都以这里为单一来源，
 * 避免主进程与渲染进程各写一份导致不一致（例如缩略图请求尺寸对不上白名单）。
 * @returns {RendererConfig} 包含 THUMB_SIZES / PHOTO_EXTS / VIDEO_EXTS / DCIM_FOLDER / DATE_FOLDER_FORMAT 的轻量对象
 */
export function rendererConfig(): RendererConfig {
  return {
    THUMB_SIZES,
    PHOTO_EXTS,
    VIDEO_EXTS,
    DCIM_FOLDER,
    DATE_FOLDER_FORMAT,
  };
}
