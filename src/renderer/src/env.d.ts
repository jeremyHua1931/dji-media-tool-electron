/// <reference types="vite/client" />
// env.d.ts —— 渲染进程的环境类型声明（Vue 模板标配）
// ============================================================
// 1. vite/client：为 import.meta.env、静态资源导入（*.css/*.png 等）提供类型；
// 2. *.vue 模块声明：让编辑器能识别 .vue 单文件组件的默认导出（DefineComponent）。

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const component: DefineComponent<{}, {}, any>
  export default component
}
