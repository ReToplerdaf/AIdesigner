import type { Pt } from './types';

export function area(poly: Pt[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

export function perimeter(poly: Pt[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) s += dist(poly[i], poly[(i + 1) % poly.length]);
  return s;
}

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Длина по ортогональной трассе (кабель идёт параллельно стенам). */
export function manhattan(a: Pt, b: Pt): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export function centroid(poly: Pt[]): Pt {
  const b = bbox(poly);
  const c = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
  if (pointInPolygon(c, poly)) return c;
  const sx = poly.reduce((s, p) => s + p.x, 0) / poly.length;
  const sy = poly.reduce((s, p) => s + p.y, 0) / poly.length;
  return { x: sx, y: sy };
}

export function bbox(poly: Pt[]) {
  return {
    minX: Math.min(...poly.map((p) => p.x)),
    maxX: Math.max(...poly.map((p) => p.x)),
    minY: Math.min(...poly.map((p) => p.y)),
    maxY: Math.max(...poly.map((p) => p.y)),
  };
}

export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function rect(x1: number, y1: number, x2: number, y2: number): Pt[] {
  const [ax, bx] = [Math.min(x1, x2), Math.max(x1, x2)];
  const [ay, by] = [Math.min(y1, y2), Math.max(y1, y2)];
  return [
    { x: ax, y: ay },
    { x: bx, y: ay },
    { x: bx, y: by },
    { x: ax, y: by },
  ];
}

/**
 * Точка на периметре многоугольника на расстоянии t (доля 0..1 от периметра),
 * отодвинутая внутрь помещения на inset мм.
 */
export function pointOnPerimeter(poly: Pt[], t: number, inset: number): Pt {
  const total = perimeter(poly);
  let d = (((t % 1) + 1) % 1) * total;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const len = dist(a, b);
    if (d <= len || i === poly.length - 1) {
      const k = len === 0 ? 0 : Math.min(d / len, 1);
      const p = { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
      const nx = -(b.y - a.y) / (len || 1);
      const ny = (b.x - a.x) / (len || 1);
      const cand = { x: p.x + nx * inset, y: p.y + ny * inset };
      if (pointInPolygon(cand, poly)) return cand;
      return { x: p.x - nx * inset, y: p.y - ny * inset };
    }
    d -= len;
  }
  return poly[0];
}
