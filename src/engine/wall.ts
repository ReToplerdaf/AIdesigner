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
