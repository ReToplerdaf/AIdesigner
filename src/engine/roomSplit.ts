// Смежные помещения без стены между ними: кухня-гостиная, коридор с холлом. На плане их делит только тонкая
// линия (сплошная, пунктир, две линии) или ничего, но у каждого есть подпись площади. Если в одном найденном
// контуре две подписи и их сумма сходится с площадью контура, граница ищется там, где её требуют площади:
// прямой разрез, который делит контур в нужной пропорции, сдвигается к ближайшей линии на плане.
import { area, bbox, pointInPolygon } from './geometry';
import { orthogonalize, type OpenCV, type RasterPlan } from './roomDetect';
import type { Box, Pt } from './types';

export interface AreaMark {
  /** Центр подписи площади, мм. */
  at: Pt;
  m2: number;
  /** Рамка подписи: текст не принимается за линию границы. */
  box?: Box;
}

export interface SplitPart {
  poly: Pt[];
  /** Номера подписей (в исходном списке), попавших в эту часть. */
  marks: number[];
  /** false — в части осталось несколько подписей, а линию между ними найти не удалось. */
  ok: boolean;
}

/** Доля разреза, покрытая тёмными пикселями, начиная с которой разрез считается линией на плане. */
const MIN_COVER = 0.3;
/** Две линии границы (или линия и её пара) ближе этого считаются одной границей, мм. */
const PAIR_MM = 300;

/** Сумма подписей сходится с площадью контура: значит, в контуре слились смежные помещения. */
export function looksMerged(poly: Pt[], marks: AreaMark[], tol = 0.08): boolean {
  if (marks.length < 2) return false;
  const sum = marks.reduce((s, m) => s + m.m2, 0);
  return Math.abs(area(poly) / 1e6 - sum) / sum <= tol;
}

/** Делит контур по подписям площадей, пока в каждой части не останется по одной подписи. */
export function splitByAreas(plan: RasterPlan, poly: Pt[], marks: AreaMark[]): SplitPart[] {
  const go = (p: Pt[], idx: number[]): SplitPart[] => {
    if (idx.length < 2) return [{ poly: p, marks: idx, ok: true }];
    const cut = bestCut(plan, p, idx.map((i) => marks[i]));
    if (!cut) return [{ poly: p, marks: idx, ok: false }];
    const [a, b] = splitPoly(p, cut.a, cut.b);
    const side = (m: AreaMark) => (pointInPolygon(m.at, a) ? 0 : 1);
    return [...go(a, idx.filter((i) => side(marks[i]) === 0)), ...go(b, idx.filter((i) => side(marks[i]) === 1))];
  };
  return go(poly, marks.map((_, i) => i));
}

/**
 * Граница, проведённая пользователем примерно: почти горизонтальная или вертикальная выпрямляется
 * и прилипает к ближайшей линии на плане (до 400 мм в сторону), если такая есть.
 */
export function snapLine(plan: RasterPlan, poly: Pt[], a: Pt, b: Pt, boxes: Box[] = []): [Pt, Pt] {
  const dx = Math.abs(b.x - a.x);
  const dy = Math.abs(b.y - a.y);
  const tan = Math.tan((10 * Math.PI) / 180);
  const vertical = dx <= tan * dy;
  if (!vertical && dy > tan * dx) return [a, b];
  const prof = profile(plan, poly, vertical, boxes);
  const at = vertical ? (a.x + b.x) / 2 : (a.y + b.y) / 2;
  const c0 = Math.round(at / plan.mmPerPx) - prof.start;
  const r = Math.round(400 / plan.mmPerPx);
  const win: number[] = [];
  for (let c = Math.max(1, c0 - r); c <= Math.min(prof.cover.length - 2, c0 + r); c++) win.push(c);
  const peak = peakIn(prof, win);
  const v = peak != null ? (peak + prof.start + 0.5) * plan.mmPerPx : at;
  return line(vertical, v);
}

