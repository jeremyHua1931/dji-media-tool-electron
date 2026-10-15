// useStore.ts —— 渲染进程中央状态与业务动作（单例 composable，TS 版）
// ============================================================
// 把原生版 renderer.js 的状态 + 动作整合成一个模块级 reactive 单例，
// 所有组件通过 useStore() 读取同一份状态、调用同一批动作。
// 渲染进程只通过 window.api 与主进程通信，不直接访问 Node。
//
// 模块级单例（非每个组件各一份）：组件间天然共享，避免 props 层层透传。

import { reactive, ref, computed, watch } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { formatSize, parseDateInput, toDateInput } from '../utils/format'
import { useThumbnailManager } from './useThumbnails'

// ---------- 类型 ----------
// 扫描命中的单个素材（与主进程 scanner 的 MediaFile 结构一致）
export interface MediaFile {
  path: string
  name: string
  size: number
  mtime: string
  kind: 'photo' | 'video'
  dir: string
}

// 检测到的相机/存储卡
export interface CameraInfo { name: string; root: string }

// 复制选项（与 OptionsModal 表单对应）
export interface CopyOptions {
  conflict: 'skip' | 'overwrite' | 'rename'
  byDate: boolean
  openAfter: boolean
  onlyNew: boolean
  verify: boolean
}

// 缩略图/网格规格
export interface IconSpec { thumb: number; cellW?: number; cellH?: number }

// 中央状态的全部字段
interface State {
  files: MediaFile[]          // 扫描结果（原始列表，未排序）
  view: string                // detail / icon_large / icon_medium / icon_small
  sortKey: 'name' | 'mtime' | 'kind' | 'size'
  sortDir: 'asc' | 'desc'
  anchor: string | null       // Shift 多选的锚点（文件路径）
  busy: boolean
  destPath: string            // 目标文件夹：点"一键复制"时才弹窗选择
  previewOpen: boolean        // 右侧预览窗格是否展开
  drawerOpen: boolean         // 选项抽屉是否展开
  srcPath: string             // 素材来源
  dcimOnly: boolean           // 只扫 DCIM
  dateFrom: string            // 起始日期输入框值
  dateTo: string              // 结束日期输入框值
  fType: 'both' | 'photo' | 'video'
  cameras: CameraInfo[]       // 检测到的相机/存储卡（用于只读提示）
  ICON_SPEC: Record<string, IconSpec>
  copyOptions: CopyOptions
  copyModalOpen: boolean      // 复制选项弹窗是否打开
  refreshState: string        // "扫描中…" / "已刷新 · N 个" / "条件已变…"
}

// 复制完成汇总（主进程 copy:start 返回）
interface CopyRunSummary {
  copied: number
  alreadyExists: number
  skipped: number
  renamed: number
  verified: number
  failed: { name: string; error: string }[]
  cancelled: boolean
  bytesCopied: number
}

// ---------- 常量（来自主进程 config，单一来源；首帧用内置兜底） ----------
const DEFAULT_ICON_SPEC: Record<string, IconSpec> = {
  detail: { thumb: 22 },
  icon_small: { thumb: 48, cellW: 112, cellH: 94 },
  icon_medium: { thumb: 96, cellW: 154, cellH: 144 },
  icon_large: { thumb: 144, cellW: 204, cellH: 196 },
}

// ---------- 中央状态 ----------
const state = reactive<State>({
  files: [],
  view: 'detail',
  sortKey: 'mtime',
  sortDir: 'asc',
  anchor: null,
  busy: false,
  destPath: '',
  previewOpen: true,
  drawerOpen: false,
  srcPath: '',
  dcimOnly: true,
  dateFrom: '',
  dateTo: '',
  fType: 'both',
  cameras: [],
  ICON_SPEC: { ...DEFAULT_ICON_SPEC },
  copyOptions: {
    conflict: 'skip',     // skip / overwrite / rename
    byDate: false,
    openAfter: true,
    onlyNew: true,        // 默认增量：只复制目标里没有的
    verify: true,         // 默认复制后按大小复核
  },
  copyModalOpen: false,
  refreshState: '',
})

