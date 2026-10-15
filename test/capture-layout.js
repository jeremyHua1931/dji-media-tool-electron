// capture-layout.js —— 生成界面截图，用于人工确认布局（electron test/capture-layout.js）
// ============================================================
// 输出到 test/shots/：
//   layout-detail.png         详细信息 + 预览窗格 + 列表上方的筛选条
//   layout-icons.png          大图标视图
//   layout-drawer.png         选项抽屉（已拖动；只剩素材来源与复制行为）
//   layout-preview-closed.png 关闭预览后列表占满全宽
//   layout-picked.png         点“一键复制”后弹出的保存位置选择（示意图）
//   README-LAYOUT.md          本次截图的尺寸与关键元素核对表

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const { app, BrowserWindow } = require('electron');
const { registerIpc } = require('../src/main/services/ipc');

// ---- 造几张真实渐变 PNG，让缩略图与预览窗格有内容 ----
// 手写 PNG 编码（含 CRC），不依赖任何图片库
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

/**
 * 计算 PNG CRC32 校验值。
 * @param {Buffer} b 数据
 * @returns {number} CRC32 值
 */
const crc32 = (b) => {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i += 1) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/**
 * 构造一个 PNG chunk（长度 + 类型 + 数据 + CRC32）。
 * @param {string} type chunk 类型（如 'IHDR'）
 * @param {Buffer} data chunk 数据
 * @returns {Buffer} chunk 字节
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
 * 生成一张 w x h 的渐变 PNG（seed 不同颜色不同，让多张截图可区分）。
 * @param {number} w 宽度
 * @param {number} h 高度
 * @param {number} seed 颜色种子
 * @returns {Buffer} PNG 文件字节
 */
