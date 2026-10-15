// renderer.js —— 界面主控：状态、渲染、选择、扫描、复制、交互绑定
// ============================================================
// 只通过 window.api 与主进程通信，不直接访问 Node。
//
// 依赖的兄弟模块（普通脚本，按 index.html 的顺序加载，共享 window.DJI）：
//   app-config.js     常量与视图规格
//   app-utils.js      纯函数工具（formatSize / escapeHtml / 日期解析 / 占位图标）
//   app-thumbnails.js 缩略图队列（D.thumbs）
//   app-preview.js    右侧预览窗格（D.preview）
//
// 本文件负责把这些串起来。凡是能独立成纯逻辑的都尽量挪走了，这里只保留
// 「状态 + 渲染 + 交互」。

'use strict';

const D = window.DJI;
const bridge = window.api;

// ---------------- 状态 ----------------
// 注意：D.state 只挂一次，模块之间共享同一个对象引用（不要整体替换 state）
D.state = D.state || {
  files: [],             // 扫描结果（原始列表）
  view: 'detail',        // detail / icon_large / icon_medium / icon_small
  sortKey: 'mtime',
  sortDir: 'asc',
  selection: new Set(),  // 选中项（以文件路径为唯一 id）
  anchor: null,
  busy: false,
  destPath: '',          // 目标文件夹：点“一键复制”时才弹窗选择
  previewOpen: true,     // 右侧预览窗格是否展开
  copyOptions: {
    conflict: 'skip',
    byDate: false,
    openAfter: true,
    onlyNew: true,       // 默认增量：只复制目标里没有的，重复运行不会翻倍
    verify: true,        // 默认复制后按大小复核
  },
};
const state = D.state;

// ---------------- DOM ----------------
const $ = (id) => document.getElementById(id);
const els = {
  srcPath: $('srcPath'), dcimOnly: $('dcimOnly'),
  dateFrom: $('dateFrom'), dateTo: $('dateTo'),
  scanBtn: $('scanBtn'), copyBtn: $('copyBtn'), cancelBtn: $('cancelBtn'),
  status: $('status'), paramSummary: $('paramSummary'),
  optionsToggle: $('optionsToggle'), drawer: $('settingsDrawer'),
  drawerHead: $('drawerHead'), drawerClose: $('drawerClose'),
  detailView: $('detailView'), detailBody: $('detailBody'),
  iconView: $('iconView'), emptyTip: $('emptyTip'),
  sourceFolderBar: $('sourceFolderBar'), sourceFolderList: $('sourceFolderList'),
  filters: document.querySelector('.filters'),
  filterReset: $('filterReset'),
  refreshBtn: $('refreshBtn'), refreshState: $('refreshState'),
  optOnlyNew: $('optOnlyNew'), optVerify: $('optVerify'),
  cameraNotice: $('cameraNotice'), cameraNoticeText: $('cameraNoticeText'),
  cameraEject: $('cameraEject'), cameraDismiss: $('cameraDismiss'),
  progressFill: $('progressFill'), selInfo: $('selInfo'),
};
D.els = els;

// ---------------- 界面小工具 ----------------
// 用纯文本节点更新元素内容：杜绝 innerHTML 的 XSS 风险，所有动态文案统一走这里
function setText(node, text) { node.replaceChildren(document.createTextNode(text)); }
// 底部状态栏文案
function setStatus(text) { setText(els.status, text); }
// 进度条百分比（自动钳制到 0~100）
function setProgress(pct) {
  els.progressFill.style.width = `${Math.max(0, Math.min(100, pct)).toFixed(1)}%`;
}
// 包装 window.alert：便于自动化测试替换，也统一了错误提示的调用点
function showError(message) {
  const fn = typeof window.alert === 'function' ? window.alert : null;
  if (fn) fn.call(window, message);
}
D.showError = showError;

// ---------------- 排序 / 汇总 ----------------
// 按当前排序键与方向返回排序后的文件列表（不修改原数组）
// 键：name（字典序）/ size / kind（类型字典序）/ 默认 mtime（时间）
function sortedFiles() {
  const { sortKey, sortDir } = state;
  const dir = sortDir === 'asc' ? 1 : -1;
  return [...state.files].sort((a, b) => {
    let r;
    if (sortKey === 'name') r = a.name.localeCompare(b.name);
    else if (sortKey === 'size') r = a.size - b.size;
    else if (sortKey === 'kind') r = a.kind.localeCompare(b.kind);
    else r = new Date(a.mtime) - new Date(b.mtime);
    return r * dir;
  });
}

// 素材实际所在的文件夹统计（复制时最关心的信息）
// 按 f.dir 分组计数，按数量降序、路径字典序升序返回；
// 数量 > D.MAX_FOLDER_ROWS 时界面只展示前几名
function mediaFolders() {
  const map = new Map();
  for (const f of state.files) {
    const dir = f.dir || f.path.slice(0, Math.max(f.path.lastIndexOf('/'), f.path.lastIndexOf('\\')));
    if (!dir) continue;
    const cur = map.get(dir);
    if (cur) cur.count += 1;
    else map.set(dir, { dir, count: 1 });
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.dir.localeCompare(b.dir));
}

