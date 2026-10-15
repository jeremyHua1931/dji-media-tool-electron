// thumbnails.ts —— 缩略图（主进程）
// ============================================================
// 照片：nativeImage.createThumbnailFromPath 生成真实缩略图。
// 视频：同样先试系统缩略图（Windows / macOS 可出首帧），不行则退回占位图标。
// 说明：曾经用 img.toDataURL() 把整图转 base64，几百张素材会撑爆内存，
//       现改为 toJPEG(quality) 取 Buffer，经 IPC 传 Uint8Array，
//       渲染进程用 Blob URL 显示，并负责 revoke。

import { THUMB_CACHE_MAX, THUMB_ALLOWED_SIZES } from './config';

// nativeImage 仅在 Electron 主进程可用；纯 Node 测试环境下会缺失，做降级。
// 用运行时 require（而非顶部静态 import），才能在纯 Node 环境捕获失败。
// 这里用结构类型描述 nativeImage 能力面，避免依赖 electron 类型命名空间的导出差异。
interface ThumbNativeImage {
  isEmpty(): boolean;
  toJPEG(quality: number): Buffer;
}
interface ThumbAPI {
  createThumbnailFromPath(filePath: string, opts: { width: number; height: number }): Promise<ThumbNativeImage>;
}
let nativeImage: ThumbAPI | null = null;
try {
  // @ts-ignore —— 纯 Node 测试环境下 require('electron') 会失败，捕获后降级
  nativeImage = (require('electron') as { nativeImage: ThumbAPI }).nativeImage;
} catch {
  nativeImage = null;
}

// 缩略图结果（缓存单位）：成功带 Buffer，失败带 error（负缓存）
interface ThumbResult {
  ok: boolean;
  data?: Buffer;
  error?: string;
}

// key: `${size}:${path}` -> ThumbResult
// 失败结果也缓存（负缓存），避免对同一批不支持的文件反复尝试解码。
const cache = new Map<string, ThumbResult>();

/**
 * 写入缓存（带容量上限的 LRU 简化版：满了直接整体清空）。
 * 失败结果也缓存（负缓存），避免对同一批不支持的文件反复尝试解码。
 * @param key 缓存键（"${size}:${path}"）
 * @param value 缓存值（{ok, data?|error?}）
 * @returns 原样返回 value，方便链式使用
 */
function remember(key: string, value: ThumbResult): ThumbResult {
  if (cache.size >= THUMB_CACHE_MAX) cache.clear();
  cache.set(key, value);
  return value;
}

/**
 * 获取缩略图
 * @param filePath 文件完整路径
 * @param size 目标边长(px)，必须是 THUMB_ALLOWED_SIZES 之一
 * @returns {ok, data?|error?}
 */
export async function getThumbnail(filePath: string, size: number): Promise<ThumbResult> {
  const px = Number(size);
  if (!THUMB_ALLOWED_SIZES.includes(px)) {
    return { ok: false, error: 'unsupported-size' };
  }
  const key = `${px}:${filePath}`;
  if (cache.has(key)) return cache.get(key)!;

  if (!nativeImage) return { ok: false, error: 'no-native-image' };

  try {
    const img = await nativeImage.createThumbnailFromPath(filePath, {
      width: px,
      height: px,
    });
    if (!img || img.isEmpty()) return remember(key, { ok: false, error: 'empty' });
    // JPEG 体积远小于 PNG dataURL，且有损压缩对缩略图无影响
    const data = img.toJPEG(80);
    if (!data || data.length === 0) return remember(key, { ok: false, error: 'encode-failed' });
    return remember(key, { ok: true, data });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return remember(key, { ok: false, error: msg });
  }
}