/** Разрез контура прямой через a и b: части слева и справа от неё. */
export function splitPoly(poly: Pt[], a: Pt, b: Pt): [Pt[], Pt[]] {
  const n = { x: b.y - a.y, y: a.x - b.x };
  const side = (p: Pt) => (p.x - a.x) * n.x + (p.y - a.y) * n.y;
  return [clip(poly, side), clip(poly, (p) => -side(p))];
}

/** Часть многоугольника, где f(p) ≤ 0 (отсечение Сазерленда — Ходжмана полуплоскостью). */
function clip(poly: Pt[], f: (p: Pt) => number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const fp = f(p);
    const fq = f(q);
    if (fp <= 0) out.push(p);
    if ((fp < 0 && fq > 0) || (fp > 0 && fq < 0)) {
      const t = fp / (fp - fq);
      out.push({ x: Math.round(p.x + (q.x - p.x) * t), y: Math.round(p.y + (q.y - p.y) * t) });
    }
  }
  // Повторы точек на линии разреза не нужны.
  return out.filter((p, i) => {
    const q = out[(i + 1) % out.length];
    return out.length < 2 || p.x !== q.x || p.y !== q.y;
  });
}

const line = (vertical: boolean, v: number): [Pt, Pt] =>
  vertical ? [{ x: v, y: -1e7 }, { x: v, y: 1e7 }] : [{ x: -1e7, y: v }, { x: 1e7, y: v }];

interface Profile {
  /** Первый столбец (строка) профиля, пиксели картинки. */
  start: number;
  /** Доля пикселей контура слева от столбца (сверху от строки), с половиной самого столбца. */
  frac: Float64Array;
  /** Доля длины разреза по этому столбцу (строке), которая лежит на тёмных пикселях. */
  cover: Float64Array;
}

/** Профиль контура по столбцам (vertical) или строкам: сколько площади до разреза и насколько разрез «нарисован». */
function profile(plan: RasterPlan, poly: Pt[], vertical: boolean, boxes: Box[]): Profile {
  const { width: W, height: H, mmPerPx: k, rgba } = plan;
  const b = bbox(poly);
  const x0 = Math.max(0, Math.floor(b.minX / k));
  const x1 = Math.min(W - 1, Math.ceil(b.maxX / k));
  const y0 = Math.max(0, Math.floor(b.minY / k));
  const y1 = Math.min(H - 1, Math.ceil(b.maxY / k));
  const ink = (x: number, y: number) => {
    const i = (y * W + x) * 4;
    return 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2] < 170;
  };
  const pad = 100;
  const inBox = (p: Pt) => boxes.some((r) => p.x >= r.x - pad && p.x <= r.x + r.w + pad && p.y >= r.y - pad && p.y <= r.y + r.h + pad);
  const n = vertical ? x1 - x0 + 1 : y1 - y0 + 1;
  const start = vertical ? x0 : y0;
  const inside = new Float64Array(n);
  const samples = new Float64Array(n);
  const hits = new Float64Array(n);
  // Отступ от стен контура: у самой стены разрез «нарисован» стеной, а не линией границы.
  const margin = 2;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const p = { x: (x + 0.5) * k, y: (y + 0.5) * k };
      if (!pointInPolygon(p, poly)) continue;
      const c = vertical ? x - x0 : y - y0;
      inside[c]++;
      if (inBox(p)) continue;
      const m = margin * k;
      const deep = vertical
        ? pointInPolygon({ x: p.x, y: p.y - m }, poly) && pointInPolygon({ x: p.x, y: p.y + m }, poly)
        : pointInPolygon({ x: p.x - m, y: p.y }, poly) && pointInPolygon({ x: p.x + m, y: p.y }, poly);
      if (!deep) continue;
      samples[c]++;
      // Линия толщиной в пиксель могла лечь между столбцами — смотрим и соседей поперёк разреза.
      const hit = vertical
        ? ink(x, y) || (x > 0 && ink(x - 1, y)) || (x < W - 1 && ink(x + 1, y))
        : ink(x, y) || (y > 0 && ink(x, y - 1)) || (y < H - 1 && ink(x, y + 1));
      if (hit) hits[c]++;
    }
  const total = inside.reduce((s, v) => s + v, 0) || 1;
  const frac = new Float64Array(n);
  const cover = new Float64Array(n);
  let acc = 0;
  for (let c = 0; c < n; c++) {
    frac[c] = (acc + inside[c] / 2) / total;
    acc += inside[c];
    cover[c] = samples[c] > 5 ? hits[c] / samples[c] : 0;
  }
  return { start, frac, cover };
}

