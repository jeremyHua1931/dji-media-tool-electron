// copier.ts —— 批量复制（跨平台）
// ============================================================
// 逐文件流式复制，支持：
//   - 平铺 / 按拍摄日期建子文件夹（如 2026-10-14/）
//   - 同名文件：跳过 / 覆盖 / 自动改名
//   - 进度回调、随时取消
//   - 复制后保留源文件的修改时间（≈拍摄时间）
//   - 只复制、绝不删除源文件
//
// 健壮性要点：
//   1. 「自动改名」必须原子化——用 'wx'（独占创建）打开，撞名（EEXIST）就换
//      下一个编号重试。否则多个同名源文件会互相覆盖：先以 'w' 截断目标，
//      再检查目标是否存在，早已被自己清空。
//   2. 撞名重试必须重建读流：stream.pipeline 出错时会销毁输入流，
//      复用一个已销毁的读流会写出 0 字节的空文件。
//   3. 取消/失败必须删掉写了一半的目标文件，否则留下残缺文件，下次用
//      「跳过」策略时会被误判为已复制成功。
//   4. 只统计真实传输的字节，不做二次累加。

import fs from 'fs';
import { promises as fsp } from 'fs';
import path from 'path';
import { pipeline } from 'stream';
import { COPY_CHUNK_SIZE } from './config';
import type { MediaFile } from './scanner';

const CANCELLED = '__CANCELLED__';
const MAX_RENAME_TRIES = 9999;

/**
 * 把 Date 转成本地时间格式的目录名（如 2026-10-14）。
 * 本地时间与界面展示的拍摄时间一致，避免时区错位导致"日期文件夹"和列表显示对不上。
 * @param date 要格式化的时间
 * @returns "YYYY-MM-DD"
 */
export function dateFolderName(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 生成"自动改名"的第 i 个候选路径：name.jpg -> name (1).jpg。
 * 只拼字符串、不做任何文件操作；撞名由调用方用独占创建去探测。
 * @param targetPath 期望的目标路径
 * @param i 第几个候选（从 1 开始）
 * @returns 候选路径
 */
export function renameCandidate(targetPath: string, i: number): string {
  const dir = path.dirname(targetPath);
  const ext = path.extname(targetPath);
  const base = path.basename(targetPath, ext);
  return path.join(dir, `${base} (${i})${ext}`);
}

// 流水线写入选项
interface PipelineWriteOptions {
  onBytes?: (n: number) => void;
  isCancelled?: () => boolean;
  onCreated?: (target: string) => void;
  exclusive?: boolean;
}

/**
 * 单个文件的原子写入流水线（核心实现）。
 * 写流用 fs.open 先拿句柄：'wx' 独占创建、撞名即 EEXIST（绝不截断已有文件）；
 * 'w' 用于覆盖策略。用 stream.pipeline 而不是手工 pipe —— 手工 pipe 在写流
 * 'open' 挂载存在时序竞态（首个数据块可能早于 'open' 到达而被丢弃，写出 0 字节文件）。
 * 进度由读流的 'data' 事件累计（只统计真实传输的字节，不做二次累加）；
 * 取消时 destroy 读流，触发 pipeline 的 PREMATURE_CLOSE，由外层统一判定。
 * @param src 源文件路径
 * @param dst 目标文件路径
 * @param opt { onBytes, isCancelled, onCreated, exclusive }
 * @returns 写入完成的目标路径
 */
function pipelineWrite(src: string, dst: string, opt: PipelineWriteOptions = {}): Promise<string> {
  const {
    onBytes = () => {},
    isCancelled = () => false,
    onCreated = () => {},
    exclusive = true,
  } = opt;

  return new Promise((resolve, reject) => {
    let finalTarget: string | null = null;
    fs.open(dst, exclusive ? 'wx' : 'w', (openErr, fd) => {
      if (openErr) return reject(openErr);

      let rs: fs.ReadStream | null = null;
      let ws: fs.WriteStream | null = null;
      try {
        rs = fs.createReadStream(src, { highWaterMark: COPY_CHUNK_SIZE });
        ws = fs.createWriteStream(dst, { fd });
      } catch (err) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
        if (rs) rs.destroy();
        return reject(err);
      }

      finalTarget = dst;
      onCreated(finalTarget);

      rs.on('data', (chunk: Buffer) => {
        if (isCancelled()) {
          rs!.destroy(); // 触发 pipeline 的 PREMATURE_CLOSE，由外层判定为取消
          return;
        }
        onBytes(chunk.length);
      });

      pipeline(rs, ws, (err) => (err ? reject(err) : resolve(finalTarget as string)));
    });
  });
}

