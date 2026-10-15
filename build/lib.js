// lib.js —— 打包脚本共用的工具函数与目标平台解析
// 被 build.js / pack.js / cleanup.js / make.js / test-all.js 共享，
// 集中处理：路径根、必要文件预检、平台参数解析、时间戳目录名、npm 脚本调度等。
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { Platform } = require('electron-builder');

// 项目根目录（本文件位于 build/ 下，取上一级）
const ROOT = path.resolve(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));

// 打包前必须存在的关键文件：缺任何一个都会做出"能启动但白屏"的包
const REQUIRED_FILES = [
  'src/main/main.js',
  'src/main/ipc.js',
  'src/main/config.js',
  'src/main/drives.js',
  'src/main/scanner.js',
  'src/main/copier.js',
  'src/main/thumbnails.js',
  'src/preload/preload.js',
  'src/renderer/index.html',
  'src/renderer/styles.css',
  'src/renderer/renderer.js',
  'package.json',
];

// 各平台的人类可读标签（用于汇报输出）
const PLATFORM_LABELS = {
  win: 'Windows（NSIS 安装程序 + 免安装 portable）',
  mac: 'macOS（.dmg，需在 macOS 上构建）',
  linux: 'Linux（AppImage，需在 Linux 上构建）',
};

// 每个编译批次独占一个可读时间戳目录，例如 release/2026-10-14_1632_win/
// 历史产物不被覆盖，便于回退对比
function timestampName(platform, dirOnly) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    + `_${p(d.getHours())}${p(d.getMinutes())}`;
  return `${stamp}_${platform}${dirOnly ? '_dir' : ''}`;
}

// 普通日志（stdout）
function log(msg) { process.stdout.write(`${msg}\n`); }

// 致命错误：写入 stderr 并退出（退出码 1）
function fail(msg) {
  process.stderr.write(`[build] ${msg}\n`);
  process.exit(1);
}

// 打包前校验：缺文件 / main 指向不存在 / 未装依赖都会直接中止
function preflight() {
  const missing = REQUIRED_FILES.filter((f) => !fs.existsSync(path.join(ROOT, f)));
  if (missing.length) fail(`缺少必要文件：\n  - ${missing.join('\n  - ')}`);
  const mainRel = pkg.main || 'index.js';
  if (!fs.existsSync(path.join(ROOT, mainRel))) {
    fail(`package.json 的 main 指向不存在的文件：${mainRel}`);
  }
  if (!fs.existsSync(path.join(ROOT, 'node_modules', 'electron'))) {
    fail('还没安装依赖，请先执行 npm install');
  }
  return mainRel;
}

/**
 * 解析命令行里的目标平台参数（--win / --mac / --linux / --dir / --keep-all）。
 * 不给平台 flag 时用当前系统；给出与当前系统不同的平台会打 crossHint 提示
 * （Electron 应用不能跨平台交叉编译）。
 * @param {string[]} args 命令行参数数组
 * @returns {{key:string, host:string, label:string, dirOnly:boolean,
 *            keepAll:boolean, crossHint:boolean}}
 */
function parseTargets(args) {
  const map = { '--win': 'win', '--mac': 'mac', '--linux': 'linux' };
  const hostMap = { win32: 'win', darwin: 'mac', linux: 'linux' };
  const host = hostMap[process.platform] || process.platform;
  const flag = args.find((a) => map[a]);
  const key = flag ? map[flag] : host;
  return {
    key,
    host,
    label: flag ? PLATFORM_LABELS[key] : `当前系统（${host}）`,
    dirOnly: args.includes('--dir'),
    keepAll: args.includes('--keep-all'),
    crossHint: !!flag && key !== host,
  };
}

/**
 * 把平台 key 换成 electron-builder 的 Platform 目标（仅供 pack.js 使用）。
 * 注意：--dir 需要用 platform.createTarget('dir') 生成目标对象，
 * 直接传字符串会报 "this.options.targets is not iterable"。
 * @param {string} key     平台 key（'win' | 'mac' | 'linux'）
 * @param {boolean} dirOnly 是否只要解包目录
 * @returns {*} electron-builder 的 targets 参数
 */
function buildTargets(key, dirOnly) {
  const PLATFORMS = { win: Platform.WINDOWS, mac: Platform.MAC, linux: Platform.LINUX };
  const platform = PLATFORMS[key] || Platform.current();
  return platform.createTarget(dirOnly ? 'dir' : undefined);
}

// 跑一个 npm 脚本（Windows 上 npm 是 .cmd，必须 shell: true 才能被 spawn 找到）
// 失败即中止整个流程
function runScript(script) {
  log(`\n[build] 先执行 npm run ${script} …`);
  const res = spawnSync('npm', ['run', script], {
    cwd: ROOT, stdio: 'inherit', shell: true,
  });
  if (res.status !== 0) fail(`npm run ${script} 失败（退出码 ${res.status}），已中止打包。`);
}

/**
 * 把字节数格式化成人类可读的体积（用于清理汇报）。
 * @param {number} bytes 字节数
 * @returns {string} 如 "12.3 MB" / "456 KB" / "0 MB"
 */
function formatMB(bytes) {
  if (!bytes) return '0 MB';
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}

module.exports = {
  ROOT, pkg, log, fail, preflight, parseTargets, buildTargets, runScript,
  timestampName, formatMB, PLATFORM_LABELS,
};
