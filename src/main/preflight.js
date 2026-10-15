// preflight.js —— 复制前的安全检查（防呆 + 空间 + 相机只读保证）
// ============================================================
// 本工具的第一原则是「只读相机、绝不动相机内部存储」，所以真正开始写盘之前
// 必须先过三道关，任何一道不过就根本不进入复制流程：
//
//   1. 目标盘 ≠ 源盘：目标落在源盘（相机/存储卡）上会直接往相机里写数据；
//   2. 目标不在源目录内部：否则复制出来的文件又会被下一次扫描当成素材，
//      越复制越多（自复制递归）；
//   3. 目标盘剩余空间 ≥ 待复制体积 + 安全余量：写到一半空间不足会留下
//      一堆半成品，还白等半天。
//
// 这里只做判断，不做任何写操作；错误用「可读文案 + code」返回，
// 界面直接展示文案，测试可以断言 code。

'use strict';

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

// 空间安全余量：目标盘的 1% 或 64MB，取较大者
const SPACE_HEADROOM_MIN = 64 * 1024 * 1024;
const SPACE_HEADROOM_RATIO = 0.01;

/**
 * 路径规范化：转绝对路径并去掉末尾分隔符，用于统一比较口径。
 * 例如 "F:\\DCIM\\" 与 "F:\\DCIM" 视为同一路径。
 * @param {*} p 原始路径（非字符串按空串处理）
 * @returns {string} 规范化后的绝对路径
 */
function normalize(p) {
  return path.resolve(String(p || '')).replace(/[\\/]+$/, '');
}

/**
 * 当前是否 Windows 平台（路径比较等逻辑按平台区分）。
 * @returns {boolean} win32 为 true
 */
function isWindows() {
  return process.platform === 'win32';
}

/**
 * 路径相等判断（Windows 忽略大小写；类 Unix 严格区分）。
 * 规范化后再比较，排除盘符写法、末尾斜杠等差异。
 * @param {string} a 路径 A
 * @param {string} b 路径 B
 * @returns {boolean} 是否指向同一路径
 */
function samePath(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  return isWindows() ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/**
 * 判断 child 是否位于 parent 目录内部（含相等）。
 * 用于「目标不能落在源目录内」的自复制递归防护。
 * @param {string} child  待判断的子路径
 * @param {string} parent 父目录
 * @returns {boolean} child 在 parent 内部（或相等）为 true
 */
function isInside(child, parent) {
  const rel = path.relative(normalize(parent), normalize(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 取某个路径所在盘 / 卷的根。
 * Windows：用 path.parse 取盘符根（如 "F:\\"）；
 * 类 Unix：从目标逐级向上找第一个满足「已存在目录且位于挂载点根模式」的祖先，
 * 视作挂载点近似值（无法精确拿到挂载表时的合理简化）。
 * @param {string} target 目标路径
 * @returns {Promise<string|null>} 卷根路径；Windows 解析失败返回 null
 */
async function volumeRoot(target) {
  if (isWindows()) {
    const root = path.parse(path.resolve(target)).root; // "F:\"
    return root || null;
  }
  // 类 Unix：找最长的已存在祖先目录，视作挂载点近似值
  let cur = path.resolve(target);
  const stack = [];
  while (cur && cur !== path.dirname(cur)) {
    try {
      const st = await fsp.stat(cur);
      if (st.isDirectory() && (cur === '/' || /^\/(Volumes|media|mnt|run)\//.test(cur))) {
        return cur;
      }
      stack.push(cur);
    } catch { /* 不存在，继续往上 */ }
    cur = path.dirname(cur);
  }
  return '/';
}

/**
 * 查询目标路径所在卷的剩余空间（字节）。
 * 目标目录可能尚未创建，会逐级向上找到第一个已存在的目录再 statfs。
 * Node < 18.15 没有 fsp.statfs，或查询失败时返回 null（界面只提示"空间未知"，不阻断复制）。
 * @param {string} target 目标路径
 * @returns {Promise<{dir:string, free:number, total:number}|null>}
 */
async function freeSpace(target) {
  let dir = normalize(target);
  // 目标可能还没建，逐级往上找已存在的目录
  while (dir && !fs.existsSync(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (typeof fsp.statfs !== 'function') return null; // Node < 18.15
  try {
    const st = await fsp.statfs(dir);
    return {
      dir,
      free: Number(st.bavail) * Number(st.bsize),
      total: Number(st.blocks) * Number(st.bsize),
    };
  } catch {
    return null;
  }
}

/**
 * 复制前检查
 * @param {object} p { dest, sourceRoot, totalBytes, fileCount }
 * @returns {Promise<{ok:boolean, code?:string, message?:string,
 *                    free?:number, need?:number, volume?:string}>}
 */
async function checkCopyPreflight(p) {
  const { dest, sourceRoot, totalBytes = 0, fileCount = 0 } = p || {};

  if (!dest || !normalize(dest)) {
    return { ok: false, code: 'NO_DEST', message: '请先选择保存目标文件夹。' };
  }
  if (!sourceRoot || !normalize(sourceRoot)) {
    return { ok: false, code: 'NO_SOURCE', message: '请先选择素材来源。' };
  }

  // 1) 目标目录在源目录内部 —— 自复制递归
  if (isInside(dest, sourceRoot)) {
    return {
      ok: false,
      code: 'DEST_INSIDE_SOURCE',
      message: '目标文件夹在素材来源内部（相机/存储卡里），会往相机里写数据。\n'
        + '请选择电脑本地磁盘上的目标文件夹。',
    };
  }

  // 2) 目标盘 = 源盘 —— 直接往相机内部存储写
  const [destVol, srcVol] = await Promise.all([volumeRoot(dest), volumeRoot(sourceRoot)]);
  if (destVol && srcVol && samePath(destVol, srcVol)) {
    return {
      ok: false,
      code: 'DEST_SAME_VOLUME',
      message: `目标盘和素材来源在同一个盘（${srcVol}）。\n`
        + '为避免改动相机 / 存储卡的内部存储，请选择另一个磁盘上的文件夹。',
      volume: srcVol,
    };
  }

  // 3) 剩余空间
  const need = Math.max(0, Math.ceil(totalBytes))
    + Math.max(SPACE_HEADROOM_MIN, Math.ceil(totalBytes * SPACE_HEADROOM_RATIO));
  const space = await freeSpace(dest);
  if (space && space.free < need) {
    const mb = (n) => `${(n / 1024 / 1024).toFixed(0)} MB`;
    return {
      ok: false,
      code: 'NOT_ENOUGH_SPACE',
      message: `${space.dir} 剩余空间不足：需要约 ${mb(need)}（含 ${mb(need - totalBytes)} 安全余量），`
        + `当前可用 ${mb(space.free)}。\n请换一个目标文件夹或先清理磁盘。`,
      free: space.free,
      need,
    };
  }

  return {
    ok: true,
    free: space ? space.free : null,
    need,
    volume: destVol,
    fileCount,
    totalBytes,
  };
}

module.exports = {
  checkCopyPreflight, freeSpace, volumeRoot,
  samePath, isInside, normalize,
  SPACE_HEADROOM_MIN, SPACE_HEADROOM_RATIO,
};
