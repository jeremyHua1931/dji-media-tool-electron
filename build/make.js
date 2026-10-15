#!/usr/bin/env node
// make.js —— 发版用：先跑全部测试，再打包
// ============================================================
//   npm run release               # 测试 + 当前系统安装包
//   npm run release -- --dir      # 测试 + 只出解包目录
//
// 测试不通过就中止，绝不产出有问题的安装包。
// 内联的 && 在 Windows cmd 下有兼容问题，所以用 Node 串起来。

'use strict';

const { preflight, parseTargets, runScript, log, ROOT } = require('./lib');
const path = require('path');

preflight();
const args = process.argv.slice(2);
const { label } = parseTargets(args);

log(`[build] 发版流程：测试 → 打包（${label}）`);

// 1) 主进程纯逻辑测试（纯 Node）
runScript('test');

// 2) 界面端到端冒烟（需要 Electron；清掉可能存在的 RUN_AS_NODE 干扰）
delete process.env.ELECTRON_RUN_AS_NODE;
runScript('test:smoke');

// 3) 打包（把 -- 之后的参数原样透传）
const passthrough = args.filter((a) => a !== '--');
log('\n[build] 测试全部通过，开始打包…');
const { spawnSync } = require('child_process');
const res = spawnSync(
  process.execPath,
  [path.join(ROOT, 'build', 'build.js'), ...passthrough],
  { cwd: ROOT, stdio: 'inherit' }
);
if (res.status !== 0) process.exit(res.status || 1);
