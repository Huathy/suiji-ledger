import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: [
      // merge-driver.ts 首行 import path from 'node:path'：浏览器垫 basename 即可
      { find: /^node:path$/, replacement: resolve(here, 'src/local/node-path-shim.ts') },
      // 离线同步复用服务端纯函数（ledger/merge-driver/mappers/keep-commits/schedule），
      // 除 node:path 外无框架依赖，浏览器可直接打包。alias 保证构建期可解析。
      { find: /^@server-sync\/(.*)$/, replacement: resolve(here, '../server/src/sync/$1') },
    ],
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000' },
    fs: { allow: [here, resolve(here, '..')] },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1200,
  },
})
