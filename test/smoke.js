// smoke.js —— 冒烟测试（由 electron 直接执行：electron test/smoke.js）
// 加载真实界面，验证渲染进程无报错、关键元素与 preload API 就绪、
// 端到端扫描/视图切换/素材文件夹栏/缩略图管线，结束后自动退出。
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const { app, BrowserWindow } = require('electron');
const { registerIpc } = require('../src/main/services/ipc');

// ---- 造一张真实 PNG（32x32 纯色），用于验证缩略图整条链路 ----
// 手写 PNG 编码（含 CRC），不依赖任何图片库：测试环境零第三方依赖
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

/**
 * 计算 PNG CRC32 校验值（PNG chunk 结构必需）。
 * @param {Buffer} buf 数据
 * @returns {number} CRC32 值
 */
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * 构造一个 PNG chunk（4 字节长度 + 类型 + 数据 + CRC32）。
 * @param {string} type 4 字符的 chunk 类型（如 'IHDR'）
 * @param {Buffer} data chunk 数据
 * @returns {Buffer} 完整 chunk 字节
 */
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * 生成一张 w x h 的纯色 PNG（IHDR + IDAT(deflate) + IEND 三段）。
 * @param {number} w 宽度
 * @param {number} h 高度
 * @returns {Buffer} PNG 文件字节
 */
