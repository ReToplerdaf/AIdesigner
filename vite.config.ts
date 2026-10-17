import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/** OpenCV.js (~10 МБ) кладётся рядом с приложением отдельным файлом и грузится только по кнопке «Анализ». */
export const OPENCV_FILE = 'vendor/opencv-4.10.0.js';

function opencvAsset(): Plugin {
  const path = createRequire(import.meta.url).resolve('@techstark/opencv-js');
  return {
    name: 'opencv-asset',
    configureServer(server) {
      server.middlewares.use(`/${OPENCV_FILE}`, (_req, res) => {
        res.setHeader('Content-Type', 'text/javascript');
        res.end(readFileSync(path));
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: OPENCV_FILE, source: readFileSync(path) });
    },
  };
}

export default defineConfig({
  plugins: [react(), opencvAsset()],
  base: './',
  define: { __OPENCV_FILE__: JSON.stringify(OPENCV_FILE) },
});
