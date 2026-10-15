// app-preview.js —— 右侧预览窗格（类似资源管理器）
// ============================================================
// 职责：
//   - 随选中项更新：缩略图 + 名称 + 类型 + 拍摄时间 + 大小 + 完整路径
//   - 多选时只做汇总（数量 / 总体积 / 照片视频构成），不显示单文件详情
//   - 可关闭 / 重开，并提供「打开文件」「在文件夹中显示」

'use strict';

(function () {
  const D = window.DJI;
  const $ = (id) => document.getElementById(id);

  const els = {
    panes: $('panes'),
    pane: $('previewPane'),
    toggle: $('previewToggle'),
    close: $('previewClose'),
    empty: $('previewEmpty'),
    body: $('previewBody'),
    image: $('pvImage'),
    badge: $('pvBadge'),
    name: $('pvName'),
    kind: $('pvKind'),
    time: $('pvTime'),
    size: $('pvSize'),
    path: $('pvPath'),
    open: $('pvOpen'),
    reveal: $('pvReveal'),
  };
  D.previewEls = els;

  // 用纯文本节点替换元素内容：相比 innerHTML 更安全（文本不会被当 HTML 解析），
  // 也避免了 XSS 风险。本文件所有动态文案都走这里
  function setText(node, text) { node.replaceChildren(document.createTextNode(text)); }

  // 单选时返回那个文件；多选 / 未选返回 null
  // 选中集以文件路径为 id（state.selection: Set<string>）
  function primarySelection() {
    const { state } = D;
    if (!state || state.selection.size !== 1) return null;
    const [id] = state.selection;
    return state.files.find((f) => f.path === id) || null;
  }

  // 展开 / 收起预览窗格：切换 panes 上的 preview-off 类让结果区拿满宽度，
  // 同步顶栏"预览"按钮的激活态；展开时立即重绘一次
  function setOpen(open) {
    const { state } = D;
    state.previewOpen = open;
    els.panes.classList.toggle('preview-off', !open);
    els.pane.classList.toggle('hidden', !open);
    els.toggle.classList.toggle('active', open);
    els.toggle.textContent = open ? '预览' : '显示预览';
    if (open) render();
  }

  // 渲染预览窗格内容：
  //   - 未选中：提示文案（区分"还没有结果"与"选中一个文件以查看预览"）；
  //   - 多选：只汇总数量 / 总体积 / 照片视频构成；
  //   - 单选：先上占位图标，真实缩略图由缩略图队列异步替换（插队优先）；
  //   单选时用 data-thumb / data-loaded / data-loadedFrom 标记当前文件与尺寸，
  //   只有三者与最新选中不一致才重新入队，避免反复请求同一张图
  function render() {
    const { state, thumbs } = D;
    if (!state.previewOpen) return;

    const f = primarySelection();
    const total = state.selection.size;
    const selected = f ? [f] : state.files.filter((x) => state.selection.has(x.path));

    if (!f && selected.length === 0) {
      setText(els.empty, state.files.length ? '选中一个文件以查看预览' : '扫描后选中文件即可预览');
      els.empty.classList.remove('hidden');
      els.body.classList.add('hidden');
      releaseImage();
      return;
    }

    els.empty.classList.add('hidden');
    els.body.classList.remove('hidden');

    // 多选：只汇总
    if (!f) {
      const bytes = selected.reduce((s, x) => s + (x.size || 0), 0);
      const photos = selected.filter((x) => x.kind === 'photo').length;
      releaseImage();
      els.image.dataset.thumb = '';
      els.image.dataset.loaded = '';
      els.image.removeAttribute('src');
      setText(els.badge, '多选');
      setText(els.name, `已选中 ${total} 个文件`);
      setText(els.kind, `${photos} 个照片 / ${total - photos} 个视频`);
      setText(els.time, '—');
      setText(els.size, D.formatSize(bytes));
      setText(els.path, '多选时不显示路径');
      return;
    }

    // 单选：先上占位图，真实缩略图由缩略图队列异步替换
    const size = D.PREVIEW_THUMB_SIZE;
    const changed = els.image.dataset.thumb !== f.path
      || els.image.dataset.loaded !== String(size)
      || els.image.dataset.loadedFrom !== f.path;
    if (changed) {
      releaseImage();
      els.image.dataset.thumb = f.path;
      els.image.dataset.loaded = String(size);
      els.image.dataset.loadedFrom = ''; // 尚未取到真图，入队后会填
      els.image.dataset.kind = f.kind;
      els.image.src = D.placeholderSVG(f.kind, Math.min(size, 96));
      els.image.style.background = '';
    }
    setText(els.badge, D.kindLabel(f.kind));
    setText(els.name, f.name);
    setText(els.kind, D.kindLabel(f.kind));
    setText(els.time, D.fmtTime(f.mtime));
    setText(els.size, D.formatSize(f.size));
    setText(els.path, f.path);
  }

  // 释放预览图上的 Blob URL（复用缩略图模块的 release，避免两处重复实现）
  function releaseImage() {
    if (D.thumbs) D.thumbs.release(els.image);
  }

  // ---- 交互 ----
  els.toggle.addEventListener('click', () => setOpen(!D.state.previewOpen));
  els.close.addEventListener('click', () => setOpen(false));
  els.open.addEventListener('click', async () => {
    const f = primarySelection();
    if (!f) return;
    const err = await window.api.openPath(f.path);
    if (err) D.showError('无法用系统默认应用打开：\n' + err);
  });
  els.reveal.addEventListener('click', async () => {
    const f = primarySelection();
    if (!f) return;
    await window.api.revealPath(f.path); // 在文件管理器中定位并选中
  });

  D.preview = { render, setOpen, primarySelection, els };
}());