/**
 * Лучшая линия в окне столбцов: самый «нарисованный» разрез. Если рядом есть второй такой же (граница
 * двумя линиями), берётся середина между ними.
 */
function peakIn(prof: Profile, win: number[]): number | null {
  let best = -1;
  for (const c of win) if (prof.cover[c] >= MIN_COVER && (best < 0 || prof.cover[c] > prof.cover[best])) best = c;
  if (best < 0) return null;
  // Пики покрытия (локальные максимумы) рядом с лучшим.
  const near = win.filter(
    (c) => prof.cover[c] >= MIN_COVER && prof.cover[c] >= prof.cover[c - 1] && prof.cover[c] >= prof.cover[c + 1],
  );
  return near.length ? midOfPair(best, near) : best;
}

let pairPx = 0;
function midOfPair(best: number, peaks: number[]): number {
  const mates = peaks.filter((c) => Math.abs(c - best) <= pairPx);
  return Math.round((Math.min(...mates, best) + Math.max(...mates, best)) / 2);
}

/** Разрез, который делит подписи на две группы в нужной пропорции площадей и лежит на линии плана. */
function bestCut(plan: RasterPlan, poly: Pt[], marks: AreaMark[]): { a: Pt; b: Pt } | null {
  pairPx = PAIR_MM / plan.mmPerPx;
  const boxes = marks.flatMap((m) => (m.box ? [m.box] : []));
  const total = marks.reduce((s, m) => s + m.m2, 0);
  let best: { cover: number; a: Pt; b: Pt } | null = null;
  for (const vertical of [true, false]) {
    const prof = profile(plan, poly, vertical, boxes);
    const coord = (m: AreaMark) => (vertical ? m.at.x : m.at.y);
    const sorted = [...marks].sort((p, q) => coord(p) - coord(q));
    for (let g = 1; g < sorted.length; g++) {
      const f = sorted.slice(0, g).reduce((s, m) => s + m.m2, 0) / total;
      // Разрез — между подписями групп, а доля площади до него — около нужной.
      const lo = coord(sorted[g - 1]) / plan.mmPerPx - prof.start;
      const hi = coord(sorted[g]) / plan.mmPerPx - prof.start;
      const win: number[] = [];
      for (let c = Math.max(1, Math.ceil(lo)); c <= Math.min(prof.cover.length - 2, Math.floor(hi)); c++)
        if (Math.abs(prof.frac[c] - f) <= 0.07) win.push(c);
      const c = peakIn(prof, win);
      if (c == null) continue;
      if (!best || prof.cover[c] > best.cover) {
        const [a, b] = line(vertical, (c + prof.start + 0.5) * plan.mmPerPx);
        best = { cover: prof.cover[c], a, b };
      }
    }
  }
  return best;
}

/**
 * Когда линии границы на плане нет: помещения «растут» одновременно, каждое от своей подписи, кольцо за кольцом.
 * Вперёд всегда то, что сильнее отстаёт от своей площади; доросшее до площади останавливается. Тонкие линии
 * плана — преграда (поэтому граница ложится на пунктир или на линию, если она есть), но остатки за ними
 * в конце достаются соседям. Контуры частей выпрямляются, как у найденных помещений.
 */
