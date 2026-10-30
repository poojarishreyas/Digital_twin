import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins: [react()],
  // three.js is large and changes rarely; keep it in its own long-cached chunk.
  build: {rollupOptions: {output: {manualChunks: {three: ['three']}}}, chunkSizeWarningLimit: 700},
  server: {proxy: {'/api': 'http://localhost:8080', '/healthz': 'http://localhost:8080'}},
})
