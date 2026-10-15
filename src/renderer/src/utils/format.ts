// format.ts —— 渲染进程纯函数工具（无副作用、不依赖 DOM/Vue 状态）
// 从原生版 app-utils.js 迁移而来，逻辑保持不变，只调整导出方式（ESM + TS 类型）。

/**
 * 字节数 -> 人类可读（1024 进制，如 "1.2 GB"）。
 * 小于 10 的数值保留 1 位小数，其余取整，界面更清爽。
 * @param n 字节数
 * @returns 可读体积
 */
export function formatSize(n?: number): string {
  if (!n && n !== 0) return ''
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n
  for (const u of units) {
    v /= 1024
    if (v < 1024) return `${v.toFixed(v < 10 ? 1 : 0)} ${u}`
  }
  return `${v.toFixed(1)} PB`
}

// 类型 -> 中文标签 / CSS 类名（供列表与预览窗格复用）
export function kindLabel(kind: string): string { return kind === 'photo' ? '照片' : '视频' }
export function kindClass(kind: string): string { return kind === 'photo' ? 'kind-photo' : 'kind-video' }

/**
 * ISO 时间 -> "YYYY-MM-DD HH:mm:ss"（本地时区）。
 * 非法日期返回 "—" 占位，避免界面出现 "Invalid Date"。
 * @param iso ISO 时间字符串
 * @returns 格式化时间
 */
export function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (x: number): string => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * 解析日期输入。仅日期时：起始取 00:00:00，结束取 23:59:59（保证闭区间命中全天）。
 * @param str 用户输入
 * @param isEnd 是否为结束日期（决定仅日期时的时分秒）
 * @returns Date / null（空表示不限）/ undefined（格式非法）
 */
export function parseDateInput(str: string, isEnd: boolean): Date | null | undefined {
  const s = (str || '').trim()
  if (!s) return null
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/)
  if (m) {
    const [, y, mo, d, h, mi, se] = m
    return new Date(+y, +mo - 1, +d, +h, +mi, se ? +se : 0)
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (m) {
    const [, y, mo, d] = m
    return isEnd ? new Date(+y, +mo - 1, +d, 23, 59, 59)
                 : new Date(+y, +mo - 1, +d, 0, 0, 0)
  }
  return undefined
}

// 日期 -> 输入框用的 "YYYY-MM-DD"（date input 的标准格式）
export function toDateInput(d: Date): string {
  const p = (x: number): string => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 照片 / 视频的通用占位图标（内联 SVG，无外部依赖、不联网）。
 * 在真实缩略图取到之前显示；照片用蓝色卡片+白圆点，视频用红色卡片+播放三角。
 * @param kind 'photo' | 'video'
 * @param size 图标边长(px)
 * @returns data: URL
 */
export function placeholderSVG(kind: string, size: number): string {
  const color = kind === 'photo' ? '#4A90D9' : '#D9534F'
  let inner: string
  if (kind === 'photo') {
    inner = `<rect x="18%" y="30%" width="64%" height="44%" rx="6" fill="#fff"/>
      <circle cx="50%" cy="52%" r="13%" fill="${color}"/>
      <circle cx="55%" cy="47%" r="4%" fill="#fff"/>`
  } else {
    inner = `<polygon points="38%,32% 38%,68% 70%,50%" fill="#fff"/>`
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"
    viewBox="0 0 64 64"><rect width="64" height="64" rx="8" fill="${color}"/>${inner}</svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}
