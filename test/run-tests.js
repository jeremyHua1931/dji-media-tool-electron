// run-tests.js —— 主进程纯逻辑测试（不依赖 Electron，可用 Node 直接跑）
// 覆盖：扩展名识别、扫描筛选（DCIM/日期/类型）、复制（平铺/跳过/改名/覆盖/
//       按日期子文件夹/保留时间/取消/残留清理/进度口径）、盘符枚举冒烟。
'use strict';

const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const assert = require('assert');
const Module = require('module');

// ---- 拦掉 require('electron')：让 ipc.js 能在纯 Node 里被测试 ----
const ipcHandlers = new Map();
const electronStub = {
  ipcMain: {
    handle: (channel, fn) => { ipcHandlers.set(channel, fn); },
  },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openPath: async () => '', showItemInFolder: () => {} },
};
const realLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return realLoad.call(this, request, parent, isMain);
};

const { scanMedia, kindOf } = require('../src/main/services/scanner');
const { copyFiles, dateFolderName } = require('../src/main/services/copier');
const { listVolumes } = require('../src/main/services/drives');
const { getThumbnail } = require('../src/main/services/thumbnails');
const { registerIpc } = require('../src/main/services/ipc');
const { rendererConfig } = require('../src/main/services/config');
const { checkCopyPreflight, isInside } = require('../src/main/services/preflight');

let passed = 0;
let failed = 0;

/**
 * 注册一条测试用例：fn 的 Promise resolve 算通过（计数 + 打印 PASS），
 * reject 算失败（打印 FAIL 与堆栈，并把进程退出码置为 1）。
 * 用例之间互不影响，失败不中断后续用例。
 * @param {string} name 用例名（打印用）
 * @param {function(): Promise<void>} fn 用例体
 */
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed += 1; console.log('PASS', name); })
    .catch((e) => {
      failed += 1;
      console.error('FAIL', name, '\n ', (e && e.stack) || e.message);
      process.exitCode = 1;
    });
}

/**
 * 在临时目录构造一套模拟相机文件树（每条用例独立 mkdtemp）：
 *   <tmp>/DCIM/DJI 001/  -> 今日照片(2) + 视频(1) + 10 天前视频(1) + 非媒体 notes.txt
 *   <tmp>/System Volume Information/ -> 应被跳过的系统目录
 * 返回 { root, files } 供各用例扫描 / 复制 / 断言。
 * @returns {Promise<{root:string, files:object}>}
 */
async function makeFixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dji-test-'));
  const dcim = path.join(root, 'DCIM', 'DJI 001');
  await fsp.mkdir(dcim, { recursive: true });
  await fsp.mkdir(path.join(root, 'System Volume Information'), { recursive: true });

  const write = async (rel, content, when) => {
    const p = path.join(root, rel);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, content);
    const t = new Date(when).getTime() / 1000;
    await fsp.utimes(p, t, t);
    return p;
  };

  const today = new Date();
  const old = new Date(today.getTime() - 10 * 86400000);
  const files = {
    p1: await write('DCIM/DJI 001/DJI_0001.JPG', 'x'.repeat(10), today),
    p2: await write('DCIM/DJI 001/DJI_0002.DNG', 'y'.repeat(20), today),
    v1: await write('DCIM/DJI 001/DJI_0100.MP4', 'z'.repeat(30), today),
    vOld: await write('DCIM/DJI 001/DJI_0099.MOV', 'w'.repeat(40), old),
    sys: await write('System Volume Information/info.txt', 'sys', today),
    doc: await write('DCIM/DJI 001/notes.txt', 'note', today),
  };
  return { root, files };
}