// 刷新顶栏参数摘要与「重置筛选」按钮状态：
// 摘要把 来源/类型/日期/DCIM/增量开关/目标/命中数 拼成一行；
// 目标未选时给出"点一键复制时再选"的提示，避免用户误解保存位置
function updateSummary() {
  updateFilterHints();
  const src = els.srcPath.value.trim();
  const type = document.querySelector('input[name="fType"]:checked').value;
  const typeText = type === 'both' ? '照片+视频' : (type === 'photo' ? '仅照片' : '仅视频');
  const from = els.dateFrom.value.trim();
  const to = els.dateTo.value.trim();
  const dateText = (!from && !to) ? '不限日期' : `${from || '最早'} ~ ${to || '最新'}`;
  const base = `${src || '未设置来源'} ｜ ${typeText} ｜ ${dateText}`
    + (els.dcimOnly.checked ? ' ｜ 仅 DCIM' : '')
    + (state.copyOptions.onlyNew ? ' ｜ 只复制新文件' : '');
  const destText = state.destPath ? ` ｜ 存到 ${state.destPath}` : ' ｜ 目标未选（点“一键复制”时再选）';
  els.paramSummary.textContent = (state.files.length
    ? `${base} ｜ 命中 ${state.files.length} 个文件`
    : base) + destText;
  els.paramSummary.title = base + destText;
}

// 「重置筛选」只在确实有条件生效时才是可点状态：统计类型与日期两项，
// 没有生效条件时置灰并禁用点击（避免"重置一个没改过的筛选"）
function updateFilterHints() {
  const type = document.querySelector('input[name="fType"]:checked').value;
  const hasDate = !!(els.dateFrom.value.trim() || els.dateTo.value.trim());
  const active = (type !== 'both' ? 1 : 0) + (hasDate ? 1 : 0);
  if (!els.filterReset) return;
  els.filterReset.textContent = active ? `重置筛选（${active} 项生效）` : '重置筛选';
  els.filterReset.style.opacity = active ? '1' : '.45';
  els.filterReset.style.cursor = active ? 'pointer' : 'default';
}

// ---------------- 素材文件夹栏 ----------------
// 扫描有结果时展示"素材实际所在文件夹 + 文件数 + 打开按钮"；
// 没有结果则整栏隐藏。文件夹超过 D.MAX_FOLDER_ROWS 个时追加一行"另有 N 个"
function renderSourceFolders() {
  const list = els.sourceFolderList;
  if (!state.files.length) {
    els.sourceFolderBar.classList.add('hidden');
    return;
  }
  els.sourceFolderBar.classList.remove('hidden');

  const wrap = document.createElement('div');
  wrap.className = 'sf-list';
  const folders = mediaFolders();
  for (const item of folders.slice(0, D.MAX_FOLDER_ROWS)) {
    const row = document.createElement('div');
    row.className = 'sf-item';

    const p = document.createElement('span');
    p.className = 'sf-path';
    p.textContent = item.dir;
    p.title = item.dir;

    const c = document.createElement('span');
    c.className = 'sf-count';
    c.textContent = `${item.count} 个文件`;

    const open = document.createElement('button');
    open.className = 'sf-open';
    open.type = 'button';
    open.textContent = '打开文件夹';
    open.addEventListener('click', async () => {
      const err = await bridge.openPath(item.dir);
      if (err) showError('无法打开文件夹：\n' + err);
    });

    row.append(p, c, open);
    wrap.append(row);
  }
  if (folders.length > D.MAX_FOLDER_ROWS) {
    const more = document.createElement('div');
    more.className = 'sf-more';
    more.textContent = `另有 ${folders.length - D.MAX_FOLDER_ROWS} 个文件夹（共 ${folders.length} 个）`;
    wrap.append(more);
  }
  list.replaceChildren(wrap);
}

// ---------------- 相机保护提示 ----------------
// 检测到来源是相机/存储卡时，明确告诉用户「本工具只读」并提醒安全弹出；
// 没有检测到相机则隐藏整条提示
function renderCameraNotice(cams) {
  if (!els.cameraNotice) return;
  if (!cams || !cams.length) {
    els.cameraNotice.classList.add('hidden');
    return;
  }
  const cam = cams[0];
  const name = cam.name && cam.name !== cam.root ? `${cam.name}（${cam.root}）` : cam.root;
  setText(els.cameraNoticeText,
    `已识别到相机/存储卡：${name}。本工具全程只读，不会删除或修改相机里的任何文件；`
    + '复制完成后请用系统「安全弹出」再拔线。');
  els.cameraNotice.classList.remove('hidden');
}

