import { manhattan, pointOnPerimeter } from './geometry';
import type { Pt } from './types';

/** Точка у стены помещения (с отступом inset внутрь), ближайшая к target по ортогональной трассе. */
export function nearestWallPoint(poly: Pt[], target: Pt, inset: number, steps = 200): Pt {
  let best = pointOnPerimeter(poly, 0, inset);
  let bestD = manhattan(best, target);
  for (let i = 1; i < steps; i++) {
    const p = pointOnPerimeter(poly, i / steps, inset);
    const d = manhattan(p, target);
    if (d < bestD) {
      best = p;
      bestD = d;
    }
  }
  return { x: Math.round(best.x), y: Math.round(best.y) };
}

/**
 * Угол поворота значка настенного устройства, градусы: значок рисуется «спиной» вниз,
 * поворот ставит спину к ближайшей стене (0 — стена снизу, 180 — сверху, 90 — слева, −90 — справа).
 */
export function wallAngle(poly: Pt[], p: Pt): number {
  let best = Infinity;
  let angle = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy || 1;
    const t = Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    const q = { x: a.x + t * dx, y: a.y + t * dy };
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    if (d < best) {
      best = d;
      // Направление от точки к стене; спина значка (вниз, +y) поворачивается в эту сторону.
      angle = Math.round((Math.atan2(q.y - p.y, q.x - p.x) * 180) / Math.PI - 90);
    }
  }
  // Около осей округляем до кратного 90, чтобы на прямых стенах значки стояли ровно.
  const snapped = Math.round(angle / 90) * 90;
  const norm = (v: number) => {
    const r = ((((v + 180) % 360) + 360) % 360) - 180;
    return r === -180 ? 180 : r;
  };
  return Math.abs(norm(angle - snapped)) <= 10 ? norm(snapped) : norm(angle);
}
