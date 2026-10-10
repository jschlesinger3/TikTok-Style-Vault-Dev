import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev: /api is proxied to the backend. Prod: set VITE_API_URL at build time.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:8000' } },
})
