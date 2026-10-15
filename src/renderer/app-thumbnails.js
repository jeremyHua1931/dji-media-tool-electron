// app-thumbnails.js —— 缩略图队列（并发受限 + Blob URL 回收 + 预览优先）
// ============================================================
// 取图走「主进程 nativeImage -> JPEG Buffer -> Uint8Array -> Blob URL」，
// 这里负责排队、限制并发、以及在重绘时回收旧的 Blob URL（否则会漏内存）。
//
// 队列策略：预览窗格的大图插队优先——用户点选后最想立刻看到的是右边那张，
// 而不是列表里十几张 22px 小图。

'use strict';

(function () {
  const D = window.DJI;
  const queue = [];
  let running = 0;

  // 释放某个 img 上挂着的 Blob URL
  // 列表每次重绘都会产生一批新 Blob URL，不回收会持续漏内存；
  // 通过 data-blobUrl 记录，释放后立即删除标记防止重复 revoke
  function release(img) {
    if (img && img.dataset.blobUrl) {
      URL.revokeObjectURL(img.dataset.blobUrl);
      delete img.dataset.blobUrl;
    }
  }

  // 把当前 DOM 里所有需要取图的 img 排进队列
  // 分类：预览图（preview 数组，unshift 到队首优先取）与列表图（list 数组，队尾排队）；
  // 同一路径+同一尺寸已取到过的直接跳过（data-loadedFrom 标记），不重复请求
  // spec: { thumb } 当前列表视图的规格；预览图尺寸由自身 data-loaded 决定
  function enqueue(params) {
    const { imgs, previewImg, spec } = params;
    const list = [];
    const preview = [];

    for (const img of imgs) {
      const p = img.dataset.thumb;
      if (!p) continue; // 多选预览时没有具体文件
      const isPreview = img === previewImg;
      const size = isPreview ? Number(img.dataset.loaded) : spec.thumb;
      if (!size) continue;
      // 同一路径 + 同一尺寸且已经拿到过图，就不必重取
      if (img.dataset.loadedFrom === p && img.dataset.loaded === String(size)) continue;
      release(img);
      img.dataset.loaded = String(size);
      img.dataset.loadedFrom = ''; // 取到后再填，避免重绘时反复请求
      (isPreview ? preview : list).push({ img, p, size, kind: img.dataset.kind });
    }

    if (preview.length) queue.unshift(...preview);
    if (list.length) queue.push(...list);
    pump();
  }

  // 队列泵：并发数不超过 D.THUMB_CONCURRENCY（默认 6）。
  // 每个 worker 循环取队首任务；任务完成后检查 img 是否还在 DOM 里
  // （列表可能已重绘 / 换尺寸 / 换选中项），不在或标记对不上就作废。
  // 取图失败（视频无首帧、RAW、Linux 缺解码器）保持占位图标，不打断其它任务。
  async function pump() {
    const worker = async () => {
      while (queue.length) {
        const job = queue.shift();
        const { img, p, size, kind } = job;
        if (!img.isConnected) continue; // 列表已重绘，任务作废
        try {
          const res = await window.api.getThumbnail(p, size);
          // 期间列表可能已重绘 / 换了尺寸 / 换了选中项，任务作废
          if (!img.isConnected || img.dataset.thumb !== p
              || img.dataset.loaded !== String(size)) continue;
          if (res && res.ok && res.data && res.data.length) {
            const blob = new Blob([res.data], { type: 'image/jpeg' });
            const url = URL.createObjectURL(blob);
            img.src = url;
            img.dataset.blobUrl = url;
            img.dataset.loadedFrom = p;
            img.style.background = 'transparent';
          }
          // 取不到图（视频无首帧、RAW、Linux 缺解码器）就保持占位图标，不报错
        } catch { /* 单张失败不影响其它 */ }
      }
    };
    while (running < D.THUMB_CONCURRENCY && queue.length) {
      running += 1;
      worker().finally(() => { running -= 1; });
    }
  }

  // 切换视图时作废未处理的旧任务（尺寸变了，取了也没用）；
  // 正在进行的请求由 worker 内的 isConnected / data 标记校验自行作废
  function clear() { queue.length = 0; }

  // 排队中 + 正在进行的任务总数（用于界面显示/调试）
  function pending() { return queue.length + running; }

  D.thumbs = { enqueue, release, clear, pending };
}());
