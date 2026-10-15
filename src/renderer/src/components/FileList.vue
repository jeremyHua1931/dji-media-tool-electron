<script setup lang="ts">
// FileList.vue —— 结果列表（详细信息表格 / 图标网格）
// 负责：排序表头、选择交互（单击 / Ctrl / Shift）、双击打开、空提示、
//       以及可见项的缩略图入队（取到后 Vue 自动更新 <img :src>）。
import { computed, nextTick, onMounted, watch } from 'vue'
import { useStore } from '../composables/useStore'
import type { MediaFile } from '../composables/useStore'
import { fmtTime, kindLabel, kindClass, formatSize, placeholderSVG } from '../utils/format'

const store = useStore()
// 顶层解构 computed：模板里直接使用会自动解包
const { sortedFiles } = store

// 当前是否详细信息视图 / 当前视图规格
const isDetail = computed(() => store.state.view === 'detail')
const spec = computed(() => store.state.ICON_SPEC[store.state.view] || store.state.ICON_SPEC.icon_medium)

// 表头排序箭头
function arrow(key: string): string {
  if (store.state.sortKey !== key) return ''
  return store.state.sortDir === 'asc' ? ' ▲' : ' ▼'
}

// ---------- 选择 / 双击 ----------
function onListClick(e: MouseEvent): void {
  const el = (e.target as HTMLElement).closest('[data-id]')
  if (!el) {
    // 点空白处 = 取消选中（符合资源管理器习惯，未选 = 复制全部）
    if (e.target instanceof HTMLElement && e.target.closest('.list-wrap') && store.selection.size) store.clearSelection()
    return
  }
  store.handleListClick(el.getAttribute('data-id') || '', { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })
}
function onListDoubleClick(e: MouseEvent): void {
  const el = (e.target as HTMLElement).closest('[data-id]')
  if (el) openPath(el.getAttribute('data-id') || '')
}
async function openPath(p: string): Promise<void> {
  const err = await window.api.openPath(p)
  if (err) store.showError('无法用系统默认应用打开：\n' + err)
}

// ---------- 缩略图 ----------
// 当前视图尺寸下请求全部可见项的缩略图（幂等：已取到的路径不会重复入队）
function requestVisibleThumbs(): void {
  const size = isDetail.value ? store.state.ICON_SPEC.detail.thumb : spec.value.thumb
  for (const f of sortedFiles.value) {
    store.thumbs.requestThumb({ path: f.path, size, kind: f.kind })
  }
}
// 初始 + 每次 files/view 变化后（等 DOM 就绪再请求）
onMounted(requestVisibleThumbs)
watch(
  () => [store.state.files, store.state.view],
  () => nextTick(requestVisibleThumbs)
)

// 某文件的缩略图 URL（未取到返回 undefined，模板回退占位 SVG）
function thumbFor(f: MediaFile, size: number): string | undefined {
  return store.thumbs.thumbUrls[`${f.path}\u0001${size}`]
}
</script>

<template>
  <div class="list-wrap" @click="onListClick" @dblclick="onListDoubleClick">
    <!-- 详细信息表格 -->
    <table v-if="isDetail" class="detail-view">
      <thead>
        <tr>
          <th class="left" @click="store.toggleSort('name')">文件名<span class="arrow">{{ arrow('name') }}</span></th>
          <th class="left" @click="store.toggleSort('mtime')">拍摄时间<span class="arrow">{{ arrow('mtime') }}</span></th>
          <th class="center" @click="store.toggleSort('kind')">类型<span class="arrow">{{ arrow('kind') }}</span></th>
          <th class="right" @click="store.toggleSort('size')">大小<span class="arrow">{{ arrow('size') }}</span></th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="f in sortedFiles"
          :key="f.path"
          :data-id="f.path"
          :class="{ selected: store.selection.has(f.path) }"
        >
          <td>
            <div class="file-name">
              <img class="mini" :src="thumbFor(f, store.state.ICON_SPEC.detail.thumb) || placeholderSVG(f.kind, 22)" alt="" />
              <span>{{ f.name }}</span>
            </div>
          </td>
          <td>{{ fmtTime(f.mtime) }}</td>
          <td class="center"><span :class="kindClass(f.kind)">{{ kindLabel(f.kind) }}</span></td>
          <td class="right">{{ formatSize(f.size) }}</td>
        </tr>
      </tbody>
    </table>

    <!-- 图标网格 -->
    <div v-else class="icon-view" :style="{ gridTemplateColumns: `repeat(auto-fill, minmax(${spec.cellW}px, 1fr))` }">
      <div
        v-for="f in sortedFiles"
        :key="f.path"
        class="icon-cell"
        :data-id="f.path"
        :class="{ selected: store.selection.has(f.path) }"
        :style="{ height: `${spec.cellH}px` }"
      >
        <div class="thumb">
          <img :width="spec.thumb" :height="spec.thumb"
               :src="thumbFor(f, spec.thumb) || placeholderSVG(f.kind, spec.thumb)" alt="" />
        </div>
        <div class="cap" :title="f.name">{{ f.name }}</div>
      </div>
    </div>

    <!-- 空提示 -->
    <div v-if="!store.state.files.length" class="empty-tip">
      还没有结果。点右上角「显示选项」设置来源后扫描，这里会列出匹配到的照片 / 视频。
    </div>
  </div>
</template>
