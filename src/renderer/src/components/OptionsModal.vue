<script setup lang="ts">
// OptionsModal.vue —— 复制选项弹窗（点「一键复制」第一步弹出）
// 表单用本地 reactive，打开时从 store 当前设置填充；确认时整体写回 store。
import { reactive, watch } from 'vue'
import { useStore } from '../composables/useStore'
import type { CopyOptions } from '../composables/useStore'

const store = useStore()

// 本地表单（未确认前不影响 store 的真实设置）
const form = reactive<CopyOptions>({
  conflict: 'skip',
  byDate: false,
  openAfter: true,
  onlyNew: true,
  verify: true,
})

// 打开弹窗时用当前设置回填表单
watch(
  () => store.state.copyModalOpen,
  (open) => { if (open) Object.assign(form, store.state.copyOptions) }
)

// 确认：把表单整包写回 store，并放行复制流程（resolve true）
function confirm(): void {
  store.updateCopyOptions({ ...form })
  store.resolveCopyModal(true)
}

// 取消：不放行流程（resolve false）
function cancel(): void { store.resolveCopyModal(false) }
</script>

<template>
  <div v-if="store.state.copyModalOpen" class="modal-mask" @click.self="cancel">
    <div class="modal" role="dialog" aria-modal="true" aria-label="复制选项">
      <div class="modal-title">复制选项</div>
      <div class="modal-body">
        <div class="opt-group">同名文件（撞名时怎么办）</div>
        <label><input type="radio" name="conflict" value="skip" v-model="form.conflict" /> 跳过（目标已存在就不动它）</label>
        <label><input type="radio" name="conflict" value="overwrite" v-model="form.conflict" /> 覆盖（用相机里的版本替换）</label>
        <label><input type="radio" name="conflict" value="rename" v-model="form.conflict" /> 自动改名（存为 xxx (1).jpg）</label>

        <div class="opt-group">写入方式</div>
        <label class="block"><input type="checkbox" v-model="form.byDate" /> 按拍摄日期建子文件夹（如 2026-10-14/）</label>
        <label class="block"><input type="checkbox" v-model="form.onlyNew" /> 只复制新文件（目标里已有同名同大小的就跳过）</label>
        <label class="block"><input type="checkbox" v-model="form.verify" /> 复制后校验（逐个比对大小，不一致就删除并计为失败）</label>
        <label class="block"><input type="checkbox" v-model="form.openAfter" /> 复制完成后打开目标文件夹</label>
      </div>
      <div class="modal-footer">
        <button @click="cancel">取消</button>
        <button class="primary" @click="confirm">下一步：选择保存位置</button>
      </div>
    </div>
  </div>
</template>
