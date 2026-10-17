// Правка контура помещения: растягивание за угол и за стену, добавление и удаление углов.
import type { Pt } from './types';

const SNAP = 10; // шаг правки, мм
const snap = (v: number) => Math.round(v / SNAP) * SNAP;
const same = (a: number, b: number) => Math.abs(a - b) < 0.5;

/**
 * Перенос угла i на величину delta (шаг 10 мм). Соседние стороны, которые были горизонтальными или вертикальными,
 * такими и остаются: прямоугольная комната растягивается сразу в две стороны.
 */
export function moveCorner(poly: Pt[], i: number, delta: Pt): Pt[] {
  const n = poly.length;
  const o = poly[i];
  const p = { x: o.x + snap(delta.x), y: o.y + snap(delta.y) };
  const out = poly.map((q) => ({ ...q }));
  out[i] = p;
  for (const j of [(i - 1 + n) % n, (i + 1) % n]) {
    const q = poly[j];
    if (same(q.y, o.y) && !same(q.x, o.x)) out[j].y = p.y;
    else if (same(q.x, o.x) && !same(q.y, o.y)) out[j].x = p.x;
  }
  return out;
}

/** Сдвиг стороны i (от угла i к i+1) перпендикулярно ей самой: комната растягивается в одну сторону. */
export function moveEdge(poly: Pt[], i: number, delta: Pt): Pt[] {
  const n = poly.length;
  const a = poly[i];
  const b = poly[(i + 1) % n];
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const nx = -(b.y - a.y) / len;
  const ny = (b.x - a.x) / len;
  const d = snap(delta.x * nx + delta.y * ny);
  const out = poly.map((q) => ({ ...q }));
  out[i] = { x: Math.round(a.x + nx * d), y: Math.round(a.y + ny * d) };
  out[(i + 1) % n] = { x: Math.round(b.x + nx * d), y: Math.round(b.y + ny * d) };
  return out;
}

/** Новый угол на стороне i в точке, ближайшей к p. */
export function insertCorner(poly: Pt[], i: number, p: Pt): Pt[] {
  const a = poly[i];
  const b = poly[(i + 1) % poly.length];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  const q = { x: Math.round(a.x + dx * t), y: Math.round(a.y + dy * t) };
  return [...poly.slice(0, i + 1), q, ...poly.slice(i + 1)];
}

/** Удаление угла; у треугольника углы не удаляются. */
export function removeCorner(poly: Pt[], i: number): Pt[] {
  return poly.length > 3 ? poly.filter((_, j) => j !== i) : poly;
}

/** Выпрямление при рисовании: сторона около 0° или 90° (до maxDeg) становится строго горизонтальной или вертикальной. */
export function orthoSnap(prev: Pt, p: Pt, maxDeg = 7): Pt {
  const dx = p.x - prev.x;
  const dy = p.y - prev.y;
  const tan = Math.tan((maxDeg * Math.PI) / 180);
  if (Math.abs(dy) <= tan * Math.abs(dx)) return { x: p.x, y: prev.y };
  if (Math.abs(dx) <= tan * Math.abs(dy)) return { x: prev.x, y: p.y };
  return p;
}
