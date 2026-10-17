import { beforeAll, describe, expect, it } from 'vitest';
import { area } from './geometry';
import type { OpenCV, RasterPlan } from './roomDetect';
import { detectRooms } from './roomDetect';
import { growRooms, looksMerged, snapLine, splitByAreas, type AreaMark } from './roomSplit';

let cv: OpenCV;

beforeAll(async () => {
  // Как в roomDetect.test.ts: через require, иначе vitest зависает на 10-мегабайтном файле.
  const { createRequire } = await import('node:module' as string);
  const m = createRequire(import.meta.url)('@techstark/opencv-js') as OpenCV;
  cv = (
    await new Promise<{ cv: OpenCV }>((resolve) => {
      if (m.Mat) resolve({ cv: m });
      else m.onRuntimeInitialized = () => resolve({ cv: m });
    })
  ).cv;
}, 60_000);

/** Комната 7,6 × 3,6 м (27,36 м²) в стенах 200 мм, 10 мм на пиксель; draw дорисовывает границу внутри. */
function plan(draw: (box: (x0: number, y0: number, x1: number, y1: number) => void) => void): RasterPlan {
  const w = 1000;
  const h = 600;
  const g = new Uint8Array(w * h).fill(255);
  const box = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) g[y * w + x] = 0;
  };
  box(50, 50, 850, 70);
  box(50, 430, 850, 450);
  box(50, 50, 70, 450);
  box(830, 50, 850, 450);
  // Подписи «текстом»: короткие штрихи, их нельзя принять за границу.
  for (let i = 0; i < 5; i++) box(240 + i * 10, 240, 242 + i * 10, 260);
  for (let i = 0; i < 5; i++) box(650 + i * 10, 240, 652 + i * 10, 260);
  draw(box);
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = g[i];
    rgba[i * 4 + 3] = 255;
  }
  return { width: w, height: h, rgba, mmPerPx: 10 };
}

const room = [
  { x: 700, y: 700 },
  { x: 8300, y: 700 },
  { x: 8300, y: 4300 },
  { x: 700, y: 4300 },
];
const marks: AreaMark[] = [
  { at: { x: 2600, y: 2500 }, m2: 16.2, box: { x: 2350, y: 2350, w: 500, h: 300 } },
  { at: { x: 6700, y: 2500 }, m2: 11.2, box: { x: 6450, y: 2350, w: 500, h: 300 } },
];
const m2 = (p: { x: number; y: number }[]) => area(p) / 1e6;

describe('смежные помещения без стены', () => {
  it('сумма подписей сходится с площадью — помещения слиты', () => {
    expect(looksMerged(room, marks)).toBe(true);
    expect(looksMerged(room, [marks[0], { ...marks[1], m2: 4 }])).toBe(false);
  });

  it('граница пунктиром: разрез по пунктиру', async () => {
    const p = plan((box) => {
      for (let y = 70; y < 430; y += 30) box(519, y, 521, y + 15);
    });
    // Пунктир тонкий — поиск помещений его стирает, и комната одна.
    expect((await detectRooms(cv, p)).rooms).toHaveLength(1);
    const parts = splitByAreas(p, room, marks);
    expect(parts).toHaveLength(2);
    expect(parts.every((q) => q.ok)).toBe(true);
    const left = parts.find((q) => q.marks[0] === 0)!;
    expect(Math.min(...left.poly.map((q) => q.x))).toBe(700);
    expect(Math.abs(Math.max(...left.poly.map((q) => q.x)) - 5200)).toBeLessThan(30);
  });

  it('граница двумя линиями: разрез посередине', () => {
    const p = plan((box) => {
      box(510, 70, 511, 430);
      box(530, 70, 531, 430);
    });
    const parts = splitByAreas(p, room, marks);
    expect(parts.every((q) => q.ok)).toBe(true);
    const left = parts.find((q) => q.marks[0] === 0)!;
    expect(Math.abs(Math.max(...left.poly.map((q) => q.x)) - 5200)).toBeLessThan(30);
  });

  it('линии нет: разрез не найден, помещения растут одновременно до своих площадей', () => {
    const p = plan(() => {});
    const parts = splitByAreas(p, room, marks);
    expect(parts).toHaveLength(1);
    expect(parts[0].ok).toBe(false);
    const grown = growRooms(cv, p, room, marks)!;
    expect(grown).toHaveLength(2);
    expect(m2(grown[0])).toBeGreaterThan(15.4);
    expect(m2(grown[0])).toBeLessThan(17);
    expect(m2(grown[1])).toBeGreaterThan(10.4);
    expect(m2(grown[1])).toBeLessThan(12);
    for (const g of grown) expect(g).toHaveLength(4);
  });

  it('примерная граница от пользователя выпрямляется и прилипает к линии рядом', () => {
    const p = plan((box) => box(519, 70, 520, 430));
    const [a, b] = snapLine(p, room, { x: 5000, y: 1000 }, { x: 5300, y: 4000 });
    expect(a.x).toBe(b.x);
    expect(Math.abs(a.x - 5200)).toBeLessThan(30);
  });
});
