import { beforeAll, describe, expect, it } from 'vitest';
import { area, bbox } from './geometry';
import { detectOutline, detectRooms, orthogonalize, type OpenCV, type RasterPlan } from './roomDetect';

let cv: OpenCV;

beforeAll(async () => {
  // Через require, а не import: иначе vitest пытается преобразовать 10-мегабайтный файл и зависает.
  // Имя модуля строкой: типов Node в проекте нет, а тест всё равно идёт в Node.
  const { createRequire } = await import('node:module' as string);
  const m = createRequire(import.meta.url)('@techstark/opencv-js') as OpenCV;
  // Модуль OpenCV — «thenable», поэтому в промис его кладём обёрнутым, иначе await зациклится.
  cv = (
    await new Promise<{ cv: OpenCV }>((resolve) => {
      if (m.Mat) resolve({ cv: m });
      else m.onRuntimeInitialized = () => resolve({ cv: m });
    })
  ).cv;
}, 60_000);

/** Рисовалка синтетического плана: белый лист, чёрные прямоугольники. 10 мм на пиксель. */
function sheet(w: number, h: number) {
  const g = new Uint8Array(w * h).fill(255);
  const box = (x0: number, y0: number, x1: number, y1: number, v = 0) => {
    for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) g[y * w + x] = v;
  };
  const toPlan = (): RasterPlan => {
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = g[i];
      rgba[i * 4 + 3] = 255;
    }
    return { width: w, height: h, rgba, mmPerPx: 10 };
  };
  return { box, toPlan };
}

const m2 = (poly: { x: number; y: number }[]) => area(poly) / 1e6;

describe('распознавание помещений', () => {
  it('находит две комнаты с дверью между ними, не обращая внимания на текст и мебель', async () => {
    // Квартира 8×5 м: наружные стены 250 мм, перегородка 120 мм на x = 4 м с дверью 900 мм.
    const s = sheet(900, 600);
    s.box(50, 50, 850, 75); // верх
    s.box(50, 525, 850, 550); // низ
    s.box(50, 50, 75, 550); // лево
    s.box(825, 50, 850, 550); // право
    s.box(444, 75, 456, 300); // перегородка до двери
    s.box(444, 390, 456, 525); // перегородка после двери
    // «Текст» и мебель тонкими линиями: не должны дробить комнату.
    for (let i = 0; i < 6; i++) s.box(150 + i * 12, 200, 152 + i * 12, 220);
    s.box(600, 150, 760, 152);
    s.box(600, 150, 602, 260);
    // Дуга двери, упрощённо — тонкая диагональ из точек.
    for (let i = 0; i < 80; i++) s.box(456 + i, 390 - i, 458 + i, 392 - i);

    const res = await detectRooms(cv, s.toPlan());
    expect(res.rooms).toHaveLength(2);
    const areas = res.rooms.map((r) => m2(r.poly)).sort((a, b) => a - b);
    // Левая: 3,69 × 4,5 = 16,6 м²; правая: 3,69 × 4,5 = 16,6 м² (по внутренним граням).
    for (const a of areas) expect(a).toBeGreaterThan(15.5);
    for (const a of areas) expect(a).toBeLessThan(17.5);
    for (const r of res.rooms) expect(r.poly).toHaveLength(4);
  }, 30_000);

  it('Г-образная комната получает шесть углов', async () => {
    const s = sheet(700, 700);
    // Контур Г: внешняя стена толщиной 20 px.
    s.box(50, 50, 650, 70);
    s.box(50, 50, 70, 650);
    s.box(50, 630, 350, 650);
    s.box(330, 330, 350, 650);
    s.box(330, 330, 650, 350);
    s.box(630, 50, 650, 350);
    const res = await detectRooms(cv, s.toPlan());
    expect(res.rooms).toHaveLength(1);
    expect(res.rooms[0].poly).toHaveLength(6);
  }, 30_000);

  it('заливает стены, нарисованные двумя тонкими линиями', async () => {
    const s = sheet(800, 600);
    const outline = (x0: number, y0: number, x1: number, y1: number) => {
      s.box(x0, y0, x1, y0 + 2);
      s.box(x0, y1 - 2, x1, y1);
      s.box(x0, y0, x0 + 2, y1);
      s.box(x1 - 2, y0, x1, y1);
    };
    // Наружная стена 220 мм — два контура, внутри пустота. Перегородка 120 мм — две линии от стены до стены.
    outline(50, 50, 750, 550);
    outline(72, 72, 728, 528);
    s.box(395, 72, 397, 528);
    s.box(405, 72, 407, 528);
    const res = await detectRooms(cv, s.toPlan());
    expect(res.rooms).toHaveLength(2);
    for (const r of res.rooms) expect(m2(r.poly)).toBeGreaterThan(14);
  }, 30_000);

  it('комната с панорамным окном находится, когда задана граница дома', async () => {
    // Комната 4,6 × 4,6 м, внизу окно 3 м — шире предела для проёмов (2,4 м).
    const s = sheet(600, 600);
    s.box(50, 50, 550, 70);
    s.box(50, 50, 70, 550);
    s.box(530, 50, 550, 550);
    s.box(50, 530, 150, 550);
    s.box(450, 530, 550, 550);
    for (let i = 0; i < 3; i++) s.box(150, 535 + i * 6, 450, 536 + i * 6); // переплёт окна тонкими линиями
    const plan = s.toPlan();
    expect((await detectRooms(cv, plan)).rooms).toHaveLength(0); // без границы утекает наружу

    const outline = await detectOutline(cv, plan);
    expect(outline).not.toBeNull();
    const b = bbox(outline!);
    expect(b.minX).toBeCloseTo(500, -2);
    expect(b.maxX).toBeCloseTo(5500, -2);
    expect(b.maxY).toBeCloseTo(5500, -2);
    expect(outline).toHaveLength(4);

    const res = await detectRooms(cv, plan, { boundary: outline! });
    expect(res.rooms).toHaveLength(1);
    expect(m2(res.rooms[0].poly)).toBeGreaterThan(20.5);
    expect(m2(res.rooms[0].poly)).toBeLessThan(21.6);
    expect(res.rooms[0].poly).toHaveLength(4); // без «кармана» в проёме окна
  }, 30_000);
});

describe('выпрямление контура', () => {
  it('сводит почти прямые стороны к осям и убирает лишние вершины', () => {
    const p = orthogonalize([
      { x: 0, y: 0 },
      { x: 50, y: 1 },
      { x: 100, y: 2 },
      { x: 101, y: 80 },
      { x: 1, y: 79 },
    ]);
    expect(p).toHaveLength(4);
    const b = bbox(p);
    expect(b.maxX - b.minX).toBeGreaterThan(98);
    for (let i = 0; i < p.length; i++) {
      const a = p[i];
      const c = p[(i + 1) % p.length];
      expect(a.x === c.x || a.y === c.y).toBe(true);
    }
  });
});