// 单文件复制结果
interface CopyOneResult {
  target: string;
  renamed: boolean; // 是否因撞名换了新文件名
}

// 单文件复制选项
interface CopyOneOptions {
  onBytes?: (n: number) => void;
  isCancelled?: () => boolean;
  onCollision?: 'overwrite' | 'rename';
}

/**
 * 单个文件流式复制（带进度、取消、原子创建与失败清理）
 * @param src 源文件路径
 * @param dst 期望的目标路径
 * @param opt { onBytes, isCancelled, onCollision }
 * @returns {target, renamed}
 */
function copyOne(src: string, dst: string, opt: CopyOneOptions = {}): Promise<CopyOneResult> {
  const {
    onBytes = () => {},
    isCancelled = () => false,
    onCollision = 'overwrite', // 'overwrite' | 'rename'
  } = opt;
  // 只有「自动改名」才需要独占创建；覆盖策略本来就允许截断已有文件
  const exclusive = onCollision === 'rename';

  return new Promise((resolve, reject) => {
    let settled = false;
    let created = false;   // 目标文件是否已真的创建（决定失败时要不要清理）
    let finalTarget: string | null = null;
    let attempt = 0;

    // 只清理真正由本次复制创建、且是残缺的那些文件
    const cleanup = () => {
      if (!created || !finalTarget) return;
      try { fs.unlinkSync(finalTarget); } catch { /* 已不存在，忽略 */ }
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const attemptWrite = () => {
      attempt += 1;
      const candidate = attempt === 1 ? dst : renameCandidate(dst, attempt - 1);

      if (isCancelled()) return fail(new Error(CANCELLED));

      created = false;
      finalTarget = null;

      pipelineWrite(src, candidate, {
        onBytes,
        isCancelled,
        exclusive,
        onCreated: (target) => {
          created = true;
          finalTarget = target;
        },
      })
        .then((target) => {
          if (settled) return;
          settled = true;
          resolve({ target, renamed: finalTarget !== dst });
        })
        .catch((err) => {
          if (settled) return;
          if (err && err.code === 'EEXIST') {
            if (onCollision === 'rename' && attempt <= MAX_RENAME_TRIES) {
              return attemptWrite(); // 换下一个编号
            }
            return fail(new Error('目标文件已存在'));
          }
          // 取消导致的 PREMATURE_CLOSE：转成统一的取消信号
          if (isCancelled()) return fail(new Error(CANCELLED));
          return fail(err);
        });
    };

    attemptWrite();
  });
}

// 复制汇总结构
export interface CopySummary {
  copied: number;                 // 成功写入数
  skipped: number;                // 撞名跳过
  alreadyExists: number;          // 增量模式：目标已有同名同大小，直接判定已复制过
  renamed: number;                // 自动改名数
  verified: number;               // 校验通过数
  verifyFailed: { name: string; expected: number; actual: number }[];
  failed: { name: string; error: string }[];
  cancelled: boolean;
  bytesCopied: number;
}

// 批量复制选项
export interface CopyOptions {
  byDate?: boolean;
  onConflict?: 'skip' | 'overwrite' | 'rename';
  onlyNew?: boolean;   // 只复制目标里没有的（增量：按 同名+同大小 判断）
  verify?: boolean;    // 复制后按大小复核一遍，防写入中断/空间不足导致的损坏
  onBeforeVerify?: (target: string, f: MediaFile) => Promise<void> | void; // 仅供测试注入
  progress?: (info: { doneBytes: number; totalBytes: number; idx: number; total: number; name: string }) => void;
  isCancelled?: () => boolean;
}

/**
 * 批量复制
 * @param files MediaFile 列表
 * @param dest 目标根目录
 * @param opt { byDate, onConflict, onlyNew, verify, onBeforeVerify, progress, isCancelled }
 * @returns 汇总
 */
export async function copyFiles(files: MediaFile[], dest: string, opt: CopyOptions = {}): Promise<CopySummary> {
  const {
    byDate = false,
    onConflict = 'skip',
    onlyNew = false,   // 只复制目标里没有的（增量：按 同名+同大小 判断）
    verify = true,     // 复制后按大小复核一遍，防写入中断/空间不足导致的损坏
    onBeforeVerify = null,
    progress = () => {},
    isCancelled = () => false,
  } = opt;

  const summary: CopySummary = {
    copied: 0,
    skipped: 0,
    alreadyExists: 0,
    renamed: 0,
    verified: 0,
    verifyFailed: [],
    failed: [],
    cancelled: false,
    bytesCopied: 0,
  };
  const total = files.length;
  const totalBytes = files.reduce((s, f) => s + (f.size || 0), 0);
  let doneBytes = 0;
  let idx = 0;

  for (const f of files) {
    if (isCancelled()) {
      summary.cancelled = true;
      break;
    }
    idx += 1;
    const report = (name: string) => progress({
      doneBytes: Math.min(doneBytes, totalBytes),
      totalBytes,
      idx,
      total,
      name,
    });

    try {
      const targetDir = byDate
        ? path.join(dest, dateFolderName(new Date(f.mtime)))
        : dest;
      await fsp.mkdir(targetDir, { recursive: true });

      const target = path.join(targetDir, f.name);

      // 增量模式：同名 + 同大小 => 认为上次已经复制过，不动它
      // （不再往下走 rename 分支，避免第二次运行时复制出一堆 (1)(2) 副本）
      if (onlyNew) {
        const exist = await statOrNull(target);
        if (exist && exist.size === f.size) {
          summary.alreadyExists += 1;
          doneBytes += f.size || 0;
          report(f.name);
          continue;
        }
      }

      if (fs.existsSync(target) && onConflict === 'skip') {
        summary.skipped += 1;
        doneBytes += f.size || 0; // 跳过也算处理完，进度继续推进
        report(f.name);
        continue;
      }

      report(f.name);
      const res = await copyOne(f.path, target, {
        isCancelled,
        // 'skip' 已在上面提前返回，这里只剩 'overwrite'/'rename'
        onCollision: onConflict === 'skip' ? 'overwrite' : onConflict,
        onBytes: (n) => {
          doneBytes += n;
          report(f.name);
        },
      });

      // 保留源文件的修改时间（拍摄时间）
      const st = await fsp.stat(f.path);
      await fsp.utimes(res.target, st.atime, st.mtime);

      // 用户可能在最后一个文件写完后才点取消：不留半成品
      if (isCancelled()) {
        try { await fsp.unlink(res.target); } catch { /* ignore */ }
        summary.cancelled = true;
        break;
      }

      // 复核：大小必须与源文件一致，否则说明写入被中断/磁盘出问题
      if (verify) {
        if (typeof onBeforeVerify === 'function') await onBeforeVerify(res.target, f);
        const written = await statOrNull(res.target);
        if (!written || written.size !== st.size) {
          summary.verifyFailed.push({
            name: f.name,
            expected: st.size,
            actual: written ? written.size : -1,
          });
          // 校验不过的文件不能留下当"已复制成功"
          try { await fsp.unlink(res.target); } catch { /* ignore */ }
          summary.failed.push({ name: f.name, error: '复制后大小校验不一致，已删除该目标文件' });
          continue;
        }
        summary.verified += 1;
      }

      summary.copied += 1;
      summary.bytesCopied += st.size;
      if (res.renamed) summary.renamed += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === CANCELLED) {
        summary.cancelled = true;
        break;
      }
      summary.failed.push({ name: f.name, error: message });
    }
  }

  return summary;
}

/**
 * 读取文件 stat，失败返回 null（不抛错）。
 * 用于增量判断与复制后校验等"可能不存在"的查询场景。
 * @param p 路径
 * @returns 文件状态，或 null
 */
async function statOrNull(p: string): Promise<import('fs').Stats | null> {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}
