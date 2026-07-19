import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

export default defineConfig(({ command }) => ({
  plugins: [solid()],
  server: {
    port: 5173,
    proxy: {
      '/api/': 'http://localhost:3002',
    },
  },
}))
