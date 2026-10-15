<script setup lang="ts">
// SourceFolderBar.vue —— 素材文件夹栏
// 展示素材实际所在的文件夹 + 文件数 + 「打开文件夹」按钮，超限时折叠提示。
import { useStore } from '../composables/useStore'

const store = useStore()
// 顶层解构 computed：模板里直接使用会自动解包
const { mediaFolders } = store

// 展示前几个文件夹（复制时最关心的），其余折叠
const MAX_ROWS = 3

async function openFolder(dir: string): Promise<void> {
  const err = await window.api.openPath(dir)
  if (err) store.showError('无法打开文件夹：\n' + err)
}
</script>

<template>
  <div v-if="store.state.files.length" class="source-folder">
    <span class="sf-label">素材文件夹</span>
    <div class="sf-list">
      <div v-for="item in mediaFolders.slice(0, MAX_ROWS)" :key="item.dir" class="sf-item">
        <span class="sf-path" :title="item.dir">{{ item.dir }}</span>
        <span class="sf-count">{{ item.count }} 个文件</span>
        <button class="sf-open" @click="openFolder(item.dir)">打开文件夹</button>
      </div>
      <div v-if="mediaFolders.length > MAX_ROWS" class="sf-more">
        另有 {{ mediaFolders.length - MAX_ROWS }} 个文件夹（共 {{ mediaFolders.length }} 个）
      </div>
    </div>
  </div>
</template>
