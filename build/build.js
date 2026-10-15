#!/usr/bin/env node
// build.js —— 一条命令完成「校验 → 打包 → 清理」
// ============================================================
//   npm run build             # 当前系统安装包
//   npm run build -- --win    # Windows：NSIS 安装包 + 免安装 portable
//   npm run build -- --mac    # macOS：.dmg（需在 macOS 上执行）
//   npm run build -- --linux  # Linux：AppImage（需在 Linux 上执行）
//   npm run build -- --dir    # 只出解包目录（最快，自测用）
//   npm run build -- --keep-all   # 保留中间文件（解包目录、builder 调试信息等）
//   npm run release           # 先跑全部测试，再打包（发版用）
//
// 目录约定：每次编译输出到 release/<时间戳>_<平台>/，例如
//   release/2026-10-14_2304_win/
//     ├─ DJI素材筛选复制工具 Setup 1.0.0.exe   ← 安装向导
//     └─ DJI素材筛选复制工具 1.0.0.exe         ← 免安装，双击即用
// 成功后自动删除同批次里的中间产物（解包目录、builder-*.yml、blockmap 等），
// 让每个时间戳目录都是"可交付的干净成品"。
//
// 分层（每一层都是为了避免把整条命令拖死）：
//   build.js   父进程：预检、时间戳目录、调度、汇报。只做纯字符串处理，
//              不对产物做同步 fs 调用（见 build/cleanup.js 顶部说明）。
//   pack.js    子进程：调 electron-builder 打包，回传产物块。
//   cleanup.js 子进程：删中间产物、统计体积，回传结果。

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  ROOT, pkg, log, fail, preflight, parseTargets, timestampName, formatMB,
} = require('./lib');

preflight();

const args = process.argv.slice(2);
const { key, label, dirOnly, keepAll, crossHint } = parseTargets(args);

// 每个批次独占一个时间戳目录，历史产物不被覆盖，便于回退对比
const batchName = timestampName(key, dirOnly);
const outDir = path.join(ROOT, pkg.build.directories.output || 'release', batchName);

log(`[build] 项目：${pkg.name} v${pkg.version}`);
log(`[build] 应用名：${pkg.build.productName}`);
log(`[build] 目标平台：${label}${dirOnly ? '（仅解包目录）' : ''}`);
log(`[build] 本次输出：${path.relative(ROOT, outDir)}\\`);
if (crossHint) {
  log('[build] 注意：Electron 应用不能跨平台交叉编译，在非目标系统上构建大概率失败。');
}

const env = { ...process.env, DJI_OUT_DIR: outDir };
delete env.ELECTRON_RUN_AS_NODE;

// ---------- 1. 子进程打包 ----------
const started = Date.now();
const pack = spawnSync(
  process.execPath,
  [path.join(__dirname, 'pack.js'), ...args],
  { cwd: ROOT, env, encoding: 'utf8' }
);

if (pack.stderr) process.stderr.write(pack.stderr); // electron-builder 的进度在 stderr
if (pack.error) fail(`无法启动打包子进程：${pack.error.message}`);

const packOut = pack.stdout || '';
if (pack.status !== 0 || !/PACK_DONE /.test(packOut)) {
  log(`\n[build] 失败现场保留在：${path.relative(ROOT, outDir)}\\`);
  fail(`打包失败（退出码 ${pack.status}）。详见上方输出。`);
}

let artifacts = [];
try {
  artifacts = JSON.parse(packOut.split('PACK_DONE ').pop().split('\n')[0]);
} catch {
  artifacts = [];
}

const secs = ((Date.now() - started) / 1000).toFixed(1);

// ---------- 2. 分辨交付物与中间产物 ----------
// 只按「扩展名 + 是否目录」判断，不调用 fs（避免触碰含中文的产物路径）
const DELIVERABLE_EXT = new Set([
  '.exe', '.msi', '.dmg', '.pkg', '.appimage', '.deb', '.rpm', '.snap', '.zip', '.7z',
]);
const deliverable = [];
const removable = [];
for (const item of artifacts) {
  const abs = path.resolve(item);
  if (DELIVERABLE_EXT.has(path.extname(abs).toLowerCase())) deliverable.push(abs);
  else removable.push(abs);
}

log(`\n[build] 打包完成，用时 ${secs}s`);
if (deliverable.length) {
  log('[build] 交付物：');
  // 只打印文件名，不 stat（父进程不碰产物文件系统）
  for (const f of deliverable) log(`  ✓ ${path.basename(f)}`);
}

// ---------- 3. 子进程清理 ----------
// --dir 模式（或没有可交付文件时）保留全部内容，否则整批就空了
const keepEverything = keepAll || dirOnly || deliverable.length === 0;

if (keepEverything) {
  log(keepAll ? '[build] --keep-all：已保留全部中间文件。'
    : '[build] 本批次无需清理（仅解包目录 / 未生成交付物）。');
} else {
  const keepNames = deliverable.map((f) => path.basename(f));
  const clean = spawnSync(
    process.execPath,
    [path.join(__dirname, 'cleanup.js'), outDir, ...keepNames],
    { cwd: ROOT, encoding: 'utf8' }
  );
  const cleanOut = clean.stdout || '';
  let info = null;
  if (/CLEAN_DONE /.test(cleanOut)) {
    try { info = JSON.parse(cleanOut.split('CLEAN_DONE ').pop().split('\n')[0]); } catch { info = null; }
  }

  if (!info) {
    log('  ! 清理子进程异常退出：中间产物可能残留，可手动删除或加 --keep-all 保留。');
    if (clean.stderr) process.stderr.write(clean.stderr);
  } else {
    for (const name of info.removed) log(`  - 清理 ${name}`);
    for (const name of info.skipped) log(`  ! 跳过（被占用或无法删除）${name}`);
    log(`[build] 已清理非必要文件，释放约 ${formatMB(info.freed)}。`);
  }
}

// ---------- 4. 汇报 ----------
// 这里同样只用字符串，不 stat 产物
log(`\n[build] 产物目录：${path.relative(ROOT, outDir)}`);
for (const f of deliverable) log(`  - ${path.basename(f)}`);
if (!deliverable.length && !keepEverything) log('  （未识别到交付物，请检查上方输出）');
log('[build] 免安装包可直接双击运行；Setup 为 NSIS 安装向导。');