export function growRooms(cv: OpenCV, plan: RasterPlan, poly: Pt[], marks: AreaMark[]): Pt[][] | null {
  const { width: W, height: H, mmPerPx: k, rgba } = plan;
  const b = bbox(poly);
  const x0 = Math.max(0, Math.floor(b.minX / k));
  const y0 = Math.max(0, Math.floor(b.minY / k));
  const w = Math.min(W, Math.ceil(b.maxX / k) + 1) - x0;
  const h = Math.min(H, Math.ceil(b.maxY / k) + 1) - y0;
  const N = w * h;
  // 0 — снаружи, 1 — свободно, 2 — линия плана (преграда при росте).
  const cell = new Uint8Array(N);
  const inBox = (p: Pt) => marks.some((m) => m.box && p.x >= m.box.x - 50 && p.x <= m.box.x + m.box.w + 50 && p.y >= m.box.y - 50 && p.y <= m.box.y + m.box.h + 50);
  let free = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = { x: (x0 + x + 0.5) * k, y: (y0 + y + 0.5) * k };
      if (!pointInPolygon(p, poly)) continue;
      const i = ((y0 + y) * W + x0 + x) * 4;
      const dark = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2] < 170;
      cell[y * w + x] = dark && !inBox(p) ? 2 : 1;
      free++;
    }
  const sum = marks.reduce((s, m) => s + m.m2, 0);
  const target = marks.map((m) => (m.m2 / sum) * free);
  const owner = new Int16Array(N).fill(-1);
  const got = marks.map(() => 0);
  let fronts: number[][] = marks.map((m) => {
    const x = Math.floor(m.at.x / k) - x0;
    const y = Math.floor(m.at.y / k) - y0;
    const i = y * w + x;
    return x >= 0 && y >= 0 && x < w && y < h && cell[i] === 1 ? [i] : [];
  });
  if (fronts.some((f) => !f.length)) return null;
  fronts.forEach((f, r) => {
    owner[f[0]] = r;
    got[r] = 1;
  });
  const N4 = [-1, 1, -w, w];
  const N8 = [...N4, -w - 1, -w + 1, w - 1, w + 1];
  const step = (r: number, ring: number, pass: (i: number) => boolean) => {
    const next: number[] = [];
    // Чередование 4- и 8-связности даёт почти круглую волну: граница между соседями не уходит в диагональ.
    const nb = ring % 2 ? N8 : N4;
    for (const i of fronts[r]) {
      const x = i % w;
      for (const d of nb) {
        const j = i + d;
        if (j < 0 || j >= N || Math.abs((j % w) - x) > 1 || owner[j] >= 0 || !pass(j)) continue;
        owner[j] = r;
        got[r]++;
        next.push(j);
      }
    }
    fronts[r] = next;
  };
  // 1. Одновременный рост до своей площади, линии плана — преграда.
  const rings = marks.map(() => 0);
  for (;;) {
    let r = -1;
    for (let q = 0; q < marks.length; q++)
      if (fronts[q].length && got[q] < target[q] && (r < 0 || got[q] / target[q] < got[r] / target[r])) r = q;
    if (r < 0) break;
    step(r, rings[r]++, (j) => cell[j] === 1);
  }
  // 2. Остатки (за линиями мебели, сами линии): сначала тем, кто не добрал площадь, потом всем.
  for (const hungry of [true, false]) {
    fronts = marks.map((_, r) => (hungry && got[r] >= target[r] ? [] : collect(owner, r)));
    for (let ring = 0; fronts.some((f) => f.length); ring++)
      for (let r = 0; r < marks.length; r++) {
        if (!hungry || got[r] < target[r]) step(r, ring, (j) => cell[j] > 0);
        else fronts[r] = []; // доросшее до площади дальше не растёт
      }
  }
  // 3. Контуры частей.
  const out: Pt[][] = [];
  const eps = Math.max(1.5, 40 / k);
  for (let r = 0; r < marks.length; r++) {
    const mask = cv.Mat.zeros(h + 2, w + 2, cv.CV_8UC1);
    const md = mask.data as Uint8Array;
    for (let i = 0; i < N; i++) if (owner[i] === r) md[(Math.floor(i / w) + 1) * (w + 2) + (i % w) + 1] = 255;
    // Одиночные пиксели на стыке частей не должны рвать контур.
    const kk = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    cv.morphologyEx(mask, mask, cv.MORPH_OPEN, kk);
    kk.delete();
    const contours = new cv.MatVector();
    const hier = new cv.Mat();
    cv.findContours(mask, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
    let best = -1;
    let bestA = 0;
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const a = cv.contourArea(c);
      if (a > bestA) [bestA, best] = [a, i];
      c.delete();
    }
    let pts: Pt[] = [];
    if (best >= 0) {
      const c = contours.get(best);
      const approx = new cv.Mat();
      cv.approxPolyDP(c, approx, eps, true);
      const d = approx.data32S as Int32Array;
      for (let i = 0; i < d.length; i += 2) pts.push({ x: x0 + d[i] - 1 + 0.5, y: y0 + d[i + 1] - 1 + 0.5 });
      approx.delete();
      c.delete();
    }
    mask.delete();
    contours.delete();
    hier.delete();
    pts = orthogonalize(pts).map((p) => ({ x: Math.round(p.x * k), y: Math.round(p.y * k) }));
    if (pts.length < 3) return null;
    out.push(pts);
  }
  return marks.length === 2 ? straighten(plan, poly, marks, out) : out;
}

