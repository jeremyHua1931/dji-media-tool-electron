<script setup lang="ts">
// TopBar.vue —— 顶栏
// 品牌 + 参数摘要（一行显示当前条件与命中数）+ 预览/选项/扫描/复制/取消 主操作。
import { useStore } from '../composables/useStore'

const store = useStore()
// 顶层解构 computed：模板里直接使用会自动解包，类型检查也更准确
const { paramSummary } = store
</script>

<template>
  <header class="topbar">
    <div class="brand">
      <span class="logo">DJI</span>
      <span class="title">素材筛选复制工具</span>
    </div>

    <!-- 参数摘要：条件 + 命中数，超宽自动省略 -->
    <div class="param-summary" :title="paramSummary">{{ paramSummary }}</div>

    <button
      class="ghost"
      :class="{ active: store.state.previewOpen }"
      title="显示 / 隐藏右侧预览窗格"
      @click="store.state.previewOpen = !store.state.previewOpen"
    >{{ store.state.previewOpen ? '预览' : '显示预览' }}</button>

    <button class="ghost" title="显示 / 收起右侧选项抽屉" @click="store.setDrawer(!store.state.drawerOpen)">
      {{ store.state.drawerOpen ? '收起选项' : '显示选项' }}
    </button>

    <button class="primary" title="按当前条件重新扫描" @click="store.runScan({ auto: false })">扫描匹配文件</button>

    <button title="点击后选择保存位置，再开始复制" @click="store.startCopyFlow()">一键复制</button>

    <button :disabled="!store.state.busy" title="中止正在进行的复制" @click="store.cancelCopy()">取消</button>
  </header>
</template>
