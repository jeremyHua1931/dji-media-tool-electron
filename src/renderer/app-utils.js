// app-utils.js —— 渲染进程纯函数工具（无副作用、不依赖 DOM 状态）
// ============================================================
// 放在这里的都是"输入 -> 输出"的纯函数，方便单独推敲，也让 renderer.js 瘦下来。

'use strict';

(function () {
  const D = window.DJI;

  // 字节数 -> 人类可读（1024 进制，如 "1.2 GB"）
  // 小于 10 的数值保留 1 位小数，其余取整，界面更清爽
  function formatSize(n) {
    if (!n && n !== 0) return '';
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n;
    for (const u of units) {
      v /= 1024;
      if (v < 1024) return `${v.toFixed(v < 10 ? 1 : 0)} ${u}`;
    }
    return `${v.toFixed(1)} PB`;
  }

  // 拼 HTML 之前的转义：所有来自文件系统的字符串都必须过这里，
  // 防止文件名里的 < > & " ' 破坏页面结构或注入脚本（XSS 防线）
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // 类型 -> 中文标签 / CSS 类名（供列表与预览窗格复用）
  function kindLabel(kind) { return kind === 'photo' ? '照片' : '视频'; }
  function kindClass(kind) { return kind === 'photo' ? 'kind-photo' : 'kind-video'; }

  // ISO 时间 -> "YYYY-MM-DD HH:mm:ss"（本地时区）
  // 非法日期返回 "—" 占位，避免界面出现 "Invalid Date"
  function fmtTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
      + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  // 解析日期输入。仅日期时：起始取 00:00:00，结束取 23:59:59（保证闭区间命中全天）
  // 返回 Date / null（空表示不限）/ undefined（格式非法，调用方据此报错）
  function parseDateInput(str, isEnd) {
    const s = (str || '').trim();
    if (!s) return null;
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (m) {
      const [, y, mo, d, h, mi, se] = m;
      return new Date(+y, +mo - 1, +d, +h, +mi, +se ? +se : 0);
    }
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) {
      const [, y, mo, d] = m;
      return isEnd ? new Date(+y, +mo - 1, +d, 23, 59, 59)
                   : new Date(+y, +mo - 1, +d, 0, 0, 0);
    }
    return undefined;
  }

  // 日期 -> 输入框用的 "YYYY-MM-DD"（date input 的标准格式）
  function toDateInput(d) {
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  // 照片 / 视频的通用占位图标（内联 SVG，无外部依赖、不联网）
  // 在真实缩略图取到之前显示；照片用蓝色卡片+白圆点，视频用红色卡片+播放三角
  function placeholderSVG(kind, size) {
    const color = kind === 'photo' ? '#4A90D9' : '#D9534F';
    let inner;
    if (kind === 'photo') {
      inner = `<rect x="18%" y="30%" width="64%" height="44%" rx="6" fill="#fff"/>
      <circle cx="50%" cy="52%" r="13%" fill="${color}"/>
      <circle cx="55%" cy="47%" r="4%" fill="#fff"/>`;
    } else {
      inner = `<polygon points="38%,32% 38%,68% 70%,50%" fill="#fff"/>`;
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"
    viewBox="0 0 64 64"><rect width="64" height="64" rx="8" fill="${color}"/>${inner}</svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }

  Object.assign(D, {
    formatSize, escapeHtml, kindLabel, kindClass,
    fmtTime, parseDateInput, toDateInput, placeholderSVG,
  });
}());
