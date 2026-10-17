import { describe, expect, it } from 'vitest';
import { insertCorner, moveCorner, moveEdge, orthoSnap, removeCorner } from './roomEdit';
import { area } from './geometry';

const box = [
  { x: 0, y: 0 },
  { x: 4000, y: 0 },
  { x: 4000, y: 3000 },
  { x: 0, y: 3000 },
];

describe('правка контура помещения', () => {
  it('угол растягивает прямоугольник в две стороны, и он остаётся прямоугольником', () => {
    const p = moveCorner(box, 2, { x: 503, y: -998 });
    expect(p).toEqual([
      { x: 0, y: 0 },
      { x: 4500, y: 0 },
      { x: 4500, y: 2000 },
      { x: 0, y: 2000 },
    ]);
  });

  it('стена сдвигается только поперёк себя', () => {
    const p = moveEdge(box, 1, { x: 1000, y: 700 }); // правая стена
    expect(p[1]).toEqual({ x: 5000, y: 0 });
    expect(p[2]).toEqual({ x: 5000, y: 3000 });
    expect(area(p)).toBe(15e6);
  });

  it('добавляет и удаляет углы', () => {
    const p = insertCorner(box, 0, { x: 1500, y: 40 });
    expect(p).toHaveLength(5);
    expect(p[1]).toEqual({ x: 1500, y: 0 });
    expect(removeCorner(p, 1)).toEqual(box);
    expect(removeCorner(box.slice(0, 3), 0)).toHaveLength(3);
  });

  it('выпрямляет почти горизонтальную сторону при рисовании', () => {
    expect(orthoSnap({ x: 0, y: 0 }, { x: 3000, y: 200 })).toEqual({ x: 3000, y: 0 });
    expect(orthoSnap({ x: 0, y: 0 }, { x: 3000, y: 1500 })).toEqual({ x: 3000, y: 1500 });
  });
});
