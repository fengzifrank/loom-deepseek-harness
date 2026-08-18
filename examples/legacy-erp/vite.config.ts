import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// /~loom 同源代理到 loom dev 的智能体服务（4640，SSE 流式直通）。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/~loom': { target: 'http://127.0.0.1:4640', changeOrigin: false },
    },
  },
})
