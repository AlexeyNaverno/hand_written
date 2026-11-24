import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // relative paths: the same build works in the Android wrapper and from any static server
  base: './',
  plugins: [react()],
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  server: { host: '0.0.0.0', port: 5173, allowedHosts: true },
  preview: { host: '0.0.0.0', port: 4173, allowedHosts: true },
  test: { include: ['tests/**/*.test.ts'] },
} as never);
