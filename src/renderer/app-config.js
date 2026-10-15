// app-config.js —— 渲染进程共享配置与全局命名空间
// ============================================================
// 界面脚本按以下顺序加载（都是普通脚本，共享全局作用域）：
//   1. app-config.js   常量、视图规格、全局命名空间 window.DJI
//   2. app-utils.js    纯函数工具（格式化 / 转义 / 日期解析 / 占位图标）
//   3. app-thumbnails.js 缩略图队列（并发限制 + Blob URL 回收）
//   4. app-preview.js  右侧预览窗格
//   5. renderer.js     状态、渲染、选择、扫描、复制、交互绑定
//
// 为什么不用 ES module：界面用 file:// 加载，classic script 最省事，
// 没有打包器也能跑；模块之间只通过 window.DJI 共享「数据」，
// 局部逻辑留在各自文件里，避免变成一个 700 行的巨型文件。

'use strict';

window.DJI = window.DJI || {};

// 缩略图/网格规格：默认值仅作首帧兜底，启动后由主进程 config 覆盖（单一来源）
window.DJI.ICON_SPEC = {
  detail: { thumb: 22 },
  icon_small: { thumb: 48, cellW: 112, cellH: 94 },
  icon_medium: { thumb: 96, cellW: 154, cellH: 144 },
  icon_large: { thumb: 144, cellW: 204, cellH: 196 },
};

// 缩略图取图并发数（太小会慢，太大会让读取相机变卡）
window.DJI.THUMB_CONCURRENCY = 6;

// 预览窗格用的缩略图边长：必须落在主进程允许的尺寸里
window.DJI.PREVIEW_THUMB_SIZE = 144;

// 素材文件夹栏最多显示几个目录
window.DJI.MAX_FOLDER_ROWS = 3;
