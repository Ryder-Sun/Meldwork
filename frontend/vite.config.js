import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(() => ({
  base: './',
  plugins: [vue()],
  server: {
    port: 24604,
  },
  build: {
    outDir: 'dist',
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'vendor', test: /node_modules[\\/]/ },
          ],
        },
      },
    },
  },
}))