// ---------------- 渲染 ----------------
// 全量重绘：根据当前视图（详情表格 / 图标网格）重建列表 DOM，
// 并同步：空提示、视图分段按钮激活态、表头排序箭头、素材文件夹栏、
// 选中态、参数摘要、预览窗格，最后把可见缩略图交给队列异步加载。
// 注意：重绘会重建所有 img，因此缩略图模块必须负责新旧 Blob URL 的回收
function render() {
  const list = sortedFiles();
  const isDetail = state.view === 'detail';
  els.detailView.classList.toggle('hidden', !isDetail);
  els.iconView.classList.toggle('hidden', isDetail);
  els.emptyTip.style.display = state.files.length ? 'none' : 'flex';

  document.querySelectorAll('#viewSeg button').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === state.view);
  });
  // 表头排序箭头（只更新箭头，不重建表头）
  document.querySelectorAll('.detail-view th').forEach((th) => {
    const arrow = th.querySelector('.arrow');
    if (arrow) arrow.textContent = th.dataset.key === state.sortKey
      ? (state.sortDir === 'asc' ? ' ▲' : ' ▼') : '';
  });

  if (isDetail) {
    els.detailBody.innerHTML = list.map((f) => `
      <tr data-id="${D.escapeHtml(f.path)}">
        <td><div class="file-name">
          <img class="mini" data-thumb="${D.escapeHtml(f.path)}"
               data-kind="${f.kind}" src="${D.placeholderSVG(f.kind, D.ICON_SPEC.detail.thumb)}" />
          <span>${D.escapeHtml(f.name)}</span>
        </div></td>
        <td>${D.fmtTime(f.mtime)}</td>
        <td class="center"><span class="${D.kindClass(f.kind)}">${D.kindLabel(f.kind)}</span></td>
        <td class="right">${D.formatSize(f.size)}</td>
      </tr>`).join('');
  } else {
    const spec = D.ICON_SPEC[state.view] || D.ICON_SPEC.icon_medium;
    els.iconView.style.gridTemplateColumns =
      `repeat(auto-fill, minmax(${spec.cellW}px, 1fr))`;
    els.iconView.innerHTML = list.map((f) => `
      <div class="icon-cell" data-id="${D.escapeHtml(f.path)}"
           style="height:${spec.cellH}px">
        <div class="thumb">
          <img data-thumb="${D.escapeHtml(f.path)}" data-kind="${f.kind}"
               width="${spec.thumb}" height="${spec.thumb}"
               src="${D.placeholderSVG(f.kind, spec.thumb)}" />
        </div>
        <div class="cap">${D.escapeHtml(f.name)}</div>
      </div>`).join('');
  }

  renderSourceFolders();
  applySelectionVisual();
  updateSummary();
  D.preview.render();
  loadVisibleThumbnails();
}

// 把当前 DOM 里的图交给缩略图队列（预览图会插队优先）。
// 每次渲染 / 点选后调用，只有"未取到真图的 img"才会被真正入队
function loadVisibleThumbnails() {
  const spec = D.ICON_SPEC[state.view] || D.ICON_SPEC.detail;
  D.thumbs.enqueue({
    imgs: Array.from(document.querySelectorAll('img[data-thumb]')),
    previewImg: D.previewEls.image,
    spec,
  });
}

// 把选中态反映到 DOM（选中行/格高亮），并更新底部"已选 N 项"文案。
// 未选中时提示"复制时只复制选中项；未选则复制全部"
function applySelectionVisual() {
  document.querySelectorAll('[data-id]').forEach((el) => {
    el.classList.toggle('selected', state.selection.has(el.dataset.id));
  });
  const n = state.selection.size;
  els.selInfo.textContent = n > 0
    ? `已选 ${n} 项（复制时只复制选中项；未选则复制全部）` : '';
}

// ---------------- 选择 ----------------
// 列表点击事件（事件委托到 .list-wrap）：
//   - 点空白处：取消全部选中（符合资源管理器习惯，也方便"未选 = 复制全部"）；
//   - Ctrl/Meta 点击：切换单项选中并更新锚点；
//   - Shift 点击：从锚点连续选中到当前项（按当前排序顺序）；
//   - 普通点击：单选并更新锚点。
// 选中变化后除了刷新视觉，还要重新入队缩略图——否则单击选中时
// 预览图会一直停在占位图标（只在整表重绘时排队的话）
function onListClick(e) {
  const el = e.target.closest('[data-id]');
  if (!el) {
    // 点列表空白处 = 取消选中（符合资源管理器习惯，也方便"未选=复制全部"）
    if (e.target.closest('.list-wrap') && state.selection.size) {
      state.selection = new Set();
      state.anchor = null;
      applySelectionVisual();
      D.preview.render();
    }
    return;
  }
  const id = el.dataset.id;
  const order = sortedFiles().map((f) => f.path);

  if (e.ctrlKey || e.metaKey) {
    if (state.selection.has(id)) state.selection.delete(id);
    else state.selection.add(id);
    state.anchor = id;
  } else if (e.shiftKey && state.anchor) {
    const a = order.indexOf(state.anchor);
    const b = order.indexOf(id);
    if (a < 0 || b < 0) {
      state.selection = new Set([id]);
    } else {
      const [lo, hi] = [Math.min(a, b), Math.max(a, b)];
      state.selection = new Set(order.slice(lo, hi + 1));
    }
  } else {
    state.selection = new Set([id]);
    state.anchor = id;
  }
  applySelectionVisual();
  D.preview.render();
  // 预览图也要取缩略图：只在整表重绘时排队的话，单击选中会一直停在占位图
  loadVisibleThumbnails();
}

