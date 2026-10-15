// drives.ts —— 跨平台的磁盘 / 相机 / 读卡器检测
// ============================================================
// Windows：通过 PowerShell CIM 获取所有盘符与类型（可移动=2）；
// macOS  ：挂载点在 /Volumes/*；
// Linux  ：挂载点在 /media/<用户>/* 与 /run/media/<用户>/*。
// 判定“相机”的通用依据：卷根目录下存在标准的 DCIM 文件夹。
//
// 性能：Windows 枚举用异步 execFile（首次 CIM 查询可能要 1~3 秒，
//       之前用 execFileSync 会把主进程事件循环卡住，窗口跟着假死）。

import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { DCIM_FOLDER } from './config';

// 统一的卷描述结构（跨平台收敛后的输出）
export interface Volume {
  root: string;        // 卷根路径（如 "F:\\" 或 "/Volumes/NO NAME"）
  name: string;        // 卷名（如 "NO NAME" / 盘符）
  removable: boolean;  // 是否可移动设备
  hasDCIM: boolean;    // 根目录下是否存在标准 DCIM 素材文件夹
  platform: NodeJS.Platform;
}

// Windows CIM 行结构（仅用于内部解析）
interface DiskRow {
  DeviceID: string;
  DriveType: number;
  VolumeName: string;
}

/**
 * 判断某个卷根目录下是否存在 DCIM 标准素材文件夹（异步）。
 * DCIM 是数码相机的通用素材目录约定，存在它即认为是"相机/存储卡"。
 * @param root 卷根路径（如 "F:\\" 或 "/Volumes/NO NAME"）
 * @returns 存在返回 true；无权限 / 不存在返回 false（不抛错）
 */
export function hasDCIM(root: string): Promise<boolean> {
  return fsp.access(path.join(root, DCIM_FOLDER)).then(() => true, () => false);
}

/**
 * 通过 PowerShell CIM 查询 Windows 逻辑磁盘列表（异步，非阻塞）。
 * 用 execFile 而不是 execFileSync：首次 CIM 查询可能要 1~3 秒，
 * 同步版本会卡死主进程事件循环，整个窗口跟着假死。
 * 查询失败时 resolve(null)，由调用方降级到 A-Z 盘符枚举。
 * @returns 磁盘行数组，或 null（查询失败）
 */
function queryWindowsDisks(): Promise<DiskRow[] | null> {
  // Win32_LogicalDisk.DriveType：2=可移动 3=本地磁盘 4=网络 5=光驱
  const ps =
    'Get-CimInstance Win32_LogicalDisk | ' +
    'Select-Object DeviceID,DriveType,VolumeName | ConvertTo-Json -Compress';

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 1 << 20 },
      (err, stdout) => {
        if (err) return resolve(null); // 交给调用方降级枚举
        try {
          const parsed = JSON.parse(String(stdout).trim()) as DiskRow | DiskRow[];
          const rows = Array.isArray(parsed) ? parsed : [parsed];
          return resolve(rows.filter((r) => r && r.DeviceID));
        } catch {
          return resolve(null);
        }
      }
    );
  });
}

/**
 * 降级方案：逐个探测 A-Z 盘符是否存在（CIM 查询失败时兜底）。
 * 只报告存在性，盘类型统一记作本地磁盘（DriveType=3），可移动性不可知。
 * @returns 按盘符字母排序的磁盘行数组
 */
async function fallbackWindowsDisks(): Promise<DiskRow[]> {
  const rows: DiskRow[] = [];
  const letters: string[] = [];
  for (let i = 65; i <= 90; i += 1) letters.push(String.fromCharCode(i));
  await Promise.all(letters.map(async (letter) => {
    const root = `${letter}:\\`;
    try {
      await fsp.access(root);
      rows.push({ DeviceID: `${letter}:`, DriveType: 3, VolumeName: '' });
    } catch { /* 不存在的盘符 */ }
  }));
  return rows.sort((a, b) => a.DeviceID.localeCompare(b.DeviceID));
}

