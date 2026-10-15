<script setup lang="ts">
// SettingsDrawer.vue —— 右侧可拖动、可收起的选项抽屉
// 收纳「素材来源 / 只扫 DCIM / 复制选项」等低频设置，不占用结果区高度。
// 拖动逻辑：pointer 事件 + 视口钳制；位置记忆到 localStorage，首次打开时居中。
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { useStore } from '../composables/useStore'

const store = useStore()
const drawerEl = ref<HTMLElement | null>(null)

// 位置记忆键
const POS_KEY = 'dji.drawerPos'
let dragging: { dx: number; dy: number } | null = null // 按下点到元素左上角的偏移
let needCenter = false   // 首次打开时需要居中（此时才量得到真实尺寸）

// 把抽屉定位到 (left, top)，并钳制在视口内
function applyPos(left: number, top: number): void {
  const el = drawerEl.value
  if (!el) return
  const maxLeft = Math.max(0, window.innerWidth - el.offsetWidth)
  const maxTop = Math.max(0, window.innerHeight - el.offsetHeight)
  el.style.left = `${Math.min(Math.max(0, left), maxLeft)}px`
  el.style.top = `${Math.min(Math.max(0, top), maxTop)}px`
  el.style.right = 'auto'
}

// 窗口尺寸变化时重新钳制（避免缩小后抽屉跑到屏幕外）
function clampCurrent(): void {
  const el = drawerEl.value
  if (el && el.style.left) {
    applyPos(parseFloat(el.style.left), parseFloat(el.style.top))
  }
}

// 首次显示时居中（此时元素已有真实尺寸）
function centerIfNeeded(): void {
  if (!needCenter || !drawerEl.value) return
  needCenter = false
  applyPos((window.innerWidth - drawerEl.value.offsetWidth) / 2,
    (window.innerHeight - drawerEl.value.offsetHeight) / 2)
}

onMounted(() => {
  // 恢复上次位置；没有记录则标记为需要居中
  try {
    const saved = JSON.parse(localStorage.getItem(POS_KEY) || 'null') as { left: number; top: number } | null
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) applyPos(saved.left, saved.top)
    else needCenter = true
  } catch { needCenter = true }
  window.addEventListener('resize', clampCurrent)
  // 每次打开抽屉时：若从未定位过就居中
  watch(() => store.state.drawerOpen, (open) => { if (open) centerIfNeeded() })
})
onUnmounted(() => window.removeEventListener('resize', clampCurrent))

// 拖动开始：记录偏移，捕获指针，进入拖动态
function onPointerDown(e: PointerEvent): void {
  if (e.button !== 0 || e.target instanceof Element && e.target.closest('button')) return
  const el = drawerEl.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  dragging = { dx: e.clientX - rect.left, dy: e.clientY - rect.top }
  el.classList.add('dragging')
  try { el.setPointerCapture(e.pointerId) } catch { /* 触摸兜底 */ }
  e.preventDefault()
}
// 拖动中：持续跟随并钳制
function onPointerMove(e: PointerEvent): void {
  if (!dragging || !drawerEl.value) return
  applyPos(e.clientX - dragging.dx, e.clientY - dragging.dy)
}
// 拖动结束：落盘位置记忆
function endDrag(): void {
  if (!dragging) return
  dragging = null
  const el = drawerEl.value
  if (!el) return
  el.classList.remove('dragging')
  try {
    localStorage.setItem(POS_KEY, JSON.stringify({
      left: parseFloat(el.style.left) || 0,
      top: parseFloat(el.style.top) || 0,
    }))
  } catch { /* 存不了就算了 */ }
}

// 抽屉里的「复制选项…」只打开弹窗，不触发复制流程
function openCopyOptions(): void { store.askCopyOptions() }
</script>

<template>
  <aside v-if="store.state.drawerOpen" ref="drawerEl" class="drawer" aria-hidden="false">
    <div class="drawer-head"
         @pointerdown="onPointerDown"
         @pointermove="onPointerMove"
         @pointerup="endDrag"
         @pointercancel="endDrag">
      <span class="drawer-title">扫描选项</span>
      <span class="drawer-grip" aria-hidden="true">⋮⋮</span>
      <button class="ghost" title="收起抽屉" @click="store.setDrawer(false)">收起</button>
    </div>

    <div class="drawer-body">
      <div class="field">
        <label class="field-label" for="srcPath">素材来源（相机 / 读卡器 / 文件夹）</label>
        <div class="field-row">
          <input id="srcPath" v-model="store.state.srcPath" type="text"
                 placeholder="自动检测，或手动选择相机盘符 / DCIM 文件夹" />
          <button title="手动选择文件夹" @click="store.browseSource()">浏览…</button>
          <button title="重新扫描 USB 相机 / 读卡器" @click="store.detectAuto()">自动检测</button>
        </div>
        <label class="check">
          <input type="checkbox" v-model="store.state.dcimOnly" />
          只扫描 DCIM 文件夹（推荐，跳过相机的系统文件）
        </label>
      </div>

      <div class="field">
        <span class="field-label">复制行为</span>
        <div class="field-row wrap">
          <button @click="openCopyOptions">复制选项…</button>
          <span class="hint">保存位置在点「一键复制」时选择</span>
        </div>
      </div>

      <div class="hint">文件类型、时间范围与两个复制开关都在列表上方的筛选条里调整。</div>
    </div>
  </aside>
</template>
