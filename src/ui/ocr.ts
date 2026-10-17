import type { OcrWord } from '../engine/roomLabels';
import type { Box, PlanImage, Pt } from '../engine/types';

// Tesseract.js типизирован, но тянуть его типы в основной бандл незачем: модуль грузится динамически.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Worker = any;

let loading: Promise<Worker> | null = null;

const vendor = (p: string) => new URL(`vendor/tesseract/${p}`, document.baseURI).href;

/** Запускает распознавание текста (русский язык) один раз за сеанс. onProgress получает долю 0..1. */
export function loadOcr(onProgress: (f: number) => void): Promise<Worker> {
  if (loading) return loading;
  loading = (async () => {
    const { createWorker } = await import('tesseract.js');
    // Этапы загрузки: ядро → язык → запуск. Каждый сообщает свой прогресс 0..1.
    const share: Record<string, [number, number]> = {
      'loading tesseract core': [0, 0.55],
      'loading language traineddata': [0.55, 0.4],
      'initializing api': [0.95, 0.05],
    };
    const worker = await createWorker('rus', 1, {
      workerPath: vendor('worker.min.js'),
      corePath: vendor('core/'),
      langPath: vendor('lang'),
      logger: (m: { status: string; progress: number }) => {
        const s = share[m.status];
        if (s) onProgress(s[0] + s[1] * m.progress);
      },
    });
    return worker;
  })();
  loading.catch(() => (loading = null));
  return loading;
}

const images = new Map<string, Promise<HTMLImageElement>>();
function decoded(image: PlanImage): Promise<HTMLImageElement> {
  let p = images.get(image.dataUrl);
  if (!p) {
    const img = new Image();
    img.src = image.dataUrl;
    p = img.decode().then(() => img);
    images.clear(); // держим только текущую подложку
    images.set(image.dataUrl, p);
  }
  return p;
}

/**
 * Распознаёт текст в прямоугольнике плана (мм). mask — контур помещения: всё за ним закрашивается белым,
 * чтобы не читать подписи соседних комнат. psm — режим Tesseract: 11 — разрозненный текст, 6 — один блок.
 * Возвращает слова с рамками в мм.
 */
export async function ocrBox(worker: Worker, image: PlanImage, box: Box, psm: 6 | 11, mask?: Pt[]): Promise<OcrWord[]> {
  const img = await decoded(image);
  const k = image.mmPerPx;
  const sx = Math.max(0, Math.floor(box.x / k));
  const sy = Math.max(0, Math.floor(box.y / k));
  const sw = Math.min(image.widthPx - sx, Math.ceil(box.w / k));
  const sh = Math.min(image.heightPx - sy, Math.ceil(box.h / k));
  if (sw < 4 || sh < 4) return [];
  // Мелкий шрифт плана распознаётся лучше, если его увеличить.
  const s = Math.min(3, Math.max(1, 1600 / Math.max(sw, sh)));
  const c = document.createElement('canvas');
  c.width = Math.round(sw * s);
  c.height = Math.round(sh * s);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  if (mask) {
    ctx.beginPath();
    mask.forEach((p, i) => ctx[i ? 'lineTo' : 'moveTo']((p.x / k - sx) * s, (p.y / k - sy) * s));
    ctx.closePath();
    ctx.clip();
  }
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
  keepGlyphs(ctx, c.width, c.height, (MAX_GLYPH_MM / k) * s);
  // Поле вокруг: у самого края Tesseract читает плохо.
  const pad = 24;
  const out = document.createElement('canvas');
  out.width = c.width + 2 * pad;
  out.height = c.height + 2 * pad;
  const octx = out.getContext('2d')!;
  octx.fillStyle = '#fff';
  octx.fillRect(0, 0, out.width, out.height);
  octx.drawImage(c, pad, pad);
  await worker.setParameters({ tessedit_pageseg_mode: String(psm) });
  const { data } = await worker.recognize(out, {}, { blocks: true });
  const words: OcrWord[] = [];
  let line = 0;
  for (const b of data.blocks ?? [])
    for (const p of b.paragraphs)
      for (const l of p.lines) {
        for (const w of l.words) {
          const [x0, y0, x1, y1] = [w.bbox.x0 - pad, w.bbox.y0 - pad, w.bbox.x1 - pad, w.bbox.y1 - pad];
          words.push({
            text: w.text,
            conf: w.confidence,
            line,
            box: { x: (sx + x0 / s) * k, y: (sy + y0 / s) * k, w: ((x1 - x0) / s) * k, h: ((y1 - y0) / s) * k },
          });
        }
        line++;
      }
  return words;
}

/** Буква на плане не больше этого (высота подписи при печати в 1:100 — 3–5 мм на листе), мм. */
const MAX_GLYPH_MM = 650;

/**
 * Оставляет на картинке только то, что похоже на буквы: тёмные связные пятна не крупнее maxPx.
 * Линии стен, мебели, дуги дверей — длинные связные фигуры, они стираются и не мешают распознаванию.
 */
function keepGlyphs(ctx: CanvasRenderingContext2D, W: number, H: number, maxPx: number) {
  const im = ctx.getImageData(0, 0, W, H);
  const d = im.data;
  const N = W * H;
  const dark = new Uint8Array(N);
  for (let i = 0; i < N; i++) dark[i] = d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11 < 160 ? 1 : 0;
  const seen = new Uint8Array(N);
  const stack: number[] = [];
  const comp: number[] = [];
  for (let start = 0; start < N; start++) {
    if (!dark[start] || seen[start]) continue;
    let minX = W, maxX = 0, minY = H, maxY = 0;
    comp.length = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      comp.push(i);
      const x = i % W;
      const y = (i - x) / W;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          if (dark[j] && !seen[j]) {
            seen[j] = 1;
            stack.push(j);
          }
        }
    }
    if (maxX - minX > maxPx || maxY - minY > maxPx)
      for (const i of comp) d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = 255;
  }
  ctx.putImageData(im, 0, 0);
}
