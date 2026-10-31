/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const backend = process.env.LIVE_BACKEND_URL ?? 'http://127.0.0.1:8000';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      // FastAPI backend (make dev). Path prefix is stripped.
      '/backend': { target: backend, changeOrigin: true, rewrite: (p) => p.replace(/^\/backend/, '') },
    },
  },
  worker: { format: 'es' },
  test: { environment: 'jsdom', include: ['tests/unit/**/*.test.ts'] },
});