// 选中项集合（文件路径为 id）。用独立 reactive Set，保持增删的响应式
const selection: Set<string> = reactive(new Set<string>())

// 底部状态栏文案 / 进度条百分比
const statusText: Ref<string> = ref('就绪。先在选项里选择素材来源，再点「扫描匹配文件」。')
const progressPct: Ref<number> = ref(0)

// 缩略图队列管理器（模块级单例）
const thumbs = useThumbnailManager()

// ---------- 基础 UI 工具 ----------
// 统一错误提示：走 window.alert，便于自动化测试替换
function showError(message: string): void {
  const fn = typeof window.alert === 'function' ? window.alert : null
  if (fn) fn.call(window, message)
}
function setStatus(text: string): void { statusText.value = text }
function setProgress(pct: number): void {
  progressPct.value = Math.max(0, Math.min(100, pct))
}

// ---------- 派生数据（computed） ----------
// 按当前排序键与方向返回排序后的文件列表
const sortedFiles: ComputedRef<MediaFile[]> = computed(() => {
  const dir = state.sortDir === 'asc' ? 1 : -1
  return [...state.files].sort((a, b) => {
    let r: number
    if (state.sortKey === 'name') r = a.name.localeCompare(b.name)
    else if (state.sortKey === 'size') r = a.size - b.size
    else if (state.sortKey === 'kind') r = a.kind.localeCompare(b.kind)
    else r = new Date(a.mtime).getTime() - new Date(b.mtime).getTime()
    return r * dir
  })
})

// 素材实际所在文件夹统计（复制时最关心的信息）
const mediaFolders: ComputedRef<{ dir: string; count: number }[]> = computed(() => {
  const map = new Map<string, { dir: string; count: number }>()
  for (const f of state.files) {
    const dir = f.dir
    if (!dir) continue
    const cur = map.get(dir)
    if (cur) cur.count += 1
    else map.set(dir, { dir, count: 1 })
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.dir.localeCompare(b.dir))
})

// 顶栏参数摘要（一行展示当前筛选条件与命中数）
const paramSummary: ComputedRef<string> = computed(() => {
  const typeText = state.fType === 'both' ? '照片+视频' : (state.fType === 'photo' ? '仅照片' : '仅视频')
  const from = state.dateFrom.trim()
  const to = state.dateTo.trim()
  const dateText = (!from && !to) ? '不限日期' : `${from || '最早'} ~ ${to || '最新'}`
  let base = `${state.srcPath || '未设置来源'} ｜ ${typeText} ｜ ${dateText}`
  if (state.dcimOnly) base += ' ｜ 仅 DCIM'
  if (state.copyOptions.onlyNew) base += ' ｜ 只复制新文件'
  const destText = state.destPath ? ` ｜ 存到 ${state.destPath}` : ' ｜ 目标未选（点"一键复制"时再选）'
  return (state.files.length ? `${base} ｜ 命中 ${state.files.length} 个文件` : base) + destText
})

// "重置筛选"是否真的有生效条件（类型/日期）
const hasActiveFilter: ComputedRef<number> = computed(() => {
  const hasDate = !!(state.dateFrom.trim() || state.dateTo.trim())
  return (state.fType !== 'both' ? 1 : 0) + (hasDate ? 1 : 0)
})

// ---------- 排序 / 选择 ----------
function toggleSort(key: State['sortKey']): void {
  if (state.sortKey === key) {
    state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc'
  } else {
    state.sortKey = key
    state.sortDir = key === 'size' ? 'desc' : 'asc'
  }
}

function setView(view: string): void {
  state.view = view
  thumbs.resetThumbs() // 尺寸变了，作废旧缩略图任务与缓存
}

// 单选（清空旧选中）
function selectOnly(path: string | null): void {
  selection.clear()
  if (path) selection.add(path)
  state.anchor = path || null
}

