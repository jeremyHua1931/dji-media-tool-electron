// scanner.ts —— 素材扫描与筛选（跨平台）
// ============================================================
// 递归遍历指定目录，按 “扩展名（照片/视频）+ 日期范围（文件修改时间）”
// 筛选出素材。默认只扫描 DCIM 文件夹，跳过隐藏 / 系统文件。
//
// 说明：相机写入文件的修改时间(mtime)≈拍摄时刻，作为拍摄时间依据。

import { promises as fsp } from 'fs';
import path from 'path';
import {
  PHOTO_EXTS, VIDEO_EXTS, KIND_PHOTO, KIND_VIDEO, DCIM_FOLDER,
} from './config';

// 素材类型字面量
type MediaKind = typeof KIND_PHOTO | typeof KIND_VIDEO;

// 扫描命中的单个素材文件
export interface MediaFile {
  dir: string;      // 所在文件夹（渲染层按目录归组用，避免各自切路径字符串）
  name: string;     // 文件名
  path: string;     // 完整路径
  size: number;     // 字节数
  mtime: string;    // 修改时间（ISO 字符串，便于跨进程传递）
  kind: MediaKind;  // 'photo' | 'video'
}

/**
 * 按扩展名把文件名归类为照片 / 视频。
 * 使用统一小写的扩展名与 config 中的白名单比对；非媒体返回 null。
 * @param fileName 文件名（大小写不敏感）
 * @returns 'photo' | 'video' | null
 */
export function kindOf(fileName: string): MediaKind | null {
  const ext = path.extname(fileName).toLowerCase();
  if (PHOTO_EXTS.includes(ext)) return KIND_PHOTO;
  if (VIDEO_EXTS.includes(ext)) return KIND_VIDEO;
  return null;
}

/**
 * 判断目录名是否为应跳过的隐藏 / 系统目录。
 * 以 "." 开头的（.Trash、.Spotlight-V100 等）以及 Windows 的
 * "System Volume Information"、回收站 "$RECYCLE.BIN" 一律跳过，
 * 避免扫进相机的系统文件。
 * @param name 目录/文件名
 * @returns true 表示应忽略
 */
export function isIgnoredName(name: string): boolean {
  if (name.startsWith('.')) return true;
  const upper = name.toUpperCase();
  return upper === 'SYSTEM VOLUME INFORMATION' || upper === '$RECYCLE.BIN';
}

/**
 * 计算实际扫描起点目录。
 * 当 dcimOnly 开启且根目录下存在 DCIM 文件夹时，只扫描 DCIM（跳过相机系统文件）；
 * 否则退化为扫描整个根目录（例如用户手动选到 DCIM 内部或普通文件夹）。
 * @param root 用户选择的来源根路径
 * @param dcimOnly 是否只扫 DCIM
 * @returns 待扫描的起始目录数组
 */
export async function resolveStartDirs(root: string, dcimOnly: boolean): Promise<string[]> {
  if (dcimOnly) {
    const dcim = path.join(root, DCIM_FOLDER);
    try {
      const st = await fsp.stat(dcim);
      if (st.isDirectory()) return [dcim];
    } catch {
      // 根下没有 DCIM，退化为扫描整个目录
    }
  }
  return [root];
}

/**
 * 判断文件修改时间 mtime 是否落在 [start, end] 闭区间内。
 * start / end 任一为空表示对应边界不限。
 * 相机直接写卡时 mtime ≈ 拍摄时刻，本工具以 mtime 作为"拍摄时间"依据。
 * @param mtime 文件修改时间
 * @param start 起始时间（含），null 表示不限
 * @param end 结束时间（含），null 表示不限
 * @returns 是否在范围内
 */
export function inDateRange(mtime: Date, start: Date | null, end: Date | null): boolean {
  if (start && mtime < start) return false;
  if (end && mtime > end) return false;
  return true;
}

// 扫描选项
export interface ScanOptions {
  start?: Date | null;
  end?: Date | null;
  wantPhoto?: boolean;
  wantVideo?: boolean;
  dcimOnly?: boolean;
}

/**
 * 扫描素材
 * @param root 起始目录
 * @param opt { start, end, wantPhoto, wantVideo, dcimOnly }
 * @returns MediaFile 列表（按拍摄时间升序）
 */
export async function scanMedia(root: string, opt: ScanOptions = {}): Promise<MediaFile[]> {
  const {
    start = null,
    end = null,
    wantPhoto = true,
    wantVideo = true,
    dcimOnly = true,
  } = opt;

  const startDirs = await resolveStartDirs(root, dcimOnly);
  const results: MediaFile[] = [];
  const stack = [...startDirs];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: import('fs').Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // 无权限或已卸载，跳过
    }

    for (const ent of entries) {
      if (isIgnoredName(ent.name)) continue;
      const full = path.join(dir, ent.name);

      if (ent.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!ent.isFile()) continue;

      const kind = kindOf(ent.name);
      if (!kind) continue;
      if (kind === KIND_PHOTO && !wantPhoto) continue;
      if (kind === KIND_VIDEO && !wantVideo) continue;

      let st: import('fs').Stats;
      try {
        st = await fsp.stat(full);
      } catch {
        continue;
      }
      if (!inDateRange(st.mtime, start, end)) continue;

      results.push({
        // dir 单独给出：渲染层要按目录归组（素材文件夹栏 / 增量判断都要用），
        // 让它直接取字段，别再各自去切 path 字符串
        dir,
        name: ent.name,
        path: full,
        size: st.size,
        mtime: st.mtime.toISOString(), // ISO 字符串，便于跨进程传递
        kind,
      });
    }
  }

  // 默认按拍摄时间升序
  results.sort((a, b) =>
    new Date(a.mtime).getTime() - new Date(b.mtime).getTime() ||
    a.name.localeCompare(b.name));
  return results;
}
