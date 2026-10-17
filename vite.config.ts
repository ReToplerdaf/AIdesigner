import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const require = createRequire(import.meta.url);
const pkgDir = (name: string) => dirname(require.resolve(`${name}/package.json`));

/**
 * Тяжёлые библиотеки распознавания лежат рядом с приложением отдельными файлами (со своего сервера, без CDN)
 * и грузятся браузером только по кнопке: OpenCV.js (~10 МБ) — поиск комнат, Tesseract (~7 МБ) — чтение подписей.
 */
const VENDOR: Record<string, string> = {
  'vendor/opencv-4.10.0.js': require.resolve('@techstark/opencv-js'),
  'vendor/tesseract/worker.min.js': join(pkgDir('tesseract.js'), 'dist/worker.min.js'),
  ...Object.fromEntries(
    ['', 'simd-', 'relaxedsimd-'].map((v) => [
      `vendor/tesseract/core/tesseract-core-${v}lstm.wasm.js`,
      join(pkgDir('tesseract.js-core'), `tesseract-core-${v}lstm.wasm.js`),
    ]),
  ),
  'vendor/tesseract/lang/rus.traineddata.gz': join(pkgDir('@tesseract.js-data/rus'), '4.0.0_best_int/rus.traineddata.gz'),
};

function vendorAssets(): Plugin {
  return {
    name: 'vendor-assets',
    configureServer(server) {
      for (const [file, src] of Object.entries(VENDOR)) {
        server.middlewares.use(`/${file}`, (_req, res) => {
          res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
          res.end(readFileSync(src));
        });
      }
    },
    generateBundle() {
      for (const [file, src] of Object.entries(VENDOR)) this.emitFile({ type: 'asset', fileName: file, source: readFileSync(src) });
    },
  };
}

export default defineConfig({
  plugins: [react(), vendorAssets()],
  base: './',
  define: { __OPENCV_FILE__: JSON.stringify('vendor/opencv-4.10.0.js') },
});
