// electron.vite.config.ts —— electron-vite 三段式构建配置（TypeScript 版）
// ============================================================
// electron-vite 把应用拆成三个独立构建目标：
//   - main      ：主进程（Node 侧），externalize 依赖保持产物轻量；
//   - preload   ：预加载桥接（沙箱模式输出 CJS）；
//   - renderer  ：渲染进程（Vue3 + Vite，支持 HMR）。
//
// 约定式入口（electron-vite 自动识别）：
//   src/main/index.ts     -> out/main/index.js
//   src/preload/index.ts  -> out/preload/index.js
//   src/renderer/index.html -> out/renderer/index.html（渲染进程入口）
//   src/renderer/src/**/*.vue 渲染进程源码
//
// 打包时 package.json 的 main 指向 out/main/index.js，electron-builder 打包 out/**。
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  // 主进程：把所有第三方依赖声明为 external（不打进 bundle，运行时从 node_modules 加载），
  // 主进程代码本身只用 Node 内置模块 + electron，产物干净、加载快。
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },

  // preload：同样 externalize；沙箱模式下 preload 必须是 CommonJS，
  // 这里不做额外配置，electron-vite 按项目（非 type:module）输出 CJS。
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },

  // 渲染进程：Vue3 插件 + 路径别名（@renderer 指向渲染源码目录，组件内用别名或相对路径引入）。
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src'),
      },
    },
    plugins: [vue()],
  },
})