/**
 * 组装 Windows 卷列表（统一输出结构）。
 * 优先用 CIM 查询；失败降级 A-Z 枚举。对每个盘异步探测其根目录下是否有 DCIM。
 * @returns 卷列表
 */
export async function listWindowsVolumes(): Promise<Volume[]> {
  let rows = await queryWindowsDisks();
  if (rows === null) rows = await fallbackWindowsDisks();

  return Promise.all(rows.map(async (r) => {
    const root = `${r.DeviceID}\\`;
    return {
      root,
      name: r.VolumeName || r.DeviceID,
      removable: r.DriveType === 2,
      hasDCIM: await hasDCIM(root),
      platform: 'win32' as NodeJS.Platform,
    };
  }));
}

/**
 * 扫描一组挂载点基目录下的所有一级子目录（macOS / Linux 的卷发现）。
 * 每个子目录视为一个"卷"，外接挂载点默认按可移动盘处理。
 * @param bases 基目录数组（如 ['/Volumes'] 或 Linux 的多个挂载点）
 * @returns 卷列表
 */
async function listMountDirs(bases: string[]): Promise<Volume[]> {
  const result: Volume[] = [];
  for (const base of bases) {
    let entries: import('fs').Dirent[] = [];
    try {
      entries = await fsp.readdir(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const root = path.join(base, ent.name);
      result.push({
        root,
        name: ent.name,
        removable: true, // 外接挂载点默认视为可移动
        hasDCIM: await hasDCIM(root),
        platform: process.platform,
      });
    }
  }
  return result;
}

/**
 * 枚举类 Unix 系统（macOS / Linux）的卷。
 * macOS：只扫 /Volumes；Linux：覆盖 /media/<用户>、/media、/run/media/<用户>、/run/media、/mnt
 * 等常见 U 盘 / SD 卡挂载点（各发行版约定不同，多列几个增加命中率）。
 * @returns 卷列表
 */
export function listUnixVolumes(): Promise<Volume[]> {
  if (process.platform === 'darwin') {
    return listMountDirs(['/Volumes']);
  }
  // Linux：覆盖常见 U 盘 / SD 卡挂载点
  const user = os.userInfo().username;
  return listMountDirs([
    `/media/${user}`,
    '/media',
    `/run/media/${user}`,
    '/run/media',
    '/mnt',
  ]);
}

/**
 * 读取测试注入的卷列表（自动化测试用）。
 * 冒烟测试通过环境变量 DJI_TEST_VOLUMES（卷数组 JSON）注入一个"假相机卷"，
 * 让「启动自动检测 → 定位素材目录 → 自动扫描」这条链路在任意机器上稳定复现。
 * 注意：注入只影响"检测 / 建议来源"，扫描与复制仍走真实文件系统，
 * 不会成为绕过只读保证的口子。
 * @returns 解析成功的卷数组，否则 null
 */
function testVolumes(): Volume[] | null {
  const raw = process.env.DJI_TEST_VOLUMES;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Volume[];
    return Array.isArray(parsed) && parsed.length ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 列出当前系统全部卷（跨平台统一入口）。
 * 流程：先尝试测试注入 → Windows 走 CIM（降级 A-Z）→ 类 Unix 扫挂载点。
 * @returns 统一结构的卷列表
 */
export function listVolumes(): Promise<Volume[]> {
  const injected = testVolumes();
  if (injected) return Promise.resolve(injected);
  if (process.platform === 'win32') return listWindowsVolumes();
  return listUnixVolumes();
}

/**
 * 自动检测相机 / 读卡器。
 * 优先返回含 DCIM 文件夹的卷（标准相机/存储卡特征）；
 * Windows 下若一个都没有，则把所有可移动盘一并给出（供界面手动挑选）。
 * @returns 候选卷列表（可能为空）
 */
export async function detectCameras(): Promise<Volume[]> {
  const volumes = await listVolumes();
  const withDCIM = volumes.filter((v) => v.hasDCIM);
  if (withDCIM.length > 0) return withDCIM;
  if (process.platform === 'win32') {
    return volumes.filter((v) => v.removable);
  }
  return [];
}

// 在 DCIM 里找"素材最多的那个子文件夹"（DJI 一般是 DCIM/DJI_001、DCIM/100MEDIA…）
// 只用于给出一个更友好的默认来源，不做任何写操作。
const MEDIA_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.dng', '.heic', '.heif', '.webp', '.gif', '.tif', '.tiff',
  '.bmp', '.cr2', '.cr3', '.nef', '.arw', '.raf', '.rw2', '.orf',
  '.mp4', '.mov', '.mkv', '.avi', '.flv', '.webm', '.m4v', '.3gp', '.3g2',
  '.mts', '.m2ts', '.mpg', '.mpeg', '.wmv',
]);

