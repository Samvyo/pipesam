import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  server: {
    https: {
      key:  fs.readFileSync(path.join(__dirname, '../certs/key.pem')),
      cert: fs.readFileSync(path.join(__dirname, '../certs/cert.pem')),
    },
    host: '0.0.0.0',   // ← makes it accessible on your network (phone can reach it)
    port: 5173,
  }
})