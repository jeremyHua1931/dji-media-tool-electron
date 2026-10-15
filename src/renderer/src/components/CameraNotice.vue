<script setup lang="ts">
// CameraNotice.vue —— 相机只读提示条
// 检测到来源是相机/存储卡时出现，明确告知「只读」并提醒安全弹出。
import { computed } from 'vue'
import { useStore } from '../composables/useStore'

const store = useStore()

const visible = computed(() => store.state.cameras && store.state.cameras.length > 0)
const cameraName = computed(() => {
  const cams = store.state.cameras
  if (!cams.length) return ''
  const cam = cams[0]
  return cam.name && cam.name !== cam.root ? `${cam.name}（${cam.root}）` : cam.root
})

// 关闭提示（只隐藏，不影响任何状态）
function dismiss() { store.state.cameras = [] }

// 安全拔出指引：不代跑 diskpart/eject 等命令，只给系统操作指引（只读原则同样适用于系统层）
function showEjectTip() {
  store.showError('请用系统「安全弹出」再拔线：\n'
    + 'Windows：任务栏右下角「安全删除硬件并弹出媒体」→ 选择相机；\n'
    + 'macOS：访达侧边栏相机旁的 ⏏ 按钮。\n\n'
    + '复制完成后本工具不会再访问相机，安全弹出不会失败。')
}
</script>

<template>
  <div v-if="visible" class="camera-notice">
    <span class="cn-icon" aria-hidden="true">🔒</span>
    <span class="cn-text">
      已识别到相机/存储卡：{{ cameraName }}。本工具全程只读，不会删除或修改相机里的任何文件；复制完成后请用系统「安全弹出」再拔线。
    </span>
    <button class="ghost" @click="showEjectTip">怎么安全拔出？</button>
    <button class="ghost cn-close" title="知道了" @click="dismiss">✕</button>
  </div>
</template>
