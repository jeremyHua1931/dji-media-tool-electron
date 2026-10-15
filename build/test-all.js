#!/usr/bin/env node
// test-all.js —— 一次跑完两套测试
// ============================================================
//   npm run test:all
//
// 1) 主进程纯逻辑测试（纯 Node）
// 2) 界面冒烟 + 端到端测试（需要 Electron）
//
// 用 Node 串联而不是在 package.json 里写 "a && b"：cmd 与 shell 对
// 退出码和引号的处理不一致，Node 里失败即中止最可靠。

'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT, log, fail } = require('./lib');

/**
 * 以子进程方式跑一条命令，失败即中止整个测试流程。
 * shell: false 保证 Windows 上不会经过 cmd 的引号/退出码重解释。
 * @param {string} cmd   可执行文件路径（node 或 electron cli.js）
 * @param {string[]} args 参数列表
 * @param {string} label 展示用标签
 */
function run(cmd, args, label) {
  log(`\n[test] ▶ ${label}`);
  const res = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: false });
  if (res.error) fail(`无法启动 ${label}：${res.error.message}`);
  if (res.status !== 0) fail(`${label} 失败（退出码 ${res.status}）`);
  log(`[test] ✓ ${label}`);
}

// 1) 纯逻辑
run(process.execPath, [path.join(ROOT, 'test', 'run-tests.js')], '主进程纯逻辑测试');

// 2) 界面冒烟（Electron；清掉可能把 Electron 退化成纯 Node 的环境变量）
delete process.env.ELECTRON_RUN_AS_NODE;
const electronBin = path.join(ROOT, 'node_modules', 'electron', 'cli.js');
run(process.execPath, [electronBin, path.join(ROOT, 'test', 'smoke.js')], '界面冒烟 + 端到端测试');

log('\n[test] 全部测试通过。');