// 双击行/格：用系统默认应用打开该文件
function onListDoubleClick(e) {
  const el = e.target.closest('[data-id]');
  if (!el) return;
  openPath(el.dataset.id);
}

// 调用系统默认应用打开文件，失败时弹窗提示
async function openPath(p) {
  const err = await bridge.openPath(p);
  if (err) showError('无法用系统默认应用打开：\n' + err);
}

// Ctrl+A 全选（输入框聚焦时不拦截系统行为）
function selectAll() {
  state.selection = new Set(state.files.map((f) => f.path));
  state.anchor = state.files[0] ? state.files[0].path : null;
  applySelectionVisual();
  D.preview.render();
  loadVisibleThumbnails();
}

// ---------------- 选项抽屉（可拖动、可收起） ----------------
// 展开/收起抽屉：同步按钮文案与 aria 状态；
// 首次显示时才居中（此时才量得到真实尺寸）；
// 收起抽屉视为一次"操作结束"，顺手在 250ms 后自动刷新结果
function setDrawer(open) {
  const wasOpen = !els.drawer.classList.contains('hidden');
  els.drawer.classList.toggle('hidden', !open);
  els.drawer.setAttribute('aria-hidden', open ? 'false' : 'true');
  els.optionsToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  els.optionsToggle.textContent = open ? '收起选项' : '显示选项';
  // 首次显示时把抽屉放到屏幕中央（此时才量得到真实尺寸）
  if (open && !wasOpen && D.centerDrawerIfNeeded) D.centerDrawerIfNeeded();
  // 收起抽屉 = 一次"操作结束"，顺手刷新一下结果
  if (wasOpen && !open) scheduleRefresh(250);
}

(function makeDrawerDraggable() {
  const KEY = 'dji.drawerPos';
  const win = els.drawer.ownerDocument.defaultView;

  const applyPos = (left, top) => {
    const maxLeft = Math.max(0, win.innerWidth - els.drawer.offsetWidth);
    const maxTop = Math.max(0, win.innerHeight - els.drawer.offsetHeight);
    els.drawer.style.left = `${Math.min(Math.max(0, left), maxLeft)}px`;
    els.drawer.style.top = `${Math.min(Math.max(0, top), maxTop)}px`;
    els.drawer.style.right = 'auto';
  };
  const clampCurrent = () => {
    if (els.drawer.style.left) {
      applyPos(parseFloat(els.drawer.style.left), parseFloat(els.drawer.style.top));
    }
  };

  let needCenter = false;
  try {
    const saved = JSON.parse(win.localStorage.getItem(KEY) || 'null');
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
      applyPos(saved.left, saved.top);
    } else {
      // 没有存档 -> 首次显示时居中。注意不能在隐藏状态算尺寸（offsetWidth 是 0，
      // 会把抽屉放到屏幕外），所以留到 setDrawer 真正显示后再算。
      needCenter = true;
    }
  } catch { /* 存档损坏就忽略 */ }

  function centerIfNeeded() {
    if (!needCenter) return;
    needCenter = false;
    applyPos((win.innerWidth - els.drawer.offsetWidth) / 2,
      (win.innerHeight - els.drawer.offsetHeight) / 2);
  }

  let dragging = null;
  els.drawerHead.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return; // 按钮照常点击
    const rect = els.drawer.getBoundingClientRect();
    dragging = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    els.drawer.classList.add('dragging');
    try { els.drawerHead.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    e.preventDefault();
  });
  els.drawerHead.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    applyPos(e.clientX - dragging.dx, e.clientY - dragging.dy);
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = null;
    els.drawer.classList.remove('dragging');
    try {
      win.localStorage.setItem(KEY, JSON.stringify({
        left: parseFloat(els.drawer.style.left) || 0,
        top: parseFloat(els.drawer.style.top) || 0,
      }));
    } catch { /* 隐私模式可能不可写 */ }
  };
  els.drawerHead.addEventListener('pointerup', endDrag);
  els.drawerHead.addEventListener('pointercancel', endDrag);
  win.addEventListener('resize', clampCurrent);
  D.centerDrawerIfNeeded = centerIfNeeded;
}());

// ---------------- 事件绑定 ----------------
els.optionsToggle.addEventListener('click', () => {
  setDrawer(els.drawer.classList.contains('hidden'));
});
els.drawerClose.addEventListener('click', () => setDrawer(false));

