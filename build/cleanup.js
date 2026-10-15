#!/usr/bin/env node
// cleanup.js —— 删除一批打包中间产物，并把结果回传给父进程
// ============================================================
// 为什么清理要单独跑一个进程（重要）：
//   本机环境下，父进程（build.js）只要对「文件名含中文」的路径做同步 fs 调用
//   （实测 fs.statSync 命中 `DJI素材筛选复制工具 Setup 1.0.0.exe.blockmap`）
//   就会触发原生崩溃 0xC0000409，进程直接消失、stdout 缓冲都来不及刷。
//   把这类文件系统操作隔离到子进程后：
//     - 子进程崩了，父进程依然活着，能如实报告"清理失败但产物可用"；
//     - 父进程全程不碰中文路径，避免把自己也搭进去。
//
// 用法：node cleanup.js <批次目录> <交付物文件名1> [交付物文件名2] ...
// 输出最后一行：CLEAN_DONE <JSON {freed, removed:[], skipped:[], kept:[]}>

'use strict';

const fs = require('fs');
const path = require('path');

const [batchDir, ...keepNames] = process.argv.slice(2);
const keep = new Set(keepNames);

/**
 * 迭代式计算目录 / 文件体积。
 * 深目录 + 大量文件时递归容易爆栈，用显式栈遍历；
 * 目录统计所有子项，文件直接累加 size；读不到的部分忽略。
 * @param {string} target 目标路径（目录或文件）
 * @returns {number} 字节数
 */
function dirSize(target) {
  let total = 0;
  const stack = [target];
  while (stack.length) {
    const p = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      try { total += fs.statSync(p).size; } catch { /* ignore */ }
      continue;
    }
    for (const ent of entries) {
      const full = path.join(p, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile()) {
        try { total += fs.statSync(full).size; } catch { /* ignore */ }
      }
    }
  }
  return total;
}

/**
 * 删除一个路径（目录递归删除 / 文件删除），带重试以对抗占用锁。
 * @param {string} target 目标路径
 * @returns {number} 释放的字节数；删除失败（仍存在）返回 -1
 */
function removePath(target) {
  const size = dirSize(target);
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 });
    return fs.existsSync(target) ? -1 : size;
  } catch {
    return -1;
  }
}

const result = { freed: 0, removed: [], skipped: [], kept: [] };

let names = [];
try {
  names = fs.readdirSync(batchDir);
} catch (err) {
  process.stdout.write(`CLEAN_DONE ${JSON.stringify({ ...result, error: String(err.message) })}\n`);
  process.exit(0);
}

for (const name of names) {
  if (keep.has(name)) { result.kept.push(name); continue; }
  const size = removePath(path.join(batchDir, name));
  if (size >= 0) {
    result.freed += size;
    result.removed.push(name);
  } else {
    result.skipped.push(name);
  }
}

process.stdout.write(`CLEAN_DONE ${JSON.stringify(result)}\n`);