// Ctrl 点选：切换单项并更新锚点
function toggleSelect(path: string): void {
  if (selection.has(path)) selection.delete(path)
  else selection.add(path)
  state.anchor = path
}

// Shift 点选：从锚点连续选中到当前项（按当前排序顺序）
function selectRange(path: string): void {
  if (!state.anchor) { selectOnly(path); return }
  const order = sortedFiles.value.map((f) => f.path)
  const a = order.indexOf(state.anchor)
  const b = order.indexOf(path)
  if (a < 0 || b < 0) { selectOnly(path); return }
  const [lo, hi] = [Math.min(a, b), Math.max(a, b)]
  selection.clear()
  order.slice(lo, hi + 1).forEach((p) => selection.add(p))
}

// 点击（委托到列表容器）：按修饰键分发到 单选 / Ctrl / Shift
function handleListClick(path: string, { ctrl, shift }: { ctrl?: boolean; shift?: boolean } = {}): void {
  if (ctrl) toggleSelect(path)
  else if (shift) selectRange(path)
  else selectOnly(path)
}

function selectAll(): void {
  selection.clear()
  for (const f of state.files) selection.add(f.path)
  state.anchor = state.files[0] ? state.files[0].path : null
}

function clearSelection(): void {
  selection.clear()
  state.anchor = null
}

// ---------- 抽屉 ----------
function setDrawer(open: boolean): void {
  state.drawerOpen = open
  // 收起抽屉 = 一次"操作结束"，顺手刷新一下结果
  if (!open) scheduleRefresh(250)
}

// ---------- 扫描 ----------
// 把当前扫描条件算成签名：签名不变就不重复扫描
function scanSignature(): string {
  return [
    state.srcPath.trim(), state.dateFrom.trim(), state.dateTo.trim(),
    state.fType, state.dcimOnly ? '1' : '0',
  ].join('\u0001')
}

let lastScanSignature: string | null = null
let refreshTimer: ReturnType<typeof setTimeout> | null = null
let autoScanEnabled = false // 启动自动扫描期间先关掉"自动刷新"，避免自己触发自己

/**
 * 执行一次扫描（核心入口）。
 * 校验顺序：忙碌状态 → 来源非空 → 日期格式合法 → 起止不颠倒；
 * 通过后交给主进程扫描，成功则更新状态、清空选中、丢弃旧缩略图队列。
 * @param opt { auto: 是否由条件变化自动触发, silent: 不弹错误框 }
 * @returns 是否扫描成功
 */
async function runScan(opt: { auto?: boolean; silent?: boolean } = {}): Promise<boolean> {
  const { auto = false, silent = false } = opt
  if (state.busy) return false

  const root = state.srcPath.trim()
  if (!root) {
    if (!auto) { setDrawer(true); showError('请先选择有效的素材来源文件夹。') }
    return false
  }

  const start = parseDateInput(state.dateFrom, false)
  const end = parseDateInput(state.dateTo, true)
  if (start === undefined || end === undefined) {
    state.refreshState = '日期格式不对'
    if (!silent) showError('日期格式不对，请用 YYYY-MM-DD 或 YYYY-MM-DD HH:MM')
    return false
  }
  if (start && end && start > end) {
    state.refreshState = '起止日期颠倒'
    if (!silent) showError('起始日期不能晚于结束日期。')
    return false
  }

  const payload = {
    root,
    startISO: start ? start.toISOString() : null,
    endISO: end ? end.toISOString() : null,
    wantPhoto: state.fType === 'both' || state.fType === 'photo',
    wantVideo: state.fType === 'both' || state.fType === 'video',
    dcimOnly: state.dcimOnly,
  }
  const signature = scanSignature()

  state.busy = true
  setProgress(0)
  state.refreshState = '扫描中…'
  setStatus(`正在扫描 ${root} …`)

  try {
    const files = await window.api.scan(payload)
    state.files = files
    clearSelection()
    thumbs.resetThumbs()
    lastScanSignature = signature
    const total = files.reduce((s, f) => s + (f.size || 0), 0)
    if (files.length) {
      setStatus(`找到 ${files.length} 个文件，共 ${formatSize(total)}，`
        + `分布在 ${mediaFolders.value.length} 个文件夹。检查无误后点"一键复制"。`)
    } else {
      setStatus('没有找到符合条件的文件。试试放宽时间范围或文件类型。')
    }
    state.refreshState = files.length ? `已刷新 · ${files.length} 个` : '已刷新 · 无匹配'
    return true
  } catch (err) {
    state.refreshState = '刷新失败'
    setStatus('扫描出错：' + String(err))
    if (!silent) showError('扫描失败：\n' + String(err))
    return false
  } finally {
    state.busy = false
  }
}