$('srcBrowse').addEventListener('click', async () => {
  const p = await bridge.pickFolder('选择素材所在文件夹（相机盘符 / DCIM / 任意文件夹）');
  if (p) {
    els.srcPath.value = p;
    updateSummary();
    scheduleRefresh(200); // 换来源 -> 自动重新扫描
  }
});

$('srcAuto').addEventListener('click', async () => {
  setStatus('正在检测相机 / 读卡器…');
  let info = null;
  let cams = [];
  try {
    info = await bridge.suggestMediaRoot();
    cams = await bridge.detectCameras();
  } catch (err) {
    setStatus('检测设备失败：' + err);
    return;
  }

  if (!cams.length && !info) {
    setStatus('未检测到相机 / 读卡器。');
    showError('没有检测到相机/读卡器。\n\n请确认：\n'
      + '1. 相机已通过 USB-C 连接电脑，并在相机屏幕上选择“文件传输：USB”；\n'
      + '2. 读卡器/SD 卡已插入。\n也可以直接点“浏览…”手动选择。');
    return;
  }

  renderCameraNotice(cams);
  if (info && info.root) {
    els.srcPath.value = info.root;
    updateSummary();
    renderCameraNotice(cams);
    setStatus(`已检测到素材目录：${info.root}`
      + (info.fileCount ? `（${info.fileCount} 个素材）` : '（未识别到素材）')
      + '，正在刷新…');
    scheduleRefresh(150);
    return;
  }

  els.srcPath.value = cams[0].root;
  updateSummary();
  setStatus(cams.length === 1
    ? `已检测到相机：${cams[0].name}`
    : `检测到 ${cams.length} 个可移动设备，已填入第一个。`);
  scheduleRefresh(150);
});

if (els.cameraDismiss) {
  els.cameraDismiss.addEventListener('click', () => els.cameraNotice.classList.add('hidden'));
}
if (els.cameraEject) {
  els.cameraEject.addEventListener('click', () => {
    // 不代跑 diskpart/eject 等命令：只读原则同样适用于系统层，交给系统面板最稳
    showError('请用系统「安全弹出」再拔线：\n'
      + 'Windows：任务栏右下角「安全删除硬件并弹出媒体」→ 选择相机；\n'
      + 'macOS：访达侧边栏相机旁的 ⏏ 按钮。\n\n'
      + '复制完成后本工具不会再访问相机，安全弹出不会失败。');
  });
}

// 参数一改就刷新摘要；筛选条上的任何改动还会自动触发重新扫描
['input', 'change'].forEach((evt) => {
  els.drawer.addEventListener(evt, () => {
    updateSummary();
    if (evt === 'change' || evt === 'input') scheduleRefresh();
  });
  if (els.filters) {
    els.filters.addEventListener(evt, () => {
      updateSummary();
      scheduleRefresh();
    });
  }
});
if (els.filterReset) {
  els.filterReset.addEventListener('click', () => {
    els.dateFrom.value = '';
    els.dateTo.value = '';
    const both = document.querySelector('input[name="fType"][value="both"]');
    if (both) both.checked = true;
    updateSummary();
    scheduleRefresh(300);
  });
}

// 时间快捷档：今天 / 一天 / 三天 / 七天 / 不限（滚动窗口，含今天）
// 返回 [起始 Date, 结束 Date]，两端均为 null 表示不限；
// 起始统一对齐到今天 00:00:00，避免"最近一天"随时间流逝漂移
function quickRange(key) {
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (key === 'today') return [startOfToday, today];
  if (key === 'clear') return [null, null];
  const days = Number(key);
  if (!Number.isFinite(days) || days < 1) return [null, null];
  const from = new Date(startOfToday.getTime() - (days - 1) * 86400000);
  return [from, today];
}

// 把快捷档结果写入日期输入框，并触发自动重扫（改时间 -> 自动重新扫描）
function setDate(d1, d2) {
  if (!d1 || !d2) {
    els.dateFrom.value = '';
    els.dateTo.value = '';
  } else {
    els.dateFrom.value = D.toDateInput(d1);
    els.dateTo.value = D.toDateInput(d2);
  }
  updateSummary();
  scheduleRefresh(); // 改时间 -> 自动重新扫描
}
document.querySelectorAll('[data-quick]').forEach((b) => {
  b.addEventListener('click', () => {
    const [d1, d2] = quickRange(b.dataset.quick);
    setDate(d1, d2);
  });
});

// 视图切换
document.querySelectorAll('#viewSeg button').forEach((b) => {
  b.addEventListener('click', () => {
    state.view = b.dataset.view;
    D.thumbs.clear(); // 尺寸变了，作废未处理的旧任务
    render();
  });
});

// 表头排序
document.querySelectorAll('.detail-view th').forEach((th) => {
  th.addEventListener('click', () => {
    const key = th.dataset.key;
    if (state.sortKey === key) {
      state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      state.sortKey = key;
      state.sortDir = key === 'size' ? 'desc' : 'asc';
    }
    render();
  });
});

