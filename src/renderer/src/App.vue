<script setup lang="ts">
// App.vue —— 应用根组件
// 组装：相机提示 / 顶栏 / 结果主区(工具栏+素材文件夹+筛选条+列表) / 预览窗格 / 状态栏 / 抽屉 / 弹窗。
// 视图切换按钮放在结果区顶部工具栏（results-bar），与旧版一致。
import { computed, onMounted } from 'vue'
import { useStore } from './composables/useStore'
import CameraNotice from './components/CameraNotice.vue'
import TopBar from './components/TopBar.vue'
import SourceFolderBar from './components/SourceFolderBar.vue'
import FilterBar from './components/FilterBar.vue'
import FileList from './components/FileList.vue'
import PreviewPane from './components/PreviewPane.vue'
import StatusBar from './components/StatusBar.vue'
import SettingsDrawer from './components/SettingsDrawer.vue'
import OptionsModal from './components/OptionsModal.vue'

const store = useStore()

// 四种视图的定义（key 对应 useStore 里 ICON_SPEC 的键）
const views = [
  { key: 'detail', label: '详细信息' },
  { key: 'icon_large', label: '大图标' },
  { key: 'icon_medium', label: '中图标' },
  { key: 'icon_small', label: '小图标' },
]

// 已选信息（未选 = 复制全部）
const selInfo = computed(() =>
  store.selection.size
    ? `已选 ${store.selection.size} 项（复制时只复制选中项；未选则复制全部）`
    : '')

// 应用启动：自动检测来源 + 初始化（失败时给出使用提示）
onMounted(() => { store.init() })
</script>

<template>
  <CameraNotice />
  <TopBar />

  <div class="panes" :class="{ 'preview-off': !store.state.previewOpen }">
    <main class="results">
      <!-- 结果区工具栏：查看方式 + 提示 + 已选信息 -->
      <div class="results-bar">
        <span class="label">查看</span>
        <div class="seg">
          <button
            v-for="v in views"
            :key="v.key"
            :class="{ active: store.state.view === v.key }"
            @click="store.setView(v.key)"
          >{{ v.label }}</button>
        </div>
        <span class="hint hint-shrink" title="单击选中（Ctrl/Shift 多选），双击用系统默认应用打开">单击选中（Ctrl/Shift 多选），双击打开</span>
        <span class="sel-info">{{ selInfo }}</span>
      </div>

      <SourceFolderBar />
      <FilterBar />
      <FileList />
    </main>

    <PreviewPane />
  </div>

  <StatusBar />
  <SettingsDrawer />
  <OptionsModal />
</template>
