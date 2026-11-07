import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  // GitHub Pages serves this repository under /cerachat/. Desktop and local
  // development must continue to load assets from the origin root.
  base: mode === 'github-pages' ? '/cerachat/' : '/',
  plugins: [react(), tailwindcss()],
  // Keep the worker's WASM packages out of Vite's dev dependency prebundling.
  optimizeDeps: {
    exclude: ['@sqlite.org/sqlite-wasm', '@bokuweb/zstd-wasm'],
  },
  // The browser database Worker imports ES modules that create split chunks.
  worker: { format: 'es' },
}))