// 列表事件委托 + 快捷键
document.querySelector('.list-wrap').addEventListener('click', onListClick);
document.querySelector('.list-wrap').addEventListener('dblclick', onListDoubleClick);
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    if (state.files.length
        && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
      e.preventDefault();
      selectAll();
    }
  }
  if (e.key === 'Escape') {
    setDrawer(false);
    $('optionsModal').classList.add('hidden');
  }
});

// ---------------- 复制选项弹窗（返回 Promise<boolean>：确认 / 取消） ----------------
// 注意：弹窗里的开关用 *Modal 后缀，与筛选条上的同名开关区分开，
// 避免 getElementById 拿到同一个元素导致两处联动失效。
const modal = $('optionsModal');
let modalResolve = null;

function fillOptionsModal() {
  modal.querySelector(`input[name="conflict"][value="${state.copyOptions.conflict}"]`).checked = true;
  $('optByDateModal').checked = state.copyOptions.byDate;
  $('optOpenAfterModal').checked = state.copyOptions.openAfter;
  $('optOnlyNewModal').checked = state.copyOptions.onlyNew;
  $('optVerifyModal').checked = state.copyOptions.verify;
}

function closeOptionsModal(result) {
  modal.classList.add('hidden');
  const resolve = modalResolve;
  modalResolve = null;
  if (resolve) resolve(result);
}

/** 打开"复制选项"弹窗，等用户点确认/取消 */
function askCopyOptions() {
  fillOptionsModal();
  modal.classList.remove('hidden');
  return new Promise((resolve) => { modalResolve = resolve; });
}

// 从弹窗读回设置并同步筛选条上的快捷开关
function readOptionsFromModal() {
  state.copyOptions.conflict = modal.querySelector('input[name="conflict"]:checked').value;
  state.copyOptions.byDate = $('optByDateModal').checked;
  state.copyOptions.openAfter = $('optOpenAfterModal').checked;
  state.copyOptions.onlyNew = $('optOnlyNewModal').checked;
  state.copyOptions.verify = $('optVerifyModal').checked;
  if (els.optOnlyNew) els.optOnlyNew.checked = state.copyOptions.onlyNew;
  if (els.optVerify) els.optVerify.checked = state.copyOptions.verify;
  updateSummary();
}

// 抽屉里的「复制选项…」：只改设置，不触发复制流程
$('copyOptionsBtn').addEventListener('click', async () => {
  if (await askCopyOptions()) readOptionsFromModal();
});
$('optCancel').addEventListener('click', () => closeOptionsModal(false));
modal.addEventListener('click', (e) => { if (e.target === modal) closeOptionsModal(false); });
$('optOk').addEventListener('click', () => {
  readOptionsFromModal();
  closeOptionsModal(true);
});

// 筛选条上的同步开关（改一处，另一处跟着变）
if (els.optOnlyNew) {
  els.optOnlyNew.addEventListener('change', () => {
    state.copyOptions.onlyNew = els.optOnlyNew.checked;
    updateSummary();
  });
}
if (els.optVerify) {
  els.optVerify.addEventListener('change', () => {
    state.copyOptions.verify = els.optVerify.checked;
  });
}

// ---------------- 忙碌状态 ----------------
function setBusy(busy) {
  state.busy = busy;
  els.scanBtn.disabled = busy;
  els.copyBtn.disabled = busy;
  els.cancelBtn.disabled = !busy;
}

// ---------------- 扫描 ----------------
// 把当前扫描条件算成一个签名（来源/起止日期/类型/DCIM 开关）：
// 签名不变就不重复扫描，避免条件没变还反复扫
function scanSignature() {
  const type = document.querySelector('input[name="fType"]:checked').value;
  return [
    els.srcPath.value.trim(),
    els.dateFrom.value.trim(),
    els.dateTo.value.trim(),
    type,
    els.dcimOnly.checked ? '1' : '0',
  ].join('\u0001');
}

let lastScanSignature = null;
let refreshTimer = null;
let autoScanEnabled = true; // 启动自动扫描期间先关掉"自动刷新"，避免自己触发自己

// 更新筛选条尾部的刷新状态文案（"扫描中…" / "已刷新 · N 个" / "条件已变…"）
function setRefreshState(text) {
  if (els.refreshState) setText(els.refreshState, text || '');
}

/**
 * 执行一次扫描（核心入口）。
 * 校验顺序：忙碌状态 → 来源非空 → 日期格式合法 → 起止不颠倒；
 * 通过后把条件组装成 payload 交给主进程 scan，成功后更新状态、清空选中、
 * 丢弃旧缩略图队列并整体重绘。
 * @param {object} opt { auto: 是否由条件变化自动触发, silent: 不弹错误框 }
 * @returns {Promise<boolean>} 是否扫描成功
 */
