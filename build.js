#!/usr/bin/env node
// 一键编译导出.js —— 根目录编译脚本
// ============================================================
// 功能：
//   1. 自动检测当前运行平台（Windows / macOS / Linux），
//      并选择对应的编译命令（npm run build:win / build:mac / build:linux）；
//   2. 编译完成后，在 release/<时间戳>_<平台>/ 中找到刚生成的安装包
//      （Windows 下即 .exe），把它们移动到项目根目录；
//   3. 移动后的文件名追加一个可读的时间戳，例如：
//        DJI素材筛选复制工具 1.0.0.exe
//          -> DJI素材筛选复制工具 1.0.0_2026-10-15_153012.exe
//
// 用法（在项目根目录执行）：
//   node 一键编译导出.js
// 也可以在 package.json 里加一条快捷脚本（本脚本已内置说明）。
//
// 说明：
//   - 编译过程原样透传给 npm（stdio: inherit），能看到完整打包日志；
//   - 编译失败时不移动任何文件，保留 release 目录现场便于排查；
//   - 同一次编译可能产出多个安装包（如 Setup 安装向导 + 免安装绿色版），
//     会全部移动，每个都带时间戳；
//   - macOS / Linux 平台不产出 .exe，本脚本会移动对应平台的安装包
//     （.dmg / .AppImage / .deb / .rpm 等），同样带时间戳。

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// 脚本约定放在项目根目录：所有相对路径都以这里为基准
const ROOT = __dirname;

// 通用小工具 ------------------------------------------------------------
function log(msg) { console.log(`[一键编译] ${msg}`); }
function fail(msg) {
  console.error(`[一键编译] 错误：${msg}`);
  process.exit(1);
}

/**
 * 生成可读时间戳（本地时间）：YYYY-MM-DD_HHMMSS。
 * 例：2026-10-15_153012 —— 一眼能看出"哪天几点几分"打的包。
 * @returns {string} 时间戳字符串
 */
function readableTimestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    + `_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 跨设备安全"移动"文件：先尝试 rename（同盘瞬间完成，保留原始 inode）；
 * 失败（跨设备 / 文件被占用等）则退化为 复制 + 删除。
 * @param {string} src 源文件
 * @param {string} dst 目标文件
 * @returns {boolean} 是否成功
 */
function moveFile(src, dst) {
  try {
    fs.renameSync(src, dst);
    return true;
  } catch {
    try {
      fs.copyFileSync(src, dst);
      fs.unlinkSync(src);
      return true;
    } catch {
      return false;
    }
  }
}

// 1. 平台检测与编译命令选择 ----------------------------------------------
// Node 的 process.platform 值与项目 build 脚本的平台 key 的映射关系
const PLATFORM_MAP = {
  win32: 'win',    // Windows
  darwin: 'mac',   // macOS
  linux: 'linux',  // Linux
};

// 每个平台对应的 npm 编译命令（见 package.json 的 scripts）
const BUILD_SCRIPT = {
  win: 'build:win',    // Windows：NSIS 安装程序 + 免安装 portable
  mac: 'build:mac',    // macOS：.dmg（需在 macOS 上构建）
  linux: 'build:linux',// Linux：AppImage（需在 Linux 上构建）
};

// 各平台要移动到根目录的安装包扩展名（Windows 就是 .exe）
const ARTIFACT_EXTS = {
  win: ['.exe'],
  mac: ['.dmg', '.pkg', '.appimage', '.zip'],
  linux: ['.appimage', '.deb', '.rpm', '.snap', '.zip'],
};

const platformKey = PLATFORM_MAP[process.platform];
if (!platformKey) {
  fail(`暂不支持当前平台：${process.platform}（支持 win32 / darwin / linux）`);
}
const buildScript = BUILD_SCRIPT[platformKey];
log(`检测到平台：${process.platform}  →  使用编译命令 npm run ${buildScript}`);

// 2. 执行编译 --------------------------------------------------------------
// 编译日志原样透传（stdio: 'inherit'），失败立即中止且不移动任何文件
log('开始编译，请稍候（首次打包需要下载 electron 二进制，可能较慢）…');
const buildRes = spawnSync('npm', ['run', buildScript], {
  cwd: ROOT,
  stdio: 'inherit',
  shell: true, // Windows 上 npm 是 .cmd，必须 shell: true 才能被 spawn 找到
});
if (buildRes.status !== 0) {
  fail(`编译失败（退出码 ${buildRes.status ?? 'unknown'}），已保留 release 目录现场，未移动任何文件。`);
}
log('编译完成。');

// 3. 定位刚生成的产物目录 ----------------------------------------------------
// build 脚本会输出到 release/<时间戳>_<平台>/，历史批次不覆盖；
// 取"修改时间最新的、匹配当前平台后缀"的那个目录，即刚生成的一批。
const releaseRoot = path.join(ROOT, 'release');
if (!fs.existsSync(releaseRoot)) {
  fail('未找到 release 目录（编译可能未产出任何文件），请检查上方编译日志。');
}

const batchDirs = fs.readdirSync(releaseRoot)
  // 只取 "以 _<平台> 结尾" 的批次目录（如 2026-10-15_0736_win）；
  // 以 _win_dir 结尾的是 --dir 模式（只有解包目录），不在移动范围内
  .filter((name) => name.endsWith(`_${platformKey}`) && !name.endsWith(`_${platformKey}_dir`))
  .map((name) => ({ name, full: path.join(releaseRoot, name), mtime: fs.statSync(path.join(releaseRoot, name)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime);

if (batchDirs.length === 0) {
  fail(`release 目录下没有找到 <时间戳>_${platformKey} 的产物批次，请检查编译日志。`);
}
const batch = batchDirs[0];
log(`使用产物批次：release/${batch.name}`);

// 4. 找出该批次里的安装包并移动到根目录 --------------------------------------
const exts = ARTIFACT_EXTS[platformKey] || ['.exe'];
const stamp = readableTimestamp();
const moved = [];
const failed = [];

// 是否跳过 NSIS 安装向导（文件名含 "Setup"，如 "DJI素材筛选复制工具 Setup 1.0.0.exe"）。
// 用户只需要"免安装绿色版"搬到根目录，Setup 安装程序保留在 release 批次目录里留档；
// 需要连 Setup 一起搬时，把下面改成 false 即可。
const SKIP_SETUP = true;

const entries = fs.readdirSync(batch.full);
for (const name of entries) {
  const full = path.join(batch.full, name);
  // 只处理文件，跳过 win-unpacked 之类的中间目录
  if (!fs.statSync(full).isFile()) continue;
  if (!exts.includes(path.extname(name).toLowerCase())) continue;
  // 按用户要求跳过 Setup 安装向导，只移动免安装绿色版
  if (SKIP_SETUP && /setup/i.test(name)) {
    log(`! 跳过安装向导（保留在 release 批次中）：${name}`);
    continue;
  }

  // 目标文件名：原名去掉扩展名 + "_" + 时间戳 + 原扩展名
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  const destName = `${base}_${stamp}${ext}`;
  const dest = path.join(ROOT, destName);

  if (moveFile(full, dest)) {
    moved.push(destName);
    log(`已移动 → ${destName}`);
  } else {
    failed.push(name);
    log(`! 移动失败（可能被占用）：${name}`);
  }
}

// 5. 汇总汇报 ----------------------------------------------------------------
if (moved.length === 0) {
  fail(`在 ${batch.name} 中没有找到可移动的安装包（扩展名：${exts.join(' / ')}），未移动任何文件。`);
}
log(`完成：共移动 ${moved.length} 个安装包到项目根目录${failed.length ? `，${failed.length} 个失败` : ''}。`);
if (failed.length) {
  log('失败的文件仍保留在 release 目录中，可稍后手动复制。');
}