// 条件变化后的自动刷新：650ms 合并窗口内多次改动只触发一次扫描
function scheduleRefresh(delay?: number): void {
  if (!autoScanEnabled) return
  if (refreshTimer) clearTimeout(refreshTimer)
  state.refreshState = '条件已变，准备刷新…'
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    if (state.busy) { scheduleRefresh(400); return }
    if (!state.srcPath.trim()) { state.refreshState = ''; return }
    if (scanSignature() === lastScanSignature) { state.refreshState = ''; return }
    runScan({ auto: true, silent: true })
  }, typeof delay === 'number' ? delay : 650)
}

// 时间快捷档：今天 / 一天 / 三天 / 七天 / 不限（滚动窗口，含今天）
function quickRange(key: string): [Date | null, Date | null] {
  const today = new Date()
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  if (key === 'today') return [startOfToday, today]
  if (key === 'clear') return [null, null]
  const days = Number(key)
  if (!Number.isFinite(days) || days < 1) return [null, null]
  return [new Date(startOfToday.getTime() - (days - 1) * 86400000), today]
}

// 把快捷档结果写入日期输入，并触发自动重扫
function setDateRange(d1: Date | null, d2: Date | null): void {
  if (!d1 || !d2) { state.dateFrom = ''; state.dateTo = '' }
  else { state.dateFrom = toDateInput(d1); state.dateTo = toDateInput(d2) }
  scheduleRefresh()
}

// 重置筛选：清空日期、恢复"全部"类型
function resetFilter(): void {
  state.dateFrom = ''
  state.dateTo = ''
  state.fType = 'both'
  scheduleRefresh(300)
}

// 素材来源：手动浏览选择
async function browseSource(): Promise<void> {
  const p = await window.api.pickFolder('选择素材所在文件夹（相机盘符 / DCIM / 任意文件夹）')
  if (p) { state.srcPath = p; scheduleRefresh(200) }
}

// 素材来源：自动检测相机 / 读卡器
async function detectAuto(): Promise<void> {
  setStatus('正在检测相机 / 读卡器…')
  let info: { root: string; fileCount?: number } | null = null
  let cams: CameraInfo[] = []
  try {
    info = await window.api.suggestMediaRoot()
    cams = await window.api.detectCameras()
  } catch (err) {
    setStatus('检测设备失败：' + String(err))
    return
  }

  if (!cams.length && !info) {
    setStatus('未检测到相机 / 读卡器。')
    showError('没有检测到相机/读卡器。\n\n请确认：\n'
      + '1. 相机已通过 USB-C 连接电脑，并在相机屏幕上选择“文件传输：USB”；\n'
      + '2. 读卡器/SD 卡已插入。\n也可以直接点“浏览…”手动选择。')
    return
  }

  state.cameras = cams
  if (info && info.root) {
    state.srcPath = info.root
    setStatus(`已检测到素材目录：${info.root}`
      + (info.fileCount ? `（${info.fileCount} 个素材）` : '（未识别到素材）')
      + '，正在刷新…')
    scheduleRefresh(150)
    return
  }

  state.srcPath = cams[0].root
  setStatus(cams.length === 1
    ? `已检测到相机：${cams[0].name}`
    : `检测到 ${cams.length} 个可移动设备，已填入第一个。`)
  scheduleRefresh(150)
}

