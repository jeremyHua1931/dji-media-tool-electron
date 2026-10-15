#!/usr/bin/env node
// pack.js —— 只做打包（由 build.js 作为子进程调用，不要直接跑）
// ============================================================
// 为什么要拆出子进程：
//   electron-builder 会加载原生模块并留下后台线程/句柄。等它的 Promise 变成
//   resolved 之后，如果还在同一个进程里同步删除它刚写入的 win-unpacked，
//   进程会在清理阶段直接崩掉（Windows 上是 0xC0000409，日志缓冲都会丢）。
//   把它放进独立子进程，等子进程退出后父进程再调度清理，就没有这个问题。
//
// 约定：最后一行 stdout 输出 PACK_DONE <JSON>，父进程据此拿到产物列表。

'use strict';

const path = require('path');
const { build } = require('electron-builder');
const { ROOT, pkg, parseTargets, buildTargets } = require('./lib');

const args = process.argv.slice(2);
const { key, dirOnly } = parseTargets(args);
const outDir = process.env.DJI_OUT_DIR || '';

// 产物目录由父进程决定（带时间戳），这里只负责写进去
const config = { ...pkg.build };
if (outDir) config.directories = { ...pkg.build.directories, output: outDir };
if (dirOnly) {
  config.win = { ...config.win, target: ['dir'] };
  config.mac = { ...config.mac, target: ['dir'] };
  config.linux = { ...config.linux, target: ['dir'] };
}

build({ targets: buildTargets(key, dirOnly), projectDir: ROOT, config })
  .then((artifacts) => {
    // electron-builder 的进度日志走 stderr，这里用「约定的最后一行」回传结果
    process.stdout.write(`PACK_DONE ${JSON.stringify(artifacts.map((f) => path.resolve(f)))}\n`);
  })
  .catch((err) => {
    process.stderr.write(`PACK_FAILED ${(err && err.message) || err}\n`);
    process.exit(1);
  });
