// useThumbnails.ts —— 缩略图队列（并发受限 + 预览优先）
// ============================================================
// 取图链路：主进程 nativeImage -> JPEG Buffer -> Uint8Array -> Blob URL，
// 渲染端维护一个并发受限的任务队列，并在图片不再使用时负责 revoke Blob URL
// （否则反复重绘会持续漏内存）。
//
// 队列策略（与原生版一致）：预览窗格的大图插队优先——用户点选后最想立刻看到
// 的是右边那张，而不是列表里十几张 22px 小图。

import { reactive } from 'vue'

// 取图并发数（太小会慢，太大会让读取相机变卡）
const THUMB_CONCURRENCY = 6

// 单个取图任务
interface ThumbJob {
  path: string
  size: number
  kind?: string
  preview?: boolean
  onLoad: (url: string) => void
}

// 模块级队列（单例），与 useStore 同一引用
const queue: ThumbJob[] = []
let running = 0

// 释放 Blob URL
function releaseBlob(url?: string): void {
  if (url) URL.revokeObjectURL(url)
}

/**
 * 把一批取图任务排进队列。
 * preview 为 true 的插到队首（预览窗格大图优先）；同 path+size 已取到过的
 * 由调用方（组件）通过缓存去重，这里只负责调度。
 * @param jobs 取图任务数组
 */
function enqueue(jobs: ThumbJob[]): void {
  const previews = jobs.filter((j) => j.preview)
  const rest = jobs.filter((j) => !j.preview)
  queue.unshift(...previews)
  queue.push(...rest)
  pump()
}

// 队列泵：并发数不超过 THUMB_CONCURRENCY；单张取图失败（视频无首帧 / RAW /
// Linux 缺解码器）不影响其它任务，由调用方回退到占位图标
async function pump(): Promise<void> {
  const worker = async (): Promise<void> => {
    while (queue.length) {
      const job = queue.shift()!
      try {
        const res = await window.api.getThumbnail(job.path, job.size)
        if (res && res.ok && res.data && res.data.length) {
          // Uint8Array 结构与 BlobPart 不完全匹配（ArrayBufferLike vs ArrayBuffer），
          // 这里按运行时语义转成 Blob 所需类型即可
          const blob = new Blob([res.data as unknown as BlobPart], { type: 'image/jpeg' })
          job.onLoad(URL.createObjectURL(blob))
        }
      } catch { /* 单张失败不影响其它 */ }
    }
  }
  while (running < THUMB_CONCURRENCY && queue.length) {
    running += 1
    worker().finally(() => { running -= 1 })
  }
}

// 切换视图 / 重新扫描时作废未处理的旧任务（尺寸变了，取了也没用）
function clear(): void { queue.length = 0 }

// 排队中 + 正在进行的任务总数（用于界面/调试）
function pending(): number { return queue.length + running }

// 渲染端统一维护的「文件路径 -> 缩略图 URL」缓存。
// FileList / PreviewPane 用 reactive 对象记录每个文件已取到的图，
// 取到后写入，Vue 自动更新对应 <img :src>。
const thumbUrls = reactive<Record<string, string>>({})

// 已发起过的 (path,size) 集合，避免重复入队；重扫/切视图后清除
const requestedSet = new Set<string>()

/**
 * 请求某文件的缩略图（幂等：已取到或已请求过的路径不重复入队）。
 * 供 FileList 遍历可见项、PreviewPane 预览大图时调用。
 * @param opts { path, size, kind, preview? }
 * @returns 若已有缩略图 URL 直接返回，否则返回 null（稍后异步填充）
 */
function requestThumb(opts: { path: string; size: number; kind?: string; preview?: boolean }): string | null {
  const { path, size, preview = false } = opts
  const key = `${path}\u0001${size}`
  if (thumbUrls[key]) return thumbUrls[key]
  // 用请求中标记避免同一路径+尺寸被反复入队
  if (requestedSet.has(key)) return null
  requestedSet.add(key)
  enqueue([{
    path, size, preview,
    onLoad: (url: string) => { thumbUrls[key] = url },
  }])
  return null
}

// 重扫/切视图后：清空请求标记，释放旧 Blob URL 并清空缓存
function resetThumbs(): void {
  requestedSet.clear()
  for (const k of Object.keys(thumbUrls)) {
    releaseBlob(thumbUrls[k])
    delete thumbUrls[k]
  }
}

// 对外暴露：单例队列管理器（与 useStore 共享同一实例）
export function useThumbnailManager() {
  return {
    enqueue,
    clear,
    pending,
    releaseBlob,
    thumbUrls,
    requestThumb,
    resetThumbs,
  }
}