async function runScan(opt) {
  const { auto = false, silent = false } = opt || {};
  if (state.busy) return false;

  const root = els.srcPath.value.trim();
  if (!root) {
    if (!auto) { setDrawer(true); showError('请先选择有效的素材来源文件夹。'); }
    return false;
  }

  const start = D.parseDateInput(els.dateFrom.value, false);
  const end = D.parseDateInput(els.dateTo.value, true);
  if (start === undefined || end === undefined) {
    setRefreshState('日期格式不对');
    if (!silent) showError('日期格式不对，请用 YYYY-MM-DD 或 YYYY-MM-DD HH:MM');
    return false;
  }
  if (start && end && start > end) {
    setRefreshState('起止日期颠倒');
    if (!silent) showError('起始日期不能晚于结束日期。');
    return false;
  }

  const type = document.querySelector('input[name="fType"]:checked').value;
  const payload = {
    root,
    startISO: start ? start.toISOString() : null,
    endISO: end ? end.toISOString() : null,
    wantPhoto: type === 'both' || type === 'photo',
    wantVideo: type === 'both' || type === 'video',
    dcimOnly: els.dcimOnly.checked,
  };

  const signature = scanSignature();
  setBusy(true);
  if (!auto) setDrawer(false); // 手动扫描时顺手收起抽屉，把整屏留给结果
  setProgress(0);
  setRefreshState('扫描中…');
  setStatus(`正在扫描 ${root} …`);
  try {
    const files = await bridge.scan(payload);
    state.files = files;
    state.selection = new Set();
    state.anchor = null;
    D.thumbs.clear();
    lastScanSignature = signature;
    render();
    const total = files.reduce((s, f) => s + f.size, 0);
    if (files.length) {
      setStatus(`找到 ${files.length} 个文件，共 ${D.formatSize(total)}，`
        + `分布在 ${mediaFolders().length} 个文件夹。检查无误后点“一键复制”。`);
    } else {
      setStatus('没有找到符合条件的文件。试试放宽时间范围或文件类型。');
    }
    setRefreshState(files.length ? `已刷新 · ${files.length} 个` : '已刷新 · 无匹配');
    return true;
  } catch (err) {
    setRefreshState('刷新失败');
    setStatus('扫描出错：' + err);
    if (!silent) showError('扫描失败：\n' + err);
    return false;
  } finally {
    setBusy(false);
  }
}

// 条件变化后的自动刷新：650ms 合并窗口内多次改动只触发一次扫描
// （改时间 / 改类型 / 换来源 / 收起抽屉都会调用）；若签名没变或来源为空则跳过；
// 扫描进行中则延迟到结束后再补一次
function scheduleRefresh(delay) {
  if (!autoScanEnabled) return;
  if (refreshTimer) clearTimeout(refreshTimer);
  setRefreshState('条件已变，准备刷新…');
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    if (state.busy) { scheduleRefresh(400); return; }
    if (!els.srcPath.value.trim()) { setRefreshState(''); return; }
    if (scanSignature() === lastScanSignature) { setRefreshState(''); return; }
    runScan({ auto: true, silent: true });
  }, typeof delay === 'number' ? delay : 650);
}

$('scanBtn').addEventListener('click', () => runScan({ auto: false }));
if ($('refreshBtn')) {
  $('refreshBtn').addEventListener('click', () => runScan({ auto: true, silent: false }));
}

// ---------------- 复制 ----------------
// 弹出系统文件夹选择框选目标，记住到 state.destPath 并刷新摘要；
// 取消返回 null
async function pickDestination() {
  const p = await bridge.pickFolder('选择保存到的目标文件夹（一键复制会存到这里）');
  if (!p) return null;
  state.destPath = p;
  updateSummary();
  return p;
}

// 复制前预检：目标不能落在源盘 / 源目录内，且目标盘空间要够。
// 主进程 preflight 返回 { ok, code, message }，不过则展示原因并阻止复制
async function preflightCopy(dest, chosen) {
  const totalBytes = chosen.reduce((s, f) => s + (f.size || 0), 0);
  let gate = null;
  try {
    gate = await bridge.preflightCopy({
      dest,
      sourceRoot: els.srcPath.value.trim(),
      totalBytes,
      fileCount: chosen.length,
    });
  } catch (err) {
    gate = { ok: false, message: String(err) };
  }
  if (!gate || !gate.ok) {
    const msg = (gate && gate.message) || '复制前检查未通过。';
    setStatus('已阻止：' + (gate && gate.code ? gate.code : 'preflight'));
    showError('无法开始复制：\n\n' + msg);
    return false;
  }
  return true;
}

let offProgress = null; // 常驻订阅，避免每次点击叠加监听器
offProgress = bridge.onCopyProgress((info) => {
  if (!state.busy) return; // 已结束的任务不再动界面
  setProgress(info.totalBytes ? (info.doneBytes / info.totalBytes) * 100 : 0);
  setStatus(`处理中 ${info.idx}/${info.total}：${info.name}`);
});

