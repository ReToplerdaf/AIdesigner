import { describe, expect, it } from 'vitest';
import { dimensionOf, roomFills, scaleFromAreas, traceDimLine, type Ink } from './dimDetect';

/** Белый лист и чёрные прямоугольники, как в тестах распознавания помещений. */
function sheet(w: number, h: number) {
  const data = new Uint8Array(w * h);
  const box = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) data[y * w + x] = 1;
  };
  const ink: Ink = { width: w, height: h, data };
  return { box, ink };
}

describe('размер из текста', () => {
  it('миллиметры, метры и мусор', () => {
    expect(dimensionOf('10000')).toBe(10000);
    expect(dimensionOf('3 600')).toBe(3600);
    expect(dimensionOf('3,45')).toBe(3450);
    expect(dimensionOf('12.600')).toBe(12600);
    expect(dimensionOf('17,8')).toBeNull();
    expect(dimensionOf('45')).toBeNull();
    expect(dimensionOf('Кухня')).toBeNull();
  });
});

describe('размерная линия', () => {
  it('находит концы по выносным линиям, а не по краю линии', () => {
    const s = sheet(700, 120);
    s.box(50, 60, 651, 61); // линия, чуть заходит за выносные
    s.box(60, 40, 61, 80); // выносная слева, x = 60
    s.box(640, 40, 641, 80); // выносная справа, x = 640
    for (let i = 0; i < 5; i++) s.box(320 + i * 8, 44, 326 + i * 8, 56); // «цифры» над линией
    const l = traceDimLine(s.ink, { x: 320, y: 44, w: 38, h: 12 })!;
    expect(l.a.x).toBe(60);
    expect(l.b.x).toBe(640);
  });

  it('засечки под 45°', () => {
    const s = sheet(700, 120);
    s.box(100, 60, 601, 61);
    for (let i = -6; i <= 6; i++) {
      s.box(100 + i, 60 - i, 101 + i, 61 - i);
      s.box(600 + i, 60 - i, 601 + i, 61 - i);
    }
    for (let i = 0; i < 4; i++) s.box(330 + i * 8, 44, 336 + i * 8, 56);
    const l = traceDimLine(s.ink, { x: 330, y: 44, w: 30, h: 12 })!;
    expect(Math.abs(l.a.x - 100)).toBeLessThanOrEqual(1);
    expect(Math.abs(l.b.x - 600)).toBeLessThanOrEqual(1);
  });

  it('под числом стена, а не размерная линия', () => {
    const s = sheet(700, 120);
    s.box(50, 58, 650, 80);
    expect(traceDimLine(s.ink, { x: 320, y: 44, w: 38, h: 12 })).toBeNull();
  });
});

describe('масштаб по площадям', () => {
  it('комнаты с дверями и окнами сходятся на одном масштабе', () => {
    // 10 мм на пиксель. Две комнаты 4 × 3 м и 3 × 3 м, стены 25 пикс., между ними дверь 80 пикс., окна — тонкие линии.
    const s = sheet(900, 500);
    s.box(50, 50, 825, 75);
    s.box(50, 375, 825, 400);
    s.box(50, 50, 75, 400);
    s.box(800, 50, 825, 400);
    s.box(475, 75, 485, 200);
    s.box(475, 280, 485, 375); // проём 200–280
    s.box(150, 50, 300, 75, ); // заливка стены поверх, окна вырезаем ниже
    for (let x = 150; x < 300; x++) for (let y = 50; y < 75; y++) s.ink.data[y * 900 + x] = y === 55 || y === 62 || y === 69 ? 1 : 0; // окно 150 пикс.
    for (let i = 0; i < 4; i++) s.box(250 + i * 9, 220, 256 + i * 9, 232); // «подпись»
    s.box(120, 300, 300, 301); // край дивана
    const fills = roomFills(s.ink, [
      { at: { x: 268, y: 226 }, m2: 12.0 },
      { at: { x: 640, y: 226 }, m2: 9.45 },
    ]);
    const res = scaleFromAreas(fills)!;
    expect(res.votes).toBe(2);
    expect(res.mmPerPx).toBeGreaterThan(9.7);
    expect(res.mmPerPx).toBeLessThan(10.3);
  });
});
