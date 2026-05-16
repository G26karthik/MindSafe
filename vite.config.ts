import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), wasm(), topLevelAwait()],
  build: {
    target: 'esnext',
  },
  define: {
    'process.env': JSON.stringify({}),
    global: 'globalThis',
    // Polyfill Buffer for the compiled Compact contract runtime
    Buffer: ['buffer', 'Buffer'],
  },
})