/**
 * Волны от двух точек встречаются по ломаной, а настоящая граница смежных комнат обычно прямая. Если прямой
 * разрез вдоль оси делит контур в нужной пропорции и почти совпадает с выросшими частями, берём его.
 */
function straighten(plan: RasterPlan, poly: Pt[], marks: AreaMark[], grown: Pt[][]): Pt[][] {
  const total = marks[0].m2 + marks[1].m2;
  let best: { parts: Pt[][]; agree: number } | null = null;
  for (const vertical of [true, false]) {
    const prof = profile(plan, poly, vertical, []);
    const coord = (m: AreaMark) => (vertical ? m.at.x : m.at.y);
    const first = coord(marks[0]) <= coord(marks[1]) ? 0 : 1;
    const f = marks[first].m2 / total;
    let c = -1;
    for (let q = 0; q < prof.frac.length; q++) if (c < 0 || Math.abs(prof.frac[q] - f) < Math.abs(prof.frac[c] - f)) c = q;
    const v = (c + prof.start + 0.5) * plan.mmPerPx;
    if (Math.abs(prof.frac[c] - f) > 0.02 || v <= coord(marks[first]) || v >= coord(marks[1 - first])) continue;
    const [a, b] = line(vertical, v);
    const halves = splitPoly(poly, a, b);
    const parts = first === 0 ? halves : [halves[1], halves[0]];
    const agree = overlap(parts[0], grown[0]) + overlap(parts[1], grown[1]);
    if (!best || agree > best.agree) best = { parts, agree };
  }
  // Совпадение меньше 85 % — комнаты сложной формы, прямой разрез им не подходит.
  return best && best.agree / 2 >= 0.85 ? best.parts : grown;
}

/** Доля площади a, которая лежит и в b (по сетке точек). */
function overlap(a: Pt[], b: Pt[]): number {
  const r = bbox(a);
  const step = Math.max(r.maxX - r.minX, r.maxY - r.minY) / 60;
  let n = 0;
  let both = 0;
  for (let y = r.minY + step / 2; y < r.maxY; y += step)
    for (let x = r.minX + step / 2; x < r.maxX; x += step) {
      if (!pointInPolygon({ x, y }, a)) continue;
      n++;
      if (pointInPolygon({ x, y }, b)) both++;
    }
  return n ? both / n : 0;
}

function collect(owner: Int16Array, r: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < owner.length; i++) if (owner[i] === r) out.push(i);
  return out;
}
