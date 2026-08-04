import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 9006,
    host: '0.0.0.0',
    allowedHosts: ['webtopup.local.test'],
    proxy: {
      '/api': {
        target: 'http://localhost:9005',
        changeOrigin: true,
      },
      '/uploads': {
        target: 'http://localhost:9005',
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 9006,
  },
})
