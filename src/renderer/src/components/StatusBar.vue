<script setup lang="ts">
// StatusBar.vue —— 底部状态栏：进度条 + 状态文案
import { useStore } from '../composables/useStore'

const store = useStore()
// 顶层解构 ref/computed：模板里直接使用会自动解包
const { statusText, progressPct } = store
</script>

<template>
  <footer class="statusbar">
    <div class="progress-bar" aria-hidden="true">
      <div class="progress-fill" :style="{ width: `${progressPct}%` }"></div>
    </div>
    <div class="status" :title="statusText">{{ statusText }}</div>
  </footer>
</template>
