// main.ts —— 渲染进程入口（Vue3 + TS）
// 创建 Vue 应用、挂载根组件 App，并引入全局样式。
// 注意：渲染进程仍然只通过 window.api（preload 暴露）与主进程通信，不直接访问 Node。

import { createApp } from 'vue'
import App from './App.vue'
import './assets/main.css'

createApp(App).mount('#app')