function makePng(w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: truecolor
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y += 1) {
    const row = y * (1 + w * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < w; x += 1) {
      const p = row + 1 + x * 3;
      raw[p] = 0x30; raw[p + 1] = 0x90; raw[p + 2] = 0xe0;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// 构造一个临时相机素材目录（DCIM 下 1 张真实 PNG + 1 张假照片 + 1 个视频），
// 用于端到端验证扫描 / 缩略图 / 预览 / 复制链路
function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dji-smoke-'));
  const dcim = path.join(root, 'DCIM', 'DJI 001');
  fs.mkdirSync(dcim, { recursive: true });
  fs.writeFileSync(path.join(dcim, 'P001.JPG'), 'x');
  fs.writeFileSync(path.join(dcim, 'P002.PNG'), makePng(32, 32)); // 可被系统解码
  fs.writeFileSync(path.join(dcim, 'V001.MP4'), 'z');
  return root;
}
// 目标目录必须放在源目录之外、且最好在另一个盘上：应用会拒绝往源盘/源目录内写
// （相机只读保证），所以端到端复制需要找一个"跨盘"的临时目录。

/**
 * 取路径所在盘的根（小写），用于跨盘判断。
 * @param {string} p 路径
 * @returns {string} 如 "f:\\"
 */
function volumeRootOf(p) {
  return path.parse(path.resolve(p)).root.toLowerCase();
}

/**
 * 找第一个与指定盘不同的、可写盘上的临时目录。
 * Windows 枚举 DEFGHIJKLMNOPQRSTUVWXYZ 盘；类 Unix 尝试常见挂载点。
 * 都不可用返回 null（此时端到端复制用例会跳过，不当作失败）。
 * @param {string} excludeRoot 要排除的盘根（源目录所在盘）
 * @returns {string|null} 可写的跨盘临时目录
 */
function findCrossVolumeDir(excludeRoot) {
  const bases = process.platform === 'win32'
    ? 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((c) => `${c}:\\`)
    : ['/tmp', '/var/tmp', '/mnt', '/Volumes', '/home'];
  const targetVol = volumeRootOf(excludeRoot);
  for (const b of bases) {
    if (volumeRootOf(b) === targetVol) continue;
    try {
      if (!fs.existsSync(b)) continue;
      const dir = fs.mkdtempSync(path.join(b, 'dji-smoke-out-'));
      return dir;
    } catch { /* 无权限或盘不可写，试下一个 */ }
  }
  return null;
}

const fixtureRoot = makeFixture();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const destDir = findCrossVolumeDir(fixtureRoot);
const destDirCancelled = fs.mkdtempSync(path.join(os.tmpdir(), 'dji-smoke-cancel-'));

// 计划好的弹窗回答：队列里取出一个；返回 null 表示"用户点了取消"。
const dialogPlan = [];
const dialogCalls = [];

// 关键：必须在 registerIpc 之前把 dialog 换掉。
// 渲染进程里的 window.api 是 contextBridge 生成的代理，测试无法可靠地覆盖
// 它的方法（每次访问可能是新代理对象），所以桩要打在主进程这一层。
const electron = require('electron');
electron.dialog.showOpenDialog = async (_win, options) => {
  dialogCalls.push(options && options.title);
  if (!dialogPlan.length) return { canceled: true, filePaths: [] };
  const answer = dialogPlan.shift();
  if (!answer) return { canceled: true, filePaths: [] };
  return { canceled: false, filePaths: [answer] };
};

// 让"自动检测相机"在本机稳定复现：drives.js 支持用环境变量注入卷列表
// （只在测试里设置）。这样启动自动检测走的是真实代码路径：卷 -> DCIM ->
// 素材最多的子文件夹，连"统计素材数"的逻辑都被覆盖到。
process.env.DJI_TEST_VOLUMES = JSON.stringify([{
  root: fixtureRoot,
  name: 'DJI-POCKET-TEST',
  removable: true,
  hasDCIM: true,
  platform: process.platform,
}]);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1080,
    height: 780,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true, // 与 main.js 保持一致，确保收紧沙箱后 preload 仍可用
    },
  });

  let failed = false;
  const logs = [];

  registerIpc(() => win);
  win.webContents.on('console-message', (_e, levelOrDetails, message) => {
    // 兼容新旧两种回调签名（Electron 33 为 details 对象）
    let level, text;
    if (levelOrDetails && typeof levelOrDetails === 'object') {
      level = levelOrDetails.level;
      text = levelOrDetails.message +
        ` (line=${levelOrDetails.lineNumber} src=${levelOrDetails.sourceId})`;
    } else {
      level = levelOrDetails;
      text = message;
    }
    logs.push({ level, text });
    if (level >= 2) failed = true;
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    failed = true;
    console.error('[render-process-gone]', d.reason);
  });

  try {
    await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
    // 先清掉上一次运行留下的抽屉位置，再重新加载一次，让应用在"没有存档"的
    // 干净状态下启动（否则会被上次的位置影响，居中与拖动断言都不稳定）
    await win.webContents.executeJavaScript('localStorage.clear(); true');
    await win.webContents.reload();
    await wait(300);
    const logsBeforeProbe = logs.length;
    // 启动会自动检测相机 + 自动扫描一次，等它跑完
    await wait(2600);
    const title = await win.webContents.executeJavaScript('document.title');
    const trivial = await win.webContents.executeJavaScript('1 + 1');
    await wait(200);

    const probe = await win.webContents.executeJavaScript(`(function(){
      const drawer = document.getElementById('settingsDrawer');
      const optsToggle = document.getElementById('optionsToggle');
      const typeChecked = document.querySelector('input[name="fType"]:checked');
      const quickButtons = Array.from(document.querySelectorAll('[data-quick]'))
        .map((b) => b.textContent.trim());
      return {
        apiReady: !!(window.api && window.api.scan && window.api.getThumbnail
                     && window.api.readConfig && window.api.revealPath
                     && window.api.suggestMediaRoot),
        viewButtons: document.querySelectorAll('#viewSeg button').length,
        detailTable: !!document.querySelector('.detail-view'),
        iconView: !!document.getElementById('iconView'),
        modal: !!document.getElementById('optionsModal'),
        // 新布局：选项默认收在抽屉里，结果区占主体
        drawerHidden: drawer.classList.contains('hidden'),
        toggleText: optsToggle.textContent,
        paramSummary: document.getElementById('paramSummary').textContent,
        emptyTipHasText: document.getElementById('emptyTip').textContent.trim().length > 0,
        folderBarHidden: document.getElementById('sourceFolderBar').classList.contains('hidden'),
        // 结果区应占据窗口大部分高度
        listHeight: document.querySelector('.list-wrap').getBoundingClientRect().height,
        windowHeight: window.innerHeight,
        // 预览窗格：默认展开、可关闭、初始为空态
        previewVisible: !document.getElementById('previewPane').classList.contains('hidden'),
        previewBodyHidden: document.getElementById('previewBody').classList.contains('hidden'),
        previewEmptyText: document.getElementById('previewEmpty').textContent.trim(),
        previewHasClose: !!document.getElementById('previewClose'),
        // 抽屉可拖动：标题栏是拖拽把手，且用 fixed 定位（可自由移动）
        drawerCursor: getComputedStyle(document.getElementById('drawerHead')).cursor,
        drawerPosition: getComputedStyle(drawer).position,
        // “保存到”已从抽屉里移除
        drawerHasDestInput: !!document.querySelector('#settingsDrawer #destPath'),
        // 新增：启动自动检测与实际扫描结果 + 默认时间范围 + 文件类型“全部”
        autoSource: document.getElementById('srcPath').value,
        autoRows: document.querySelectorAll('#detailBody tr').length,
        autoStatus: document.getElementById('status').textContent,
        dateFrom: document.getElementById('dateFrom').value,
        dateTo: document.getElementById('dateTo').value,
        quickButtons,
        typeText: typeChecked ? typeChecked.value : null,
        typeLabels: Array.from(document.querySelectorAll('input[name="fType"]'))
          .map((i) => (i.parentElement.textContent || '').trim()),
        refreshState: document.getElementById('refreshState').textContent,
        hasRefreshBtn: !!document.getElementById('refreshBtn'),
        cameraNoticeVisible: !document.getElementById('cameraNotice').classList.contains('hidden'),
      };
    })()`);
    console.log('SMOKE_PROBE=' + JSON.stringify(probe));
    const errBeforeProbe = logs.slice(0, logsBeforeProbe).some((l) => l.level >= 2);

    // 抽屉可用
    await win.webContents.executeJavaScript(
      "document.getElementById('optionsToggle').click();"
    );
    await wait(150);
    const drawerOpen = await win.webContents.executeJavaScript(`(function(){
      const d = document.getElementById('settingsDrawer');
      return {
        open: !d.classList.contains('hidden'),
        // 抽屉里现在只应有：素材来源（含只扫描 DCIM）与复制行为
        hasSrcInput: !!d.querySelector('#srcPath'),
        hasDcimCheck: !!d.querySelector('#dcimOnly'),
        hasCopyOptions: !!d.querySelector('#copyOptionsBtn'),
        // 这三样都应当已经移出抽屉
        hasDestInput: !!d.querySelector('#destPath'),
        hasTypeInputs: !!d.querySelector('input[name="fType"]'),
        hasDateInputs: !!d.querySelector('#dateFrom') || !!d.querySelector('#dateTo'),
      };
    })()`);

    // 抽屉可拖动：模拟把标题栏拖走，位置应发生变化
    const dragMove = await win.webContents.executeJavaScript(`(function(){
      const head = document.getElementById('drawerHead');
      const drawer = document.getElementById('settingsDrawer');
      const before = drawer.getBoundingClientRect();
      // 先记录"默认弹出位置"是否居中（首次运行没有存档时应当居中）
      const centered = Math.abs((before.left + before.right) / 2 - window.innerWidth / 2) < 60
        && Math.abs((before.top + before.bottom) / 2 - window.innerHeight / 2) < 90;
      // 抽屉位置存在 localStorage 里、跨运行保留，可能已经贴边。
      // 所以往外拖之前先判断哪边有空间，向有空间的一侧拖，断言才稳定。
      const roomRight = window.innerWidth - before.right;
      const stepX = roomRight > 140 ? 70 : -70;
      const roomDown = window.innerHeight - before.bottom;
      const stepY = roomDown > 120 ? 60 : -60;
      const opts = (x, y) => ({ bubbles: true, cancelable: true, button: 0,
        pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: x, clientY: y });
      // pointerdown 抓在标题栏中部，避免落在按钮上（按钮会被排除在拖拽之外）
      const grabX = before.left + before.width / 2;
      const grabY = before.top + 10;
      head.dispatchEvent(new PointerEvent('pointerdown', opts(grabX, grabY)));
      head.dispatchEvent(new PointerEvent('pointermove', opts(grabX + stepX, grabY + stepY)));
      head.dispatchEvent(new PointerEvent('pointerup', opts(grabX + stepX, grabY + stepY)));
      const after = drawer.getBoundingClientRect();
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem('dji.drawerPos') || 'null'); } catch { /* ignore */ }
      return {
        centered,
        dx: Math.round(after.left - before.left),
        dy: Math.round(after.top - before.top),
        expectDx: stepX,
        expectDy: stepY,
        draggingClassCleared: !drawer.classList.contains('dragging'),
        savedMatches: !!saved
          && Math.abs(saved.left - Math.round(after.left)) <= 2
          && Math.abs(saved.top - Math.round(after.top)) <= 2,
      };
    })()`);

    // 端到端：来源已由"启动自动检测"填好，这里读结果区状态
    // （这里也顺带验证：启动自动检测 -> 自动填入来源 -> 自动扫描这条链路）
    const e2e = await win.webContents.executeJavaScript(`(function(){
      const bar = document.getElementById('sourceFolderBar');
      const paths = Array.from(document.querySelectorAll('.sf-path')).map((e) => e.textContent);
      return {
        rows: document.querySelectorAll('#detailBody tr').length,
        status: document.getElementById('status').textContent,
        summary: document.getElementById('paramSummary').textContent,
        folderBarVisible: !bar.classList.contains('hidden'),
        folderPaths: paths,
        folderOpenButtons: document.querySelectorAll('.sf-open').length,
      };
    })()`);

    // 切到图标视图也应渲染出同样数量的条目
    await win.webContents.executeJavaScript(
      "document.querySelector('#viewSeg button[data-view=\"icon_large\"]').click();"
    );
    await wait(600);
    const e2eIcons = await win.webContents.executeJavaScript(
      'document.querySelectorAll("#iconView .icon-cell").length'
    );

    // 缩略图管线：缩略图尺寸必须来自主进程 config（单一来源），且不产生错误日志
    const thumb = await win.webContents.executeJavaScript(`(function(){
      document.querySelector('#viewSeg button[data-view="icon_medium"]').click();
      return true;
    })()`);
    await wait(1500);
    const thumbState = await win.webContents.executeJavaScript(`(function(){
      const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      // 只统计列表里的图（预览窗格里的那张单独断言）
      const imgs = Array.from(document.querySelectorAll('#iconView img[data-thumb]')).filter(visible);
      return {
        count: imgs.length,
        loadedAttrs: imgs.map((i) => i.dataset.loaded),
        gridCols: document.getElementById('iconView').style.gridTemplateColumns,
        // 真实可解码的那张应拿到 Blob URL（其余保持占位图标，不算失败）
        blobCount: imgs.filter((i) => i.dataset.blobUrl).length,
        allHaveSrc: imgs.every((i) => !!i.getAttribute('src')),
        previewBlobbed: !!document.getElementById('pvImage').dataset.blobUrl,
      };
    })()`);

    const errAfter = logs.filter((l) => l.level >= 2);

    // ---- 预览窗格：点选文件后应显示该文件信息，可关闭可恢复 ----
    // 选中 P002.PNG（真实可解码的图片），这样预览窗格也能验证缩略图链路
    await win.webContents.executeJavaScript(`(function(){
      document.querySelector('#viewSeg button[data-view="detail"]').click();
      const rows = Array.from(document.querySelectorAll('#detailBody tr'));
      const target = rows.find((r) => r.dataset.id.indexOf('P002.PNG') > 0) || rows[0];
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    })()`);
    await wait(700);
    const preview = await win.webContents.executeJavaScript(`(function(){
      const pane = document.getElementById('previewPane');
      return {
        visible: !pane.classList.contains('hidden'),
        bodyShown: !document.getElementById('previewBody').classList.contains('hidden'),
        name: document.getElementById('pvName').textContent,
        kind: document.getElementById('pvKind').textContent,
        size: document.getElementById('pvSize').textContent,
        pathText: document.getElementById('pvPath').textContent,
        blobbed: !!document.getElementById('pvImage').dataset.blobUrl,
        // 列表结果区宽度应为窗口宽度减去预览窗格
        listWidth: document.querySelector('.results').getBoundingClientRect().width,
        paneWidth: Math.round(pane.getBoundingClientRect().width),
        windowWidth: window.innerWidth,
      };
    })()`);

    const previewClosed = await win.webContents.executeJavaScript(`(function(){
      document.getElementById('previewClose').click();
      const pane = document.getElementById('previewPane');
      const listW1 = document.querySelector('.results').getBoundingClientRect().width;
      const hidden1 = pane.classList.contains('hidden');
      const toggleText = document.getElementById('previewToggle').textContent;
      document.getElementById('previewToggle').click(); // 再打开
      return {
        hiddenAfterClose: hidden1,
        listWidthAfterClose: Math.round(listW1),
        toggleTextAfterClose: toggleText,
        reopened: !pane.classList.contains('hidden'),
      };
    })()`);

    // ---- 端到端复制：点“一键复制”应先要保存位置，再真的把文件写进目标目录 ----
    await win.webContents.executeJavaScript(`(function(){
      window.alert = function () {};        // 屏蔽提示框，避免阻塞后续脚本
      window.confirm = function () { return true; };
      window.__errs = window.__errs || [];
      window.addEventListener('error', (e) => window.__errs.push('error: ' + (e.message || e.error)));
      window.addEventListener('unhandledrejection',
        (e) => window.__errs.push('reject: ' + ((e.reason && e.reason.message) || e.reason)));
      return true;
    })()`);

    const skipped = [];
    let copiedFiles = [];
    let copiedOk = false;
    let copyUi = { status: '', summary: '' };
    let incremental = { count: -1, noCopies: false, status: '' };
    let modalState = null;

    // 前面预览测试选中了一项，而"有选中就只复制选中项"。
    // 这里先点列表空白处取消选中，按"未选=复制全部"验证，顺带验证这条规则。
    await win.webContents.executeJavaScript(`(function(){
      document.querySelector('.list-wrap').dispatchEvent(
        new MouseEvent('click', { bubbles: true }));
    })()`);
    const clearedSelection = await win.webContents.executeJavaScript(
      "document.querySelectorAll('#detailBody tr.selected').length"
    );

    if (!destDir) {
      // 单盘机器上造不出"跨盘目标"，端到端复制跳过（只读保证本身由单元测试覆盖）
      skipped.push('端到端复制（本机只有一个可用盘，无法构造跨盘目标）');
      copyUi = await win.webContents.executeJavaScript(`({
        status: document.getElementById('status').textContent,
        summary: document.getElementById('paramSummary').textContent,
      })`);
    } else {
      dialogPlan.push(destDir);
      // 新的复制流程：点「一键复制」先弹「复制选项」，确认后才选保存位置
      await win.webContents.executeJavaScript("document.getElementById('copyBtn').click();");
      await wait(400);
      modalState = await win.webContents.executeJavaScript(`(function(){
        const m = document.getElementById('optionsModal');
        const box = m.querySelector('.modal').getBoundingClientRect();
        return {
          visible: !m.classList.contains('hidden'),
          centeredX: Math.abs((box.left + box.right) / 2 - window.innerWidth / 2) < 40,
          centeredY: Math.abs((box.top + box.bottom) / 2 - window.innerHeight / 2) < 60,
          okText: document.getElementById('optOk').textContent,
          hasConflictRadios: m.querySelectorAll('input[name="conflict"]').length,
          hasByDate: !!document.getElementById('optByDateModal'),
          hasOnlyNew: !!document.getElementById('optOnlyNewModal'),
          hasVerify: !!document.getElementById('optVerifyModal'),
        };
      })()`);
      await win.webContents.executeJavaScript("document.getElementById('optOk').click();");
      await wait(2500);
      copiedFiles = fs.readdirSync(destDir)
        .filter((n) => fs.statSync(path.join(destDir, n)).isFile());
      copiedOk = copiedFiles.length === 3
        && fs.readFileSync(path.join(destDir, 'P002.PNG')).length > 0; // 内容非空
      copyUi = await win.webContents.executeJavaScript(`({
        status: document.getElementById('status').textContent,
        summary: document.getElementById('paramSummary').textContent,
      })`);

      // 增量：再点一次，目标里已有同名同大小 -> 不应重复写入，也不该出现 (1) 副本
      dialogPlan.push(destDir);
      await win.webContents.executeJavaScript("document.getElementById('copyBtn').click();");
      await wait(400);
      await win.webContents.executeJavaScript("document.getElementById('optOk').click();");
      await wait(1800);
      const secondFiles = fs.readdirSync(destDir);
      incremental = {
        count: secondFiles.length,
        noCopies: !secondFiles.some((n) => /\(\d+\)/.test(n)),
        status: await win.webContents.executeJavaScript(
          "document.getElementById('status').textContent"
        ),
      };
      // 复制选项弹窗的居中与内容断言挂到 copiedOk 之外单独记
      copiedOk = copiedOk && modalState.visible === true
        && modalState.centeredX === true && modalState.centeredY === true
        && modalState.okText.indexOf('保存位置') > 0
        && modalState.hasConflictRadios === 3
        && modalState.hasByDate === true && modalState.hasOnlyNew === true
        && modalState.hasVerify === true;    }

    // 取消保存位置选择时，不应复制任何文件（同样要先过「复制选项」弹窗）
    dialogPlan.push(null); // 用户点了取消
    await win.webContents.executeJavaScript("document.getElementById('copyBtn').click();");
    await wait(350);
    await win.webContents.executeJavaScript("document.getElementById('optOk').click();");
    await wait(900);
    const cancelUi = await win.webContents.executeJavaScript(
      "document.getElementById('status').textContent"
    );
    const cancelledNothingCopied = fs.readdirSync(destDirCancelled).length === 0;

    // ---- 相机只读保证：目标落在源目录内时必须被拦下 ----
    const insideDest = path.join(fixtureRoot, 'DCIM', 'DJI 001', 'out-inside');
    dialogPlan.push(insideDest);
    await win.webContents.executeJavaScript("document.getElementById('copyBtn').click();");
    await wait(350);
    await win.webContents.executeJavaScript("document.getElementById('optOk').click();");
    await wait(1400);
    const guardUi = await win.webContents.executeJavaScript(
      "document.getElementById('status').textContent"
    );
    const insideBlocked = !fs.existsSync(insideDest);

    // 说明：「目标与源同盘」这条只读保证由 test/run-tests.js 用可控盘符覆盖，
    //       这里不再造同盘场景（临时目录本来就在同一个盘上，会互相干扰）。

    // 主进程弹窗桩收到的调用（渲染进程无法可靠地覆盖 contextBridge 代理，
      // 所以断言放在了主进程这一层）
    const pickCalls = dialogCalls.slice();

    const expectedFolder = path.join(fixtureRoot, 'DCIM', 'DJI 001');
    // 逐条列出断言结果，任何一条失败都能直接看出是哪条
    const checks = {
      trivial: trivial === 2,
      title: typeof title === 'string' && title.length > 0,
      apiReady: probe.apiReady === true,
      viewButtons: probe.viewButtons === 4,
      detailTable: probe.detailTable === true,
      iconView: probe.iconView === true,
      modal: probe.modal === true,
      drawerHidden: probe.drawerHidden === true,
      emptyTip: probe.emptyTipHasText === true,
      // 启动自动检测并自动扫描后，素材文件夹栏应当已经显示出来
      folderBarVisible: probe.folderBarHidden === false,
      listHeight: probe.listHeight > probe.windowHeight * 0.45, // 结果区仍应占主体
      previewVisible: probe.previewVisible === true,
      previewBodyHidden: probe.previewBodyHidden === true,
      previewHasClose: probe.previewHasClose === true,
      previewEmptyText: probe.previewEmptyText.length > 0,
      drawerCursor: probe.drawerCursor === 'move',
      drawerPosition: probe.drawerPosition === 'fixed',
      drawerNoDestInput: probe.drawerHasDestInput === false,
      drawerOpen: drawerOpen.open === true,
      drawerSrcInput: drawerOpen.hasSrcInput === true,
      drawerDcimCheck: drawerOpen.hasDcimCheck === true,
      drawerCopyOptions: drawerOpen.hasCopyOptions === true,
      drawerDestInput: drawerOpen.hasDestInput === false,
      drawerTypeInputs: drawerOpen.hasTypeInputs === false,
      drawerDateInputs: drawerOpen.hasDateInputs === false,
      dragDx: dragMove.dx === dragMove.expectDx,
      dragDy: dragMove.dy === dragMove.expectDy,
      dragClassCleared: dragMove.draggingClassCleared === true,
      dragSavedMatches: dragMove.savedMatches === true,
      e2eRows: e2e.rows === 3,
      e2eFolderBar: e2e.folderBarVisible === true,
      e2eFolderPaths: e2e.folderPaths.length === 1,
      e2eFolderPathValue: e2e.folderPaths[0] === expectedFolder,
      e2eFolderOpenBtn: e2e.folderOpenButtons === 1,
      paneWidth: preview.paneWidth > 200,
      paneLayout: preview.listWidth + preview.paneWidth <= preview.windowWidth,
      previewBodyShown: preview.bodyShown === true,
      previewName: preview.name === 'P002.PNG',
      previewPath: preview.pathText.indexOf('DCIM') > 0,
      previewBlob: preview.blobbed === true,
      previewClosedHidden: previewClosed.hiddenAfterClose === true,
      previewClosedWider: previewClosed.listWidthAfterClose > preview.listWidth,
      previewClosedToggle: previewClosed.toggleTextAfterClose === '显示预览',
      previewClosedReopened: previewClosed.reopened === true,
      e2eIcons: e2eIcons === 3,
      thumbCount: thumbState.count === 3,
      thumbSizes: thumbState.loadedAttrs.every((v) => v === '96'),
      thumbGridCols: thumbState.gridCols.includes('154px'),
      thumbBlob: thumbState.blobCount >= 1,
      thumbSrc: thumbState.allHaveSrc === true,
      pickCalled: pickCalls.length >= 1,
      pickTitle: pickCalls.length > 0 && pickCalls[0].indexOf('保存') >= 0,
      clearedSelection: clearedSelection === 0,
      copiedOk: destDir === null || copiedOk === true,
      copyStatus: destDir === null || copyUi.status.indexOf('复制完成') === 0,
      incrementalCount: destDir === null || incremental.count === 3,
      incrementalNoCopies: destDir === null || incremental.noCopies === true,
      incrementalStatus: destDir === null || incremental.status.indexOf('已存在跳过') > 0,
      summaryDest: copyUi.summary.indexOf('存到') >= 0,
      cancelNothing: cancelledNothingCopied === true,
      cancelStatus: cancelUi.indexOf('已取消') >= 0,
      insideBlocked: insideBlocked === true,
      // 启动自动检测 + 默认时间范围 + 文件类型“全部” + 自动刷新
      autoSource: probe.autoSource === path.join(fixtureRoot, 'DCIM', 'DJI 001'),
      autoRows: probe.autoRows === 3,
      cameraNotice: probe.cameraNoticeVisible === true,
      defaultRange: probe.dateFrom.length === 10 && probe.dateTo.length === 10,
      quickButtons: probe.quickButtons.join('|') === '今天|一天|三天|七天|不限',
      typeLabels: probe.typeLabels.join('|') === '全部|仅照片|仅视频',
      typeDefault: probe.typeText === 'both',
      refreshBtn: probe.hasRefreshBtn === true,
      refreshState: /已刷新/.test(probe.refreshState),
      drawerCentered: dragMove.centered === true,
      copyModalFlow: destDir === null || (modalState && modalState.visible === true),
      noErrors: errAfter.length === 0 && !errBeforeProbe,
    };
    const failedChecks = Object.keys(checks).filter((k) => !checks[k]);
    const ok = failedChecks.length === 0 && trivial === 2;
    console.log(ok ? 'SMOKE_OK' : 'SMOKE_FAIL ' + failedChecks.join(','));
    // GUI 程序 stdout 可能不可见，结果同时落盘
    fs.writeFileSync(
      path.join(__dirname, 'smoke-result.json'),
      JSON.stringify({
        ok, failedChecks, checks, probe, trivial, drawerOpen, dragMove, e2e,
        preview, previewClosed, e2eIcons, thumb, thumbState, pickCalls,
        copiedFiles, copiedOk, copyUi, incremental, cancelUi,
        cancelledNothingCopied, insideBlocked, guardUi, destDir, skipped,
        errBeforeProbe, errAfter, logs,
      }, null, 2),
      'utf8'
    );
    app.exit(ok ? 0 : 1);
  } catch (err) {
    console.error('SMOKE_ERROR', err && err.stack ? err.stack : err);
    // 出错也要落盘，否则看不出卡在哪一步
    try {
      fs.writeFileSync(
        path.join(__dirname, 'smoke-result.json'),
        JSON.stringify({ ok: false, error: String(err && err.message || err), logs }, null, 2),
        'utf8'
      );
    } catch { /* ignore */ }
    app.exit(1);
  }
});
