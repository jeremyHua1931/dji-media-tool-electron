<script setup lang="ts">
// PreviewPane.vue —— 右侧预览窗格
// 未选中：提示；多选：汇总；单选：占位图 + 真实缩略图（预览队列插队优先）+ 文件信息与操作。
import { computed, watch } from 'vue'
import { useStore } from '../composables/useStore'
import type { MediaFile } from '../composables/useStore'
import { fmtTime, kindLabel, formatSize, placeholderSVG } from '../utils/format'

const store = useStore()

// 预览大图的缩略图尺寸（主进程按此出图）
const PREVIEW_SIZE = 144

const single = computed<MediaFile | undefined>(() =>
  store.selection.size === 1
    ? store.state.files.find((f) => store.selection.has(f.path))
    : undefined)

// 多选时被选中的文件列表（用于汇总体积/类型）
const selected = computed<MediaFile[]>(() =>
  single.value ? [single.value] : store.state.files.filter((f) => store.selection.has(f.path)))

const multiCount = computed(() => store.selection.size)
const photosCount = computed(() => selected.value.filter((f) => f.kind === 'photo').length)
const totalSize = computed(() => selected.value.reduce((s, f) => s + (f.size || 0), 0))

const badge = computed(() =>
  single.value ? kindLabel(single.value.kind) : (multiCount.value ? '多选' : ''))

const emptyText = computed(() =>
  store.state.files.length ? '选中一个文件以查看预览' : '扫描后选中文件即可预览')

// 单选时请求预览大图（preview: true，插队优先）
watch(
  () => (single.value ? single.value.path : null),
  (p) => { if (p) store.thumbs.requestThumb({ path: p, size: PREVIEW_SIZE, preview: true }) }
)

const thumbUrl = computed<string | undefined>(() =>
  single.value ? store.thumbs.thumbUrls[`${single.value.path}\u0001${PREVIEW_SIZE}`] : undefined)

async function openFile(): Promise<void> {
  if (!single.value) return
  const err = await window.api.openPath(single.value.path)
  if (err) store.showError('无法用系统默认应用打开：\n' + err)
}
// 在文件管理器中定位（系统不支持时静默）
async function revealFile(): Promise<void> {
  if (!single.value) return
  await window.api.revealPath(single.value.path)
}
</script>

<template>
  <aside class="preview-pane" aria-label="预览">
    <div class="preview-head">
      <span class="preview-title">预览</span>
      <span class="preview-badge">{{ badge }}</span>
      <button class="ghost preview-close" title="关闭预览窗格" @click="store.state.previewOpen = false">✕</button>
    </div>

    <div class="preview-body-wrap">
      <div v-if="!single && !selected.length" class="preview-empty">{{ emptyText }}</div>

      <div v-else class="preview-body">
        <!-- 多选：只汇总，不展示单文件信息 -->
        <template v-if="!single">
          <div class="pv-name">已选中 {{ multiCount }} 个文件</div>
          <dl class="pv-facts">
            <dt>类型</dt><dd>{{ photosCount }} 个照片 / {{ multiCount - photosCount }} 个视频</dd>
            <dt>大小</dt><dd>{{ formatSize(totalSize) }}</dd>
          </dl>
        </template>

        <!-- 单选：缩略图 + 信息 + 操作 -->
        <template v-else>
          <div class="preview-thumb-box">
            <img :src="thumbUrl || placeholderSVG(single.kind, 96)" alt="预览图" />
          </div>
          <div class="pv-name">{{ single.name }}</div>
          <dl class="pv-facts">
            <dt>类型</dt><dd>{{ kindLabel(single.kind) }}</dd>
            <dt>拍摄时间</dt><dd>{{ fmtTime(single.mtime) }}</dd>
            <dt>大小</dt><dd>{{ formatSize(single.size) }}</dd>
            <dt>完整路径</dt><dd class="pv-path">{{ single.path }}</dd>
          </dl>
          <div class="pv-actions">
            <button @click="openFile">打开文件</button>
            <button title="在文件管理器中定位" @click="revealFile">在文件夹中显示</button>
          </div>
        </template>
      </div>
    </div>
  </aside>
</template>