/**
 * 判断文件名是否为媒体文件（按扩展名，大小写不敏感）。
 * @param name 文件名
 * @returns true 表示扩展名命中照片/视频白名单
 */
function isMediaName(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return MEDIA_EXTS.has(name.slice(dot).toLowerCase());
}

/**
 * 递归统计目录树内的媒体文件数量（用于"哪个 DCIM 子目录素材最多"的探测）。
 * 用显式栈 + withFileTypes 迭代，避免递归爆栈；只数到 limit 即提前返回。
 * 只做只读探测，不做任何写入。
 * @param dir 起始目录
 * @param limit 计数上限（达到即返回，保护大存储卡上的性能）
 * @returns 媒体文件数量
 */
async function countMediaIn(dir: string, limit: number): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: import('fs').Dirent[];
    try {
      entries = await fsp.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile() && isMediaName(ent.name)) {
        total += 1;
        // 只需要判断"哪个子目录有素材"，数够就够了；大卡上这样能省很多 stat
        if (limit && total >= limit) return total;
      }
    }
  }
  return total;
}

// 只用于探测的计数上限（不改变实际扫描结果，实际扫描仍按时间/类型过滤）
const PROBE_LIMIT = 200;

// 建议素材来源的返回结构
export interface SuggestedRoot {
  root: string;                  // 建议的素材根（优先为素材最多的 DCIM 子文件夹）
  volume: string;                // 所属卷根
  name: string;                  // 卷名
  dcim: string;                  // DCIM 目录路径
  fileCount: number;             // 探测到的素材数
  candidates: { dir: string; count: number }[]; // DCIM 各子目录素材统计
}

/**
 * 给出建议的素材来源路径
 * @returns root 优先取「素材最多的 DCIM 子文件夹」（如 F:\DCIM\DJI_001），
 *   子文件夹都没素材时退回 DCIM 本身；没有相机卷时返回 null。
 */
export async function suggestMediaRoot(): Promise<SuggestedRoot | null> {
  const cameras = await detectCameras();
  if (!cameras.length) return null;

  for (const vol of cameras) {
    const dcim = path.join(vol.root, DCIM_FOLDER);
    let subs: string[] = [];
    try {
      const entries = await fsp.readdir(dcim, { withFileTypes: true });
      subs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
    } catch { /* 没有 DCIM 就跳过这个卷 */ }

    if (!subs.length) {
      if (await hasDCIM(vol.root)) {
        const count = await countMediaIn(dcim, PROBE_LIMIT);
        return {
          root: dcim, volume: vol.root, name: vol.name, dcim,
          fileCount: count, candidates: [],
        };
      }
      continue;
    }

    // 先浅扫一层拿"每个子目录有多少素材"，用于挑出主素材目录
    const scored = await Promise.all(subs.map(async (s) => ({
      dir: path.join(dcim, s),
      count: await countMediaIn(path.join(dcim, s), PROBE_LIMIT),
    })));
    scored.sort((a, b) => b.count - a.count);

    const best = scored[0];
    if (best && best.count > 0) {
      return {
        root: best.dir,
        volume: vol.root,
        name: vol.name,
        dcim,
        fileCount: best.count,
        candidates: scored.map((s) => ({ dir: s.dir, count: s.count })),
      };
    }
    // 子文件夹里没有可识别素材，退回 DCIM 目录
    return {
      root: dcim, volume: vol.root, name: vol.name, dcim,
      fileCount: 0, candidates: scored.map((s) => ({ dir: s.dir, count: s.count })),
    };
  }
  return null;
}