// ---------- 复制选项弹窗（与 OptionsModal 组件协作） ----------
let modalResolve: ((result: boolean) => void) | null = null
function askCopyOptions(): Promise<boolean> {
  state.copyModalOpen = true
  return new Promise((resolve) => { modalResolve = resolve })
}
// 弹窗确认/取消后：关闭弹窗并 resolve 流程
function resolveCopyModal(result: boolean): void {
  state.copyModalOpen = false
  const r = modalResolve
  modalResolve = null
  if (r) r(result)
}
// 从弹窗控件读回设置（组件把表单值整包传进来）
function updateCopyOptions(patch: Partial<CopyOptions>): void {
  Object.assign(state.copyOptions, patch)
}

// ---------- 复制 ----------
async function pickDestination(): Promise<string | null> {
  const p = await window.api.pickFolder('选择保存到的目标文件夹（一键复制会存到这里）')
  if (!p) return null
  state.destPath = p
  return p
}

// 复制前预检：目标不能落在源盘 / 源目录内，且目标盘空间要够
async function preflightCopy(dest: string, chosen: MediaFile[]): Promise<boolean> {
  const totalBytes = chosen.reduce((s, f) => s + (f.size || 0), 0)
  let gate: { ok: boolean; code?: string; message?: string } | null = null
  try {
    gate = await window.api.preflightCopy({
      dest,
      sourceRoot: state.srcPath.trim(),
      totalBytes,
      fileCount: chosen.length,
    })
  } catch (err) {
    gate = { ok: false, message: String(err) }
  }
  if (!gate || !gate.ok) {
    setStatus('已阻止：' + (gate && gate.code ? gate.code : 'preflight'))
    showError('无法开始复制：\n\n' + ((gate && gate.message) || '复制前检查未通过。'))
    return false
  }
  return true
}

// 一键复制主流程（三步：弹窗 → 选目录 → 预检 → 复制）
async function startCopyFlow(): Promise<void> {
  if (!state.files.length) { showError('还没有匹配结果，请先点“扫描匹配文件”。'); return }

  const chosen = selection.size
    ? state.files.filter((f) => selection.has(f.path))
    : state.files

  // 第 1 步：复制选项弹窗（取消则整条流程中止）
  if (!(await askCopyOptions())) {
    setStatus('已取消复制（未确认复制选项）。')
    return
  }
  // 第 2 步：选择保存位置
  const dest = await pickDestination()
  if (!dest) { setStatus('已取消：未选择保存目标文件夹。'); return }
  // 第 3 步：只读保证 + 空间预检
  if (!(await preflightCopy(dest, chosen))) return

  const { conflict, byDate, onlyNew, verify } = state.copyOptions
  state.busy = true
  setProgress(0)
  setStatus(`开始复制 ${chosen.length} 个文件到 ${dest} …`)

  try {
    const s = await (window.api.startCopy({
      files: chosen, dest, byDate, onConflict: conflict, onlyNew, verify,
      sourceRoot: state.srcPath.trim(),
    }) as unknown as Promise<CopyRunSummary>)
    if (!s.cancelled) setProgress(100)

    const parts = [`成功 ${s.copied} 个`]
    if (s.alreadyExists) parts.push(`已存在跳过 ${s.alreadyExists} 个`)
    if (s.skipped) parts.push(`撞名跳过 ${s.skipped} 个`)
    if (s.renamed) parts.push(`自动改名 ${s.renamed} 个`)
    if (verify) parts.push(`校验通过 ${s.verified} 个`)
    if (s.failed.length) parts.push(`失败 ${s.failed.length} 个`)
    const msg = `复制完成：${parts.join('，')}`
      + (s.cancelled ? '（已取消）' : '')
      + (s.bytesCopied ? `，共写入 ${formatSize(s.bytesCopied)}` : '')
    setStatus(msg)

    if (state.copyOptions.openAfter && s.copied) {
      await window.api.openPath(dest)
    }
    if (s.failed.length) {
      showError(msg + '\n\n失败明细（前 10 条）：\n'
        + s.failed.slice(0, 10).map((x) => `- ${x.name}: ${x.error}`).join('\n'))
    } else if (!s.cancelled) {
      showError(msg + (s.alreadyExists === chosen.length
        ? '\n\n（所有文件此前都已复制过，没有重复写入）' : ''))
    }
    if (s.copied === 0 && s.alreadyExists > 0) {
      setStatus(`${msg}——若想重新复制，可取消“只复制新文件”。`)
    }
  } catch (err) {
    setStatus('复制出错：' + String(err))
    showError('复制失败：\n' + String(err))
  } finally {
    state.busy = false
  }
}