(async () => {
  const { root, files } = await makeFixture();
  const dest = path.join(root, 'OUT');

  // ---------- 扩展名识别 ----------
  await test('kindOf 照片/视频/其他', () => {
    assert.strictEqual(kindOf('a.JPG'), 'photo');
    assert.strictEqual(kindOf('a.dng'), 'photo');
    assert.strictEqual(kindOf('a.mp4'), 'video');
    assert.strictEqual(kindOf('a.txt'), null);
  });

  // ---------- 扫描 ----------
  const all = await scanMedia(root, { dcimOnly: true, wantPhoto: true, wantVideo: true });
  await test('只扫 DCIM 只收媒体（4 个）', () => {
    assert.strictEqual(all.length, 4);
    assert.ok(all.every((f) => f.path.includes('DCIM')));
    assert.ok(!all.some((f) => f.name.endsWith('notes.txt')));
  });

  await test('日期范围筛选（今天 3 个）', async () => {
    const t = new Date();
    const start = new Date(t.getFullYear(), t.getMonth(), t.getDate());
    const end = new Date(t.getFullYear(), t.getMonth(), t.getDate(), 23, 59, 59);
    const r = await scanMedia(root, { start, end, wantPhoto: true, wantVideo: true, dcimOnly: true });
    assert.strictEqual(r.length, 3);
  });

  await test('仅照片 2 个', async () => {
    const r = await scanMedia(root, { wantPhoto: true, wantVideo: false, dcimOnly: true });
    assert.strictEqual(r.length, 2);
    assert.ok(r.every((f) => f.kind === 'photo'));
  });
  await test('仅视频 2 个', async () => {
    const r = await scanMedia(root, { wantPhoto: false, wantVideo: true, dcimOnly: true });
    assert.strictEqual(r.length, 2);
    assert.ok(r.every((f) => f.kind === 'video'));
  });

  // ---------- 复制：基础策略 ----------
  const s1 = await copyFiles(all, dest, { onConflict: 'skip' });
  await test('平铺复制 4 个', () => {
    assert.strictEqual(s1.copied, 4);
    assert.strictEqual(s1.failed.length, 0);
    assert.strictEqual(fs.existsSync(path.join(dest, 'DJI_0001.JPG')), true);
  });

  const s2 = await copyFiles(all, dest, { onConflict: 'skip' });
  await test('二次复制全部跳过', () => assert.strictEqual(s2.skipped, 4));

  await test('复制保留拍摄时间', () => {
    const srcSt = fs.statSync(files.v1);
    const dstSt = fs.statSync(path.join(dest, 'DJI_0100.MP4'));
    assert.strictEqual(Math.round(srcSt.mtimeMs), Math.round(dstSt.mtimeMs));
  });

  const dest2 = path.join(root, 'OUT2');
  await copyFiles(all, dest2, { byDate: true, onConflict: 'skip' });
  await test('按日期建子文件夹', () => {
    const folder = dateFolderName(new Date());
    assert.strictEqual(fs.existsSync(path.join(dest2, folder, 'DJI_0001.JPG')), true);
  });

  const dest3 = path.join(root, 'OUT3');
  const s3 = await copyFiles(all, dest3, { byDate: false, onConflict: 'rename' });
  const s4 = await copyFiles(all, dest3, { byDate: false, onConflict: 'rename' });
  await test('同名自动改名', () => {
    assert.strictEqual(s3.copied, 4);
    assert.strictEqual(s4.copied, 4);
    assert.strictEqual(s4.renamed, 4);
    assert.strictEqual(fs.existsSync(path.join(dest3, 'DJI_0001 (1).JPG')), true);
  });

  const dest4 = path.join(root, 'OUT4');
  const s5 = await copyFiles(all, dest4, { onConflict: 'overwrite' });
  const s6 = await copyFiles(all, dest4, { onConflict: 'overwrite' });
  await test('覆盖策略第二次仍 copied', () => {
    assert.strictEqual(s5.copied, 4);
    assert.strictEqual(s6.copied, 4);
  });

  // ---------- 回归：同名源文件 + 改名策略（旧实现的原子性缺陷） ----------
  await test('多个同名源文件改名不互相覆盖', async () => {
    const srcA = path.join(root, 'A');
    const srcB = path.join(root, 'B');
    await fsp.mkdir(srcA, { recursive: true });
    await fsp.mkdir(srcB, { recursive: true });
    const fA = path.join(srcA, 'DJI_0001.JPG');
    const fB = path.join(srcB, 'DJI_0001.JPG');
    await fsp.writeFile(fA, 'AAAA');
    await fsp.writeFile(fB, 'BBBBBB');
    const list = [
      { name: 'DJI_0001.JPG', path: fA, size: 4, mtime: new Date().toISOString(), kind: 'photo' },
      { name: 'DJI_0001.JPG', path: fB, size: 6, mtime: new Date().toISOString(), kind: 'photo' },
    ];
    const out = path.join(root, 'OUT_COLLIDE');
    const s = await copyFiles(list, out, { onConflict: 'rename' });
    assert.strictEqual(s.copied, 2, '两个同名文件都应复制成功');
    assert.strictEqual(s.failed.length, 0);
    assert.strictEqual(await fsp.readFile(path.join(out, 'DJI_0001.JPG'), 'utf8'), 'AAAA');
    assert.strictEqual(await fsp.readFile(path.join(out, 'DJI_0001 (1).JPG'), 'utf8'), 'BBBBBB');
  });

  // ---------- 回归：取消不留半成品 ----------
  await test('取消时不留下写了一半的目标文件', async () => {
    const srcDir = path.join(root, 'BIG');
    await fsp.mkdir(srcDir, { recursive: true });
    const big = path.join(srcDir, 'BIG_0001.MP4');
    await fsp.writeFile(big, Buffer.alloc(4 * 1024 * 1024, 7)); // 4MB，分块复制中取消
    const list = [{
      name: 'BIG_0001.MP4', path: big, size: 4 * 1024 * 1024,
      mtime: new Date().toISOString(), kind: 'video',
    }];
    const out = path.join(root, 'OUT_CANCEL');
    await fsp.mkdir(out, { recursive: true });

    let started = false;
    const s = await copyFiles(list, out, {
      onConflict: 'skip',
      progress: () => { started = true; },
      isCancelled: () => started, // 第一个分块前就翻转取消标志
    });
    assert.strictEqual(s.cancelled, true);
    assert.strictEqual(s.copied, 0);
    assert.strictEqual(s.skipped, 0);
    const leftovers = (await fsp.readdir(out));
    assert.deepStrictEqual(leftovers, [], `目标目录应为空，实际残留：${leftovers.join(', ')}`);
  });

  await test('置位取消后立即停止', async () => {
    const dest5 = path.join(root, 'OUT5');
    const s = await copyFiles(all, dest5, { onConflict: 'skip', isCancelled: () => true });
    assert.strictEqual(s.cancelled, true);
    assert.strictEqual(s.copied, 0);
  });

  // ---------- 回归：进度字节不双计 ----------
  await test('进度字节数不重复累加', async () => {
    const out = path.join(root, 'OUT_PROG');
    const expected = all.reduce((n, f) => n + f.size, 0);
    let last = null;
    await copyFiles(all, out, {
      onConflict: 'skip',
      progress: (info) => { last = info; },
    });
    assert.ok(last, '应至少收到一次进度回调');
    assert.strictEqual(last.totalBytes, expected);
    assert.strictEqual(last.doneBytes, expected, '完整复制后 doneBytes 应等于 totalBytes');

    // 第二次全部跳过，进度也应走满且不超出总量
    last = null;
    await copyFiles(all, out, {
      onConflict: 'skip',
      progress: (info) => { last = info; },
    });
    assert.strictEqual(last.doneBytes, expected, '跳过时进度也应恰好走满');
  });

  // ---------- 复制前检查：只读保证（绝不往相机里写） ----------
  await test('预检：目标在源目录内部被阻止', async () => {
    const r = await checkCopyPreflight({
      dest: path.join(root, 'DCIM', 'out'),
      sourceRoot: root,
      totalBytes: 100,
      fileCount: 1,
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'DEST_INSIDE_SOURCE');
    assert.ok(r.message.length > 0);
  });

  if (process.platform === 'win32') {
    await test('预检：目标与源在同一盘被阻止（相机只读保证）', async () => {
      const r = await checkCopyPreflight({
        dest: 'C:\\dji-media-tool-test-dest',
        sourceRoot: process.env.SystemDrive ? `${process.env.SystemDrive}\\DCIM` : 'C:\\DCIM',
        totalBytes: 1024,
        fileCount: 1,
      });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.code, 'DEST_SAME_VOLUME');
    });

    await test('预检：空间不足被阻止', async () => {
      const r = await checkCopyPreflight({
        dest: path.join(root, 'OUT_SPACE'),
        sourceRoot: 'Z:\\nowhere',
        totalBytes: Number.MAX_SAFE_INTEGER / 2,
        fileCount: 1,
      });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.code, 'NOT_ENOUGH_SPACE');
      assert.ok(r.need > 0);
    });
  }

  await test('预检：跨盘正常情况放行并回报可用空间', async () => {
    // 只构造路径、不碰文件系统：Windows 用另一个盘符，类 Unix 用不同挂载点
    const srcRoot = process.platform === 'win32' ? 'Z:\\DCIM' : '/mnt/camera/DCIM';
    const dest = process.platform === 'win32' ? 'Y:\\照片备份' : '/tmp/dji-backup';
    const total = all.reduce((s, f) => s + f.size, 0);
    const r = await checkCopyPreflight({
      dest,
      sourceRoot: srcRoot,
      totalBytes: total,
      fileCount: all.length,
    });
    assert.strictEqual(r.ok, true);
    assert.ok(r.need >= total);
  });

  await test('预检：缺来源 / 缺目标有明确错误码', async () => {
    const a = await checkCopyPreflight({ dest: '', sourceRoot: 'X:\\' });
    assert.strictEqual(a.code, 'NO_DEST');
    const b = await checkCopyPreflight({ dest: 'X:\\y', sourceRoot: '' });
    assert.strictEqual(b.code, 'NO_SOURCE');
  });

  await test('isInside 判断目录包含关系', () => {
    assert.strictEqual(isInside(path.join(root, 'a', 'b'), root), true);
    assert.strictEqual(isInside(root, root), true);
    assert.strictEqual(isInside(path.join(path.dirname(root), 'other'), root), false);
  });

  // ---------- 增量：只复制新文件 ----------
  await test('只复制新文件：重复运行不产生副本', async () => {
    const out = path.join(root, 'OUT_INCR');
    const first = await copyFiles(all, out, { onlyNew: true, onConflict: 'rename' });
    assert.strictEqual(first.copied, all.length, '首次应全部复制');
    assert.strictEqual(first.alreadyExists, 0);

    const second = await copyFiles(all, out, { onlyNew: true, onConflict: 'rename' });
    assert.strictEqual(second.copied, 0, '第二次不应再复制');
    assert.strictEqual(second.alreadyExists, all.length);
    // 关键：不能出现 "xxx (1).jpg" 这类重复副本
    assert.strictEqual(fs.readdirSync(out).length, all.length);
    assert.ok(!fs.readdirSync(out).some((n) => /\(\d+\)/.test(n)));
  });

  await test('只复制新文件：内容变化的同名文件会被重新复制', async () => {
    const out = path.join(root, 'OUT_INCR2');
    const one = [{
      name: 'CHANGED.JPG', path: files.p1, size: 10,
      mtime: new Date().toISOString(), kind: 'photo',
    }];
    await copyFiles(one, out, { onlyNew: true });
    // 同大小 -> 跳过
    const same = await copyFiles(one, out, { onlyNew: true });
    assert.strictEqual(same.alreadyExists, 1);
    // 换成不同大小（模拟相机里又拍了新的一张同名文件）-> 重写
    const bigger = [{ ...one[0], size: 999 }];
    const again = await copyFiles(bigger, out, { onlyNew: true, onConflict: 'overwrite' });
    assert.strictEqual(again.copied, 1);
  });

  // ---------- 复制后校验 ----------
  await test('复制后校验：正常情况下逐项通过', async () => {
    const out = path.join(root, 'OUT_VERIFY');
    const s = await copyFiles(all, out, { verify: true });
    assert.strictEqual(s.copied, all.length);
    assert.strictEqual(s.verified, all.length);
    assert.deepStrictEqual(s.verifyFailed, []);
    assert.strictEqual(s.bytesCopied, all.reduce((n, f) => n + f.size, 0));
  });

  await test('复制后校验：目标被写坏（大小不符）时删除并计入失败', async () => {
    const out = path.join(root, 'OUT_VERIFY_BAD');
    const list = [{
      name: 'BROKEN.JPG', path: files.p1, size: 10,
      mtime: new Date().toISOString(), kind: 'photo',
    }];
    // onBeforeVerify 是给测试用的钩子：在写完之后、校验之前把目标文件改坏
    const s = await copyFiles(list, out, {
      verify: true,
      onBeforeVerify: async (target) => {
        await fsp.appendFile(target, 'corrupted-extra-bytes');
      },
    });
    assert.strictEqual(s.copied, 0, '校验不过不能算复制成功');
    assert.strictEqual(s.verifyFailed.length, 1);
    assert.strictEqual(s.failed.length, 1);
    assert.strictEqual(fs.existsSync(path.join(out, 'BROKEN.JPG')), false,
      '校验不过的目标文件必须删除，不能冒充成功');
  });

  // ---------- 缩略图：尺寸白名单 ----------
  await test('缩略图拒绝未授权的尺寸', async () => {
    const bad = await getThumbnail(files.p1, 2048);
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(bad.error, 'unsupported-size');
    const ok = await getThumbnail(files.p1, 48);
    assert.strictEqual(ok.ok, false); // 纯 Node 无 nativeImage，但不该是 unsupported-size
    assert.strictEqual(ok.error, 'no-native-image');
  });

  // ---------- IPC：缩略图路径白名单 ----------
  await test('IPC 缩略图只允许扫描过的目录', async () => {
    registerIpc(() => null);
    const scan = ipcHandlers.get('scan:start');
    const thumb = ipcHandlers.get('thumb:get');
    assert.ok(scan && thumb, 'IPC 处理器应已注册');

    await scan({}, { root, dcimOnly: true, wantPhoto: true, wantVideo: true });

    const inside = await thumb({}, files.p1, 48);
    assert.notStrictEqual(inside.error, 'forbidden', '扫描命中目录内的文件应放行');

    const outside = await thumb({}, path.join(os.tmpdir(), 'not-scanned', 'x.jpg'), 48);
    assert.strictEqual(outside.ok, false);
    assert.strictEqual(outside.error, 'forbidden');

    const badSize = await thumb({}, files.p1, 999);
    assert.strictEqual(badSize.error, 'unsupported-size');
  });

  await test('IPC 拒绝无效扫描/复制参数', async () => {
    registerIpc(() => null);
    await assert.rejects(() => ipcHandlers.get('scan:start')({}, { root: '' }), /素材来源无效/);
    await assert.rejects(
      () => ipcHandlers.get('copy:start')({}, { files: [], dest: 'x' }),
      /没有要复制的文件/
    );
    await assert.rejects(
      () => ipcHandlers.get('copy:start')({}, { files: [{ name: 'a' }], dest: '  ' }),
      /目标文件夹无效/
    );
  });

  await test('IPC 下发的前端常量含网格尺寸', async () => {
    registerIpc(() => null);
    const cfg = await ipcHandlers.get('app:config')();
    assert.deepStrictEqual(cfg, rendererConfig());
    for (const key of ['detail', 'icon_small', 'icon_medium', 'icon_large']) {
      assert.ok(cfg.THUMB_SIZES[key], `缺少 ${key} 规格`);
      assert.ok(cfg.THUMB_SIZES[key].thumb > 0);
    }
  });

  // ---------- 盘符枚举冒烟 ----------
  await test('listVolumes 返回数组（异步）', async () => {
    const vols = await listVolumes();
    assert.ok(Array.isArray(vols));
    if (process.platform === 'win32') assert.ok(vols.length >= 1);
    for (const v of vols) {
      assert.strictEqual(typeof v.root, 'string');
      assert.strictEqual(typeof v.hasDCIM, 'boolean');
    }
  });

  if (failed) {
    console.error(`=== 存在失败用例：失败 ${failed} 项 / 通过 ${passed} 项 ===`);
  } else {
    console.log(`=== 全部测试通过（${passed} 项）===`);
  }
})().catch((e) => {
  console.error('测试运行器异常：', e);
  process.exitCode = 1;
});
