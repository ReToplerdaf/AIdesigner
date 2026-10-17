import type { OpenCV } from '../engine/roomDetect';
import type { PlanImage } from '../engine/types';
import type { RasterPlan } from '../engine/roomDetect';

declare const __OPENCV_FILE__: string;

/** Модуль OpenCV — «thenable»: если отдать его из промиса как есть, await зациклится. Поэтому он всегда в обёртке. */
type Box = { cv: OpenCV };
let loading: Promise<Box> | null = null;

/**
 * Загружает OpenCV.js один раз за сеанс. onProgress получает долю 0..1, пока качается файл,
 * и null, когда файл скачан и библиотека запускается.
 */
export function loadOpenCV(onProgress: (f: number | null) => void): Promise<Box> {
  const w = window as unknown as { cv?: OpenCV };
  if (w.cv?.Mat) return Promise.resolve({ cv: w.cv });
  if (loading) return loading;
  loading = (async () => {
    const res = await fetch(__OPENCV_FILE__);
    if (!res.ok) throw new Error(`файл библиотеки не найден (${res.status})`);
    const total = Number(res.headers.get('content-length')) || 10_400_000;
    const reader = res.body!.getReader();
    const chunks: Uint8Array[] = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      onProgress(Math.min(1, got / total));
    }
    onProgress(null);
    const url = URL.createObjectURL(new Blob(chunks, { type: 'text/javascript' }));
    await new Promise<void>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = url;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('не удалось запустить библиотеку'));
      document.head.appendChild(s);
    });
    URL.revokeObjectURL(url);
    return new Promise<Box>((resolve) => {
      const cv = w.cv!;
      if (cv.Mat) resolve({ cv });
      else cv.onRuntimeInitialized = () => resolve({ cv });
    });
  })();
  loading.catch(() => (loading = null));
  return loading;
}

/** Пиксели подложки, уменьшенные до maxSide по длинной стороне (для скорости), и их масштаб. */
export async function rasterOf(image: PlanImage, maxSide = 2000): Promise<RasterPlan> {
  const img = new Image();
  img.src = image.dataUrl;
  await img.decode();
  const k = Math.min(1, maxSide / Math.max(image.widthPx, image.heightPx));
  const width = Math.max(1, Math.round(image.widthPx * k));
  const height = Math.max(1, Math.round(image.heightPx * k));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff'; // прозрачный PNG — на белом листе
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height).data;
  return { width, height, rgba: data, mmPerPx: (image.mmPerPx * image.widthPx) / width };
}
