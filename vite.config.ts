import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';

/** The recogniser runtime (WebAssembly) is served as static files next to the app, so it works offline. */
function copyOrt() {
  return {
    name: 'copy-onnxruntime',
    buildStart() {
      const src = path.resolve('node_modules/onnxruntime-web/dist');
      const dst = path.resolve('public/ort');
      fs.mkdirSync(dst, { recursive: true });
      for (const f of ['ort-wasm-simd-threaded.wasm']) {
        const from = path.join(src, f);
        const to = path.join(dst, f);
        if (fs.existsSync(from) && (!fs.existsSync(to) || fs.statSync(to).size !== fs.statSync(from).size)) fs.copyFileSync(from, to);
      }
    },
    closeBundle() {
      // the bundler also emits its own copy of the runtime, which is never loaded
      const assets = path.resolve('dist/assets');
      if (!fs.existsSync(assets)) return;
      for (const f of fs.readdirSync(assets)) if (/^ort-wasm.*\.wasm$/.test(f)) fs.rmSync(path.join(assets, f));
    },
  };
}

export default defineConfig({
  // relative paths: the same build works on GitHub Pages (sub-folder), in the Android wrapper and from any static server
  base: './',
  plugins: [react(), copyOrt()],
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 12000 },
  server: { host: '0.0.0.0', port: 5173, allowedHosts: true },
  preview: { host: '0.0.0.0', port: 4173, allowedHosts: true },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 60000,
    alias: [{ find: '@techstark/opencv-js', replacement: path.resolve('tests/opencv-node.ts') }],
  },
} as never);
