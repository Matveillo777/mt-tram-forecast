import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In dev and preview the API is proxied to a locally running backend (API_URL overrides the address).
// Host is kept as is, so the backend sees POSTs from the page as same-origin
const api = { '/api': { target: process.env.API_URL ?? 'http://localhost:8080' } }

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: api },
  preview: { port: 4173, proxy: api },
  // maplibre runs its worker as an ES module that imports a shared chunk
  worker: { format: 'es' },
  build: { chunkSizeWarningLimit: 1200 },
})
