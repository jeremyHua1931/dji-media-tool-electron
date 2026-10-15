<script setup lang="ts">
// FilterBar.vue —— 列表上方的筛选条
// 文件类型（全部/照片/视频）· 时间快捷档 · 日期区间 · 两个复制开关 · 刷新/重置。
// 条件一旦变化（type/date 由 v-model 直接改 state），useStore 的 watch 会自动重扫。
import { computed } from 'vue'
import { useStore } from '../composables/useStore'

const store = useStore()
// 顶层解构 computed：模板里直接使用会自动解包
const { hasActiveFilter } = store

const quickButtons = [
  { key: 'today', label: '今天' },
  { key: '1', label: '一天' },
  { key: '3', label: '三天' },
  { key: '7', label: '七天' },
  { key: 'clear', label: '不限' },
]

// 应用快捷档：quickRange 返回 [起始, 结束]，再写入日期输入
function applyQuick(key: string): void {
  const [d1, d2] = store.quickRange(key)
  store.setDateRange(d1, d2)
}

// 「重置筛选」只在确实有条件生效时才是可点状态
const activeSuffix = (): string => (hasActiveFilter.value ? `（${hasActiveFilter.value} 项生效）` : '')
const resetStyle = computed(() => ({
  opacity: hasActiveFilter.value ? 1 : 0.4,
  pointerEvents: (hasActiveFilter.value ? 'auto' : 'none') as 'auto' | 'none',
}))
</script>

<template>
  <div class="filters">
    <span class="filter-label">文件类型</span>
    <div class="chips">
      <label class="chip"><input type="radio" name="fType" value="both" v-model="store.state.fType" /><span>全部</span></label>
      <label class="chip"><input type="radio" name="fType" value="photo" v-model="store.state.fType" /><span>仅照片</span></label>
      <label class="chip"><input type="radio" name="fType" value="video" v-model="store.state.fType" /><span>仅视频</span></label>
    </div>

    <span class="filter-label">时间</span>
    <div class="chips">
      <button v-for="b in quickButtons" :key="b.key" type="button" @click="applyQuick(b.key)">{{ b.label }}</button>
    </div>

    <div class="chips">
      <input id="dateFrom" v-model="store.state.dateFrom" type="text" class="date"
             placeholder="YYYY-MM-DD" title="起始日期，留空 = 不限" />
      <span class="chips-dash">~</span>
      <input id="dateTo" v-model="store.state.dateTo" type="text" class="date"
             placeholder="YYYY-MM-DD" title="结束日期，留空 = 不限" />
    </div>

    <div class="chips">
      <label class="chip" title="目标文件夹里已有同名同大小的文件就跳过，重复运行不会翻倍">
        <input type="checkbox" v-model="store.state.copyOptions.onlyNew" /><span>只复制新文件</span>
      </label>
      <label class="chip" title="复制后逐个比对文件大小，不一致就删除并计入失败">
        <input type="checkbox" v-model="store.state.copyOptions.verify" /><span>复制后校验</span>
      </label>
    </div>

    <div class="filter-tail">
      <span class="refresh-state" title="条件变化后会自动重新扫描">{{ store.state.refreshState }}</span>
      <button class="ghost refresh-btn" title="立即重新扫描" @click="store.runScan({ auto: true, silent: false })">刷新</button>
      <span class="filter-reset" title="清空时间、恢复“全部”" :style="resetStyle" @click="store.resetFilter()">
        重置筛选{{ activeSuffix() }}
      </span>
    </div>
  </div>
</template>
