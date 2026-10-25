import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Temporary test-harness config. The main dashboard team may replace it
// when wiring the real app; feature code lives in src/lib and src/components.
export default defineConfig({
  plugins: [react()],
  server: {
    // Proxy so browser code can call the Cortex backend same-origin at /api
    // (no CORS complexity in dev). Server: `cd server && npm run dev`.
    proxy: {
      '/api': {
        target: process.env.API_PROXY_TARGET || 'http://localhost:3001',
        changeOrigin: false,
      },
    },
  },
})