function makePng(w, h, seed) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y += 1) {
    const row = y * (1 + w * 3);
    for (let x = 0; x < w; x += 1) {
      const p = row + 1 + x * 3;
      raw[p] = (x * 7 + seed * 11) % 256;
      raw[p + 1] = (y * 5 + seed * 17) % 256;
      raw[p + 2] = 230 - ((x + y + seed * 9) % 150);
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dji-shot-'));
const dcim = path.join(root, 'DCIM', '100MEDIA');
fs.mkdirSync(dcim, { recursive: true });
for (let i = 1; i <= 8; i += 1) {
  fs.writeFileSync(path.join(dcim, `DJI_${String(i).padStart(4, '0')}.PNG`), makePng(96, 72, i));
}
for (let i = 1; i <= 3; i += 1) {
  fs.writeFileSync(path.join(dcim, `DJI_0${100 + i}.MP4`), Buffer.alloc(2400 * i, 3));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const outDir = path.join(__dirname, 'shots');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1180, height: 820, show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  registerIpc(() => win);
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await wait(700);
  // 抓渲染进程里被吞掉的异常，避免"界面看着对但其实报错了"
  await win.webContents.executeJavaScript(`(function(){
    window.__errs = [];
    window.addEventListener('error', (e) => window.__errs.push('error: ' + (e.message || e.error)));
    window.addEventListener('unhandledrejection',
      (e) => window.__errs.push('reject: ' + ((e.reason && e.reason.message) || e.reason)));
  })()`);

  // 填来源 + 扫描
  await win.webContents.executeJavaScript(
    `document.getElementById('srcPath').value = ${JSON.stringify(root)};
     document.getElementById('scanBtn').click();`
  );
  await wait(2200);

  fs.mkdirSync(outDir, { recursive: true });
  const checks = {};

  const shot = async (name) => {
    // show:false 的窗口合成帧会滞后，先等两帧再截，否则可能截到上一状态的画面
    await wait(450);
    await win.webContents.executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, `${name}.png`), img.toPNG());
  };

  // 1) 详细信息 + 预览 + 筛选条
  await win.webContents.executeJavaScript(`(function(){
    const rows = Array.from(document.querySelectorAll('#detailBody tr'));
    const t = rows.find((r) => r.dataset.id.indexOf('.PNG') > 0) || rows[0];
    t.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  })()`);
  await wait(300);
  // 等预览图真正取到（预览已插队优先，通常几百毫秒内完成）
  await win.webContents.executeJavaScript(`new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (document.getElementById('pvImage').dataset.blobUrl || Date.now() - t0 > 6000) return resolve(1);
      setTimeout(tick, 100);
    };
    tick();
  })`);
  checks.detail = await win.webContents.executeJavaScript(`(function(){
    const filters = document.querySelector('.filters');
    const list = document.querySelector('.list-wrap');
    const pane = document.getElementById('previewPane');
    return {
      filterBarAboveList: filters.getBoundingClientRect().bottom <= list.getBoundingClientRect().top + 1,
      filterBarInDrawer: !!document.querySelector('#settingsDrawer .filters'),
      typeInDrawer: !!document.querySelector('#settingsDrawer input[name="fType"]'),
      dateInDrawer: !!document.querySelector('#settingsDrawer #dateFrom'),
      destInDrawer: !!document.querySelector('#settingsDrawer #destPath'),
      previewName: document.getElementById('pvName').textContent,
      previewBlob: !!document.getElementById('pvImage').dataset.blobUrl,
      previewEmptyHidden: document.getElementById('previewEmpty').classList.contains('hidden'),
      previewBodyHidden: document.getElementById('previewBody').classList.contains('hidden'),
      selectionSize: (function () {
        const el = document.querySelector('#detailBody tr.selected');
        return el ? 1 : 0;
      })(),
      // 预览窗格的几何：用于确认它确实渲染在可视区域内
      paneRect: (function () {
        const b = pane.getBoundingClientRect();
        return [b.left, b.top, b.width, b.height].map((v) => Math.round(v)).join(',');
      })(),
      pvImageRect: (function () {
        const b = document.getElementById('pvImage').getBoundingClientRect();
        return [b.left, b.top, b.width, b.height].map((v) => Math.round(v)).join(',');
      })(),
      pvNameText: document.getElementById('pvName').textContent,
      errors: (window.__errs || []).slice(),
      resetText: document.getElementById('filterReset').textContent,
      listHeight: Math.round(list.getBoundingClientRect().height),
      // 工具栏在预览占用宽度后不应换行：高度保持单行、按钮同排
      toolbarHeight: Math.round(document.querySelector('.results-bar').getBoundingClientRect().height),
      segButtonsSameRow: (function () {
        const tops = Array.from(document.querySelectorAll('#viewSeg button'))
          .map((b) => Math.round(b.getBoundingClientRect().top));
        return new Set(tops).size === 1;
      })(),
      labelNotWrapped: (function () {
        const b = document.querySelector('.results-bar .label').getBoundingClientRect();
        return b.width >= 24; // 竖排时会被压得很窄
      })(),
      resultsWidth: Math.round(document.querySelector('.results').getBoundingClientRect().width),
      paneWidth: Math.round(pane.getBoundingClientRect().width),
      windowWidth: window.innerWidth,
    };
  })()`);
  await shot('layout-detail');

  // 2) 大图标视图
  await win.webContents.executeJavaScript(
    "document.querySelector('#viewSeg button[data-view=\"icon_large\"]').click();"
  );
  await wait(1500);
  await shot('layout-icons');

  // 3) 选项抽屉：拖动到别处，并确认只剩来源与复制行为
  await win.webContents.executeJavaScript(`(function(){
    document.querySelector('#viewSeg button[data-view="detail"]').click();
    document.getElementById('optionsToggle').click();
    const head = document.getElementById('drawerHead');
    const d = document.getElementById('settingsDrawer');
    const r = d.getBoundingClientRect();
    const o = (x, y) => ({ bubbles: true, cancelable: true, button: 0, pointerId: 1,
      pointerType: 'mouse', isPrimary: true, clientX: x, clientY: y });
    head.dispatchEvent(new PointerEvent('pointerdown', o(r.left + 80, r.top + 12)));
    head.dispatchEvent(new PointerEvent('pointermove', o(r.left - 30, r.top + 110)));
    head.dispatchEvent(new PointerEvent('pointerup', o(r.left - 30, r.top + 110)));
  })()`);
  await wait(500);
  checks.drawer = await win.webContents.executeJavaScript(`(function(){
    const d = document.getElementById('settingsDrawer');
    return {
      visible: !d.classList.contains('hidden'),
      left: Math.round(d.getBoundingClientRect().left),
      top: Math.round(d.getBoundingClientRect().top),
      hasSrc: !!d.querySelector('#srcPath'),
      hasDcimCheck: !!d.querySelector('#dcimOnly'),
      hasCopyOptions: !!d.querySelector('#copyOptionsBtn'),
      saved: !!localStorage.getItem('dji.drawerPos'),
    };
  })()`);
  await shot('layout-drawer');

  // 4) 关闭预览后列表占满全宽
  await win.webContents.executeJavaScript(`(function(){
    document.getElementById('drawerClose').click();
    document.getElementById('previewToggle').click();  // 当前为开 -> 关
  })()`);
  await wait(500);
  checks.previewClosed = await win.webContents.executeJavaScript(`(function(){
    return {
      paneHidden: document.getElementById('previewPane').classList.contains('hidden'),
      resultsWidth: Math.round(document.querySelector('.results').getBoundingClientRect().width),
      toggleText: document.getElementById('previewToggle').textContent,
    };
  })()`);
  await shot('layout-preview-closed');

  // 5) 复制选项弹窗（点「一键复制」后的第一步，居中弹出）
  await win.webContents.executeJavaScript(`(function(){
    document.getElementById('previewToggle').click();  // 恢复预览
    document.getElementById('copyBtn').click();         // 打开复制选项（不会真的复制）
  })()`);
  await wait(400);
  checks.copyModal = await win.webContents.executeJavaScript(`(function(){
    const m = document.getElementById('optionsModal');
    const box = m.querySelector('.modal').getBoundingClientRect();
    return {
      visible: !m.classList.contains('hidden'),
      centeredX: Math.abs((box.left + box.right) / 2 - window.innerWidth / 2) < 40,
      centeredY: Math.abs((box.top + box.bottom) / 2 - window.innerHeight / 2) < 80,
      okText: document.getElementById('optOk').textContent,
      conflictRadios: m.querySelectorAll('input[name="conflict"]').length,
      hasByDate: !!document.getElementById('optByDateModal'),
      hasOnlyNew: !!document.getElementById('optOnlyNewModal'),
      hasVerify: !!document.getElementById('optVerifyModal'),
      hasOpenAfter: !!document.getElementById('optOpenAfterModal'),
    };
  })()`);
  await shot('layout-copy-modal');
  await win.webContents.executeJavaScript("document.getElementById('optCancel').click();");

  // 6) 示意“选择保存位置”（自绘遮挡层，不真开系统对话框）
  await win.webContents.executeJavaScript(`(function(){
    const mask = document.createElement('div');
    mask.id = 'shotMask';
    mask.style.cssText = 'position:fixed;inset:0;background:rgba(16,32,64,.38);z-index:200;'
      + 'display:flex;align-items:center;justify-content:center;';
    mask.innerHTML = '<div style="width:470px;background:#fff;border-radius:10px;'
      + 'border:1px solid #ccd9ee;box-shadow:0 14px 40px rgba(16,40,80,.25);overflow:hidden">'
      + '<div style="padding:12px 16px;border-bottom:1px solid #e2eaf7;font-weight:700;color:#0f4c9c">'
      + '选择保存到的目标文件夹（一键复制会存到这里）</div>'
      + '<div style="padding:14px 16px;font-family:Consolas,monospace;font-size:12px;color:#16233a">'
      + 'D:\\\\照片备份\\\\2026-10-14</div>'
      + '<div style="display:flex;justify-content:flex-end;gap:8px;padding:0 16px 14px">'
      + '<button>取消</button>'
      + '<button style="background:#1668dc;border-color:#1668dc;color:#fff">选择文件夹</button>'
      + '</div></div>';
    document.body.appendChild(mask);
  })()`);
  await wait(300);
  await shot('layout-picked');
  await win.webContents.executeJavaScript("document.getElementById('shotMask').remove();");

  // 核对表落盘，便于人工比对
  const report = [
    '# 布局截图核对表',
    '',
    `生成时间：${new Date().toLocaleString('zh-CN')}`,
    '',
    '| 检查项 | 结果 |',
    '|---|---|',
    `| 筛选条在文件列表上方 | ${checks.detail.filterBarAboveList} |`,
    `| 筛选条不在抽屉里 | ${!checks.detail.filterBarInDrawer} |`,
    `| 文件类型不在抽屉里 | ${!checks.detail.typeInDrawer} |`,
    `| 日期范围不在抽屉里 | ${!checks.detail.dateInDrawer} |`,
    `| “保存到”不在抽屉里 | ${!checks.detail.destInDrawer} |`,
    `| 预览窗格显示选中文件名 | ${checks.detail.previewName} |`,
    `| 预览窗格拿到真实缩略图 | ${checks.detail.previewBlob} |`,
    `| 重置筛选提示 | ${checks.detail.resetText} |`,
    `| 视图工具栏单行不换行（高度 ${checks.detail.toolbarHeight}px） | 按钮同排：${checks.detail.segButtonsSameRow} / “查看”未竖排：${checks.detail.labelNotWrapped} |`,
    `| 结果区高度 | ${checks.detail.listHeight}px |`,
    `| 结果区/预览/窗口 宽度 | ${checks.detail.resultsWidth} / ${checks.detail.paneWidth} / ${checks.detail.windowWidth} |`,
    `| 抽屉可拖动并已记住位置 | ${checks.drawer.saved}（left=${checks.drawer.left}, top=${checks.drawer.top}） |`,
    `| 抽屉只剩来源 + 复制行为 | ${checks.drawer.hasSrc && checks.drawer.hasDcimCheck && checks.drawer.hasCopyOptions} |`,
    `| 复制选项弹窗居中 | ${checks.copyModal.centeredX} / ${checks.copyModal.centeredY}（按钮：${checks.copyModal.okText}） |`,
    `| 复制选项弹窗内容 | 同名 ${checks.copyModal.conflictRadios} 项 / 日期子文件夹 ${checks.copyModal.hasByDate} / 只复制新文件 ${checks.copyModal.hasOnlyNew} / 校验 ${checks.copyModal.hasVerify} / 完成后打开 ${checks.copyModal.hasOpenAfter} |`,
    `| 关闭预览后列表占满全宽 | ${checks.previewClosed.paneHidden} → ${checks.previewClosed.resultsWidth}px |`,
    `| 关闭后按钮文案 | ${checks.previewClosed.toggleText} |`,
    '',
    '截图：layout-detail / layout-icons / layout-drawer / layout-copy-modal / layout-preview-closed / layout-picked',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'README-LAYOUT.md'), report, 'utf8');

  console.log('SHOTS_OK ' + JSON.stringify(checks));
  app.exit(0);
});