async function cancelCopy(): Promise<void> {
  await window.api.cancelCopy()
  setStatus('正在取消…')
}

// ---------- 进度事件订阅（常驻，避免重复叠加监听器） ----------
window.api.onCopyProgress((info) => {
  if (!state.busy) return // 已结束的任务不再动界面
  setProgress(info.totalBytes ? (info.doneBytes / info.totalBytes) * 100 : 0)
  setStatus(`处理中 ${info.idx}/${info.total}：${info.name}`)
})

// ---------- 初始化（App 挂载后调用一次） ----------
async function init(): Promise<void> {
  // 读主进程下发的界面常量（网格/缩略图尺寸、扩展名白名单），失败用内置兜底
  try {
    const cfg = await window.api.readConfig()
    if (cfg && cfg.THUMB_SIZES) state.ICON_SPEC = cfg.THUMB_SIZES as Record<string, IconSpec>
  } catch { /* 用兜底尺寸 */ }

  // 默认时间范围：最近一天（昨天 00:00:00 ~ 今天 23:59:59）
  const [d1, d2] = quickRange('1')
  state.dateFrom = d1 ? toDateInput(d1) : ''
  state.dateTo = d2 ? toDateInput(d2) : ''

  // 自动检测相机：直接定位到素材子文件夹（如 F:\DCIM\DJI_001），并自动扫描一次
  try {
    const info = await window.api.suggestMediaRoot()
    if (info && info.root) {
      if (!state.srcPath.trim()) state.srcPath = info.root
      try { state.cameras = await window.api.detectCameras() } catch { /* 提示拿不到就算了 */ }
      const hint = info.fileCount
        ? `${info.root}（该文件夹内 ${info.fileCount} 个素材）`
        : `${info.root}（未识别到素材，可放宽时间范围）`
      setStatus(`已自动检测到相机素材：${hint}，正在自动扫描最近一天…`)
    } else {
      setStatus('未检测到相机 / 存储卡。可点「自动检测」或「浏览…」手动选择素材来源。')
    }
  } catch { /* 检测失败不影响手动选择 */ }

  // 自动刷新一次（条件已就绪就扫）
  autoScanEnabled = true
  if (state.srcPath.trim()) await runScan({ auto: true, silent: true })
}

// 筛选条件变化 -> 自动重扫（含来源/日期/类型/DCIM）。早期变化时 autoScanEnabled=false 会被忽略
watch(
  () => [state.srcPath, state.dateFrom, state.dateTo, state.fType, state.dcimOnly],
  () => scheduleRefresh()
)

// 对外暴露：单例状态 + 派生 + 动作
export function useStore() {
  return {
    state, selection, thumbs,
    statusText, progressPct,
    sortedFiles, mediaFolders, paramSummary, hasActiveFilter,
    // 动作
    toggleSort, setView, handleListClick, selectAll, clearSelection,
    setDrawer, runScan, scheduleRefresh, quickRange, setDateRange, resetFilter,
    browseSource, detectAuto,
    askCopyOptions, resolveCopyModal, updateCopyOptions,
    startCopyFlow, cancelCopy, pickDestination,
    setStatus, setProgress, showError,
    init,
  }
}