$('copyBtn').addEventListener('click', async () => {
  if (!state.files.length) { showError('还没有匹配结果，请先点“扫描匹配文件”。'); return; }

  const chosen = state.selection.size
    ? state.files.filter((f) => state.selection.has(f.path))
    : state.files;

  // 第 1 步：先弹「复制选项」，确认后再选保存位置（取消则整条流程中止）
  if (!await askCopyOptions()) {
    setStatus('已取消复制（未确认复制选项）。');
    return;
  }

  // 第 2 步：选择保存位置
  const dest = await pickDestination();
  if (!dest) {
    setStatus('已取消：未选择保存目标文件夹。');
    return;
  }
  // 第 3 步：只读保证 + 空间预检
  if (!await preflightCopy(dest, chosen)) return;

  const { conflict, byDate, onlyNew, verify } = state.copyOptions;
  setBusy(true);
  setProgress(0);
  setStatus(`开始复制 ${chosen.length} 个文件到 ${dest} …`);

  try {
    const s = await bridge.startCopy({
      files: chosen, dest, byDate, onConflict: conflict, onlyNew, verify,
      sourceRoot: els.srcPath.value.trim(),
    });
    if (!s.cancelled) setProgress(100);

    const parts = [`成功 ${s.copied} 个`];
    if (s.alreadyExists) parts.push(`已存在跳过 ${s.alreadyExists} 个`);
    if (s.skipped) parts.push(`撞名跳过 ${s.skipped} 个`);
    if (s.renamed) parts.push(`自动改名 ${s.renamed} 个`);
    if (verify) parts.push(`校验通过 ${s.verified} 个`);
    if (s.failed.length) parts.push(`失败 ${s.failed.length} 个`);
    const msg = `复制完成：${parts.join('，')}`
      + (s.cancelled ? '（已取消）' : '')
      + (s.bytesCopied ? `，共写入 ${D.formatSize(s.bytesCopied)}` : '');
    setStatus(msg);

    if (state.copyOptions.openAfter && s.copied) {
      await bridge.openPath(dest);
    }
    if (s.failed.length) {
      showError(msg + '\n\n失败明细（前 10 条）：\n'
        + s.failed.slice(0, 10).map((x) => `- ${x.name}: ${x.error}`).join('\n'));
    } else if (!s.cancelled) {
      showError(msg + (s.alreadyExists === chosen.length
        ? '\n\n（所有文件此前都已复制过，没有重复写入）' : ''));
    }
    // 增量/跳过情形下刷新一下提示，避免用户以为"没反应"
    if (s.copied === 0 && s.alreadyExists > 0) {
      setStatus(`${msg}——若想重新复制，可取消“只复制新文件”。`);
    }
  } catch (err) {
    setStatus('复制出错：' + err);
    showError('复制失败：\n' + err);
  } finally {
    setBusy(false);
  }
});

$('cancelBtn').addEventListener('click', async () => {
  await bridge.cancelCopy();
  setStatus('正在取消…');
});

// ---------------- 启动 ----------------
// 流程：读配置 -> 默认「最近一天」 -> 自动检测相机并填来源 -> 自动扫描一次
(async function init() {
  try {
    const cfg = await bridge.readConfig();
    if (cfg && cfg.THUMB_SIZES) D.ICON_SPEC = cfg.THUMB_SIZES;
  } catch { /* 用内置兜底尺寸 */ }

  if (els.optOnlyNew) els.optOnlyNew.checked = state.copyOptions.onlyNew;
  if (els.optVerify) els.optVerify.checked = state.copyOptions.verify;

  // 默认时间范围：最近一天（昨天 00:00:00 ~ 今天 23:59:59）
  const [d1, d2] = quickRange('1');
  els.dateFrom.value = D.toDateInput(d1);
  els.dateTo.value = D.toDateInput(d2);

  updateSummary();
  render();
  setDrawer(false);

  // 自动检测相机：直接给出到素材子文件夹（如 F:\DCIM\DJI_001），并自动扫描一次
  try {
    const info = await bridge.suggestMediaRoot();
    if (info && info.root) {
      if (!els.srcPath.value.trim()) els.srcPath.value = info.root;
      updateSummary();
      try {
        renderCameraNotice(await bridge.detectCameras());
      } catch { /* 只读提示拿不到就算了 */ }
      const hint = info.fileCount
        ? `${info.root}（该文件夹内 ${info.fileCount} 个素材）`
        : `${info.root}（未识别到素材，可放宽时间范围）`;
      setStatus(`已自动检测到相机素材：${hint}，正在自动扫描最近一天…`);
    } else {
      setStatus('未检测到相机 / 存储卡。可点「自动检测」或「浏览…」手动选择素材来源。');
    }
  } catch { /* 检测失败不影响手动选择 */ }

  // 自动刷新一次（条件已就绪就扫）
  autoScanEnabled = true;
  if (els.srcPath.value.trim()) {
    await runScan({ auto: true, silent: true });
  }
}());
