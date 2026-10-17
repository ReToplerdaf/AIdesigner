// Распознавание помещений на растровом плане (картинка, скан, PDF, сохранённый картинкой).
// Конвейер классического компьютерного зрения на OpenCV.js:
//   1) тёмные пиксели — кандидаты в стены (порог Оцу);
//   2) если сплошных стен нет, стены из двух тонких линий заливаются (узкие замкнутые полости);
//   3) тонкие линии — текст, размеры, мебель, дуги дверей — убираются морфологическим открытием;
//   4) проёмы дверей и окон «зашиваются» мостиком между двумя торцами стены;
//   5) замкнутые области, не касающиеся края картинки, — помещения; контур упрощается и выпрямляется.
// Модуль не зависит от браузера: OpenCV передаётся параметром, поэтому его можно проверить тестами.

import { area as polyArea, pointInPolygon } from './geometry';
import type { Pt } from './types';

// У OpenCV.js нет удобных типов, а подключать его объявления в сборку ради одного модуля незачем.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OpenCV = any;

export interface RasterPlan {
  width: number;
  height: number;
  /** Пиксели RGBA, как в ImageData. */
  rgba: Uint8ClampedArray;
  /** Масштаб этой картинки, мм на пиксель. */
  mmPerPx: number;
}

export interface DetectOptions {
  /** Самый широкий проём (дверь, окно), который закрывается автоматически, мм. */
  maxGapMm?: number;
  /** Меньшие области не считаются помещениями (шахты, ниши), м². */
  minAreaM2?: number;
  /** Граница дома, мм: помещения ищутся только внутри неё. */
  boundary?: Pt[];
  /** Вызывается перед каждым этапом, чтобы интерфейс успел показать состояние. */
  onStage?: (stage: DetectStage) => Promise<void> | void;
}

export type DetectStage = 'walls' | 'gaps' | 'rooms';

export interface DetectedRoom {
  /** Контур по внутренним граням стен, мм в координатах плана. */
  poly: Pt[];
  /** Точка заведомо внутри помещения, мм (центр контура может оказаться снаружи у Г-образной комнаты). */
  inside: Pt;
}

export interface DetectResult {
  rooms: DetectedRoom[];
  /** Оценка толщины основных стен, мм. */
  wallMm: number;
  /** Сколько проёмов закрыто мостиками (в пикселях-строках, для отладки). */
  bridgedPx: number;
}

/** Стены толще этого, нарисованные двумя линиями, ещё заливаются как полые (половина толщины, мм). */
const HOLLOW_HALF_MM = 300;
/** Если на плане есть сплошные тёмные полосы такой толщины, стены нарисованы заливкой, мм. */
const SOLID_WALL_MM = 60;
/** Линии тоньше этого считаются графикой, а не стеной, мм. */
const THIN_LINE_MM = 50;

export async function detectRooms(cv: OpenCV, plan: RasterPlan, opts: DetectOptions = {}): Promise<DetectResult> {
  const { width: W, height: H, mmPerPx } = plan;
  const maxGapMm = opts.maxGapMm ?? 2400;
  const minAreaPx = ((opts.minAreaM2 ?? 1) * 1e6) / (mmPerPx * mmPerPx);
  const N = W * H;
  const mats: { delete(): void }[] = [];
  const keep = <T extends { delete(): void }>(m: T) => (mats.push(m), m);

  try {
    await opts.onStage?.('walls');
    const { walls, wallPx, tMin } = wallMask(cv, plan, keep);

    // 4. Проёмы. Мостик ставится, только если по обе стороны — торцы стены, а не длинные стены поперёк:
    // иначе узкий коридор или санузел «зашился» бы целиком.
    await opts.onStage?.('gaps');
    const wd = walls.data as Uint8Array;
    const maxGapPx = maxGapMm / mmPerPx;
    const maxEndPx = Math.max(1.6 * wallPx, 3 * tMin, 3);
    const bridge = new Uint8Array(N);
    let bridgedPx = bridgeGaps(wd, W, H, maxGapPx, maxEndPx, bridge);

    // Граница дома, если её задали: всё снаружи — стена. Окна любой ширины на наружных стенах
    // закрываются мостиком вдоль границы, поэтому комната с панорамным окном не «вытекает» наружу.
    let inside: Uint8Array | null = null;
    if (opts.boundary && opts.boundary.length >= 3) {
      const m = keep(cv.Mat.zeros(H, W, cv.CV_8UC1));
      const pts = keep(cv.matFromArray(opts.boundary.length, 1, cv.CV_32SC2, opts.boundary.flatMap((p) => [Math.round(p.x / mmPerPx), Math.round(p.y / mmPerPx)])));
      const vec = keep(new cv.MatVector());
      vec.push_back(pts);
      cv.fillPoly(m, vec, new cv.Scalar(255));
      inside = m.data as Uint8Array;
      // Полоса вдоль границы шириной в пару толщин стены: только в ней ставим длинные мостики.
      const core = keep(new cv.Mat());
      const r = Math.max(3, Math.round(wallPx * 2.5));
      const k = keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(2 * r + 1, 2 * r + 1)));
      cv.erode(m, core, k);
      const cd = core.data as Uint8Array;
      const long = new Uint8Array(N);
      bridgeGaps(wd, W, H, Math.max(W, H), maxEndPx, long);
      for (let i = 0; i < N; i++)
        if (long[i] && !bridge[i] && inside[i] && !cd[i]) {
          bridge[i] = 1;
          bridgedPx++;
        }
    }

    // 5. Помещения — связные свободные области, не выходящие на край картинки.
    await opts.onStage?.('rooms');
    const free = keep(new cv.Mat(H, W, cv.CV_8UC1));
    const fd = free.data as Uint8Array;
    for (let i = 0; i < N; i++) fd[i] = wd[i] || bridge[i] || (inside && !inside[i]) ? 0 : 255;
    const lab2 = keep(new cv.Mat());
    const st2 = keep(new cv.Mat());
    const ce2 = keep(new cv.Mat());
    const n2 = cv.connectedComponentsWithStats(free, lab2, st2, ce2, 4, cv.CV_32S);
    const l2 = lab2.data32S as Int32Array;
    const firstPx = new Int32Array(n2).fill(-1);
    for (let i = 0; i < N; i++) if (firstPx[l2[i]] < 0) firstPx[l2[i]] = i;

    const rooms: DetectedRoom[] = [];
    const eps = Math.max(1.5, 40 / mmPerPx);
    for (let k = 1; k < n2; k++) {
      const s = stat(st2, k);
      if (s.area < minAreaPx || s.area > 0.6 * N || touchesBorder(st2, k, W, H)) continue;
      const poly = contourOf(cv, l2, W, k, s, eps, keep);
      if (!poly || poly.length < 3) continue;
      const fp = firstPx[k];
      const at = { x: ((fp % W) + 0.5) * mmPerPx, y: (Math.floor(fp / W) + 0.5) * mmPerPx };
      const mm = orthogonalize(poly).map((p) => ({ x: Math.round(p.x * mmPerPx), y: Math.round(p.y * mmPerPx) }));
      if (mm.length >= 3 && polyArea(mm) > 0) rooms.push({ poly: mm, inside: at });
    }
    return { rooms, wallMm: Math.round(wallPx * mmPerPx), bridgedPx };
  } finally {
    for (const m of mats) m.delete();
  }
}

/** Шаги 1–3: маска стен (255 — стена), оценка толщины стен и порог «тонких» линий, пиксели. */
function wallMask(cv: OpenCV, plan: RasterPlan, keep: Keep): { walls: OpenCV; wallPx: number; tMin: number } {
  const { width: W, height: H, mmPerPx } = plan;
    const src = keep(cv.matFromImageData({ data: plan.rgba, width: W, height: H }));
    const gray = keep(new cv.Mat());
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    // 1. Тёмное — 255. Порог Оцу, но не светлее 170: цветная заливка пола не должна стать стеной.
    const ink = keep(new cv.Mat());
    const otsu = cv.threshold(gray, ink, 0, 255, cv.THRESH_BINARY_INV | cv.THRESH_OTSU);
    if (otsu > 170) cv.threshold(gray, ink, 170, 255, cv.THRESH_BINARY_INV);

    // 2. Полые стены (две тонкие линии) заливаются, только если сплошных стен на плане нет:
    // иначе под заливку попадают замкнутые контуры мебели — ванна, унитаз, столешница — и режут комнату.
    const inkDist = keep(new cv.Mat());
    cv.distanceTransform(ink, inkDist, cv.DIST_L2, 3);
    const inkData = ink.data as Uint8Array;
    const solidWalls = 2 * percentile(inkDist.data32F as Float32Array, inkData, 0.95) >= Math.max(4, SOLID_WALL_MM / mmPerPx);
    const solid = keep(ink.clone());
    if (!solidWalls) fillHollow(cv, ink, solid, Math.max(2, HOLLOW_HALF_MM / mmPerPx), keep);
    const sd = solid.data as Uint8Array;

    // 3. Толщина линий: расстояние от тёмного пикселя до светлого. Стены — самые толстые линии.
    const solidDist = keep(new cv.Mat());
    cv.distanceTransform(solid, solidDist, cv.DIST_L2, 3);
    const wallPx = 2 * percentile(solidDist.data32F as Float32Array, sd, 0.95);
    let tMin = Math.round(Math.min(THIN_LINE_MM / mmPerPx, 0.4 * wallPx));
    if (wallPx < 4) tMin = 1; // тонкие стены одной линией: не чистим, иначе пропадут и стены
    tMin = Math.max(1, tMin);
    const walls = keep(new cv.Mat());
    if (tMin > 1) {
      const k = keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(tMin, tMin)));
      cv.morphologyEx(solid, walls, cv.MORPH_OPEN, k);
    } else solid.copyTo(walls);
    dropSpecks(cv, walls, Math.max(20, (150 / mmPerPx) ** 2), keep);

    return { walls, wallPx, tMin };
}

/**
 * Граница всего дома (квартиры) по наружному контуру стен, мм. Проёмы любой ширины между торцами стен
 * (панорамные окна, входная дверь) закрываются мостиками, оставшиеся мелкие щели — замыканием на closeMm.
 * Результат — предложение: пользователь правит его и подтверждает.
 */
export async function detectOutline(cv: OpenCV, plan: RasterPlan, closeMm = 1200): Promise<Pt[] | null> {
  const { width: W, height: H, mmPerPx } = plan;
  const mats: { delete(): void }[] = [];
  const keep: Keep = (m) => (mats.push(m), m);
  try {
    const { walls, wallPx, tMin } = wallMask(cv, plan, keep);
    const wd = walls.data as Uint8Array;
    const bridge = new Uint8Array(W * H);
    bridgeGaps(wd, W, H, Math.max(W, H), Math.max(1.6 * wallPx, 3 * tMin, 3), bridge);
    for (let i = 0; i < wd.length; i++) if (bridge[i]) wd[i] = 255;
    const closed = keep(new cv.Mat());
    const kPx = Math.max(3, Math.round(closeMm / mmPerPx));
    const k = keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(kPx, kPx)));
    // Поле вокруг картинки, чтобы замыкание у краёв не прилипало к границе листа.
    const padded = keep(new cv.Mat());
    cv.copyMakeBorder(walls, padded, kPx, kPx, kPx, kPx, cv.BORDER_CONSTANT, new cv.Scalar(0));
    cv.morphologyEx(padded, closed, cv.MORPH_CLOSE, k);
    const contours = keep(new cv.MatVector());
    const hier = keep(new cv.Mat());
    cv.findContours(closed, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    let best = -1;
    let bestA = 0;
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const a = cv.contourArea(c);
      if (a > bestA) {
        bestA = a;
        best = i;
      }
      c.delete();
    }
    if (best < 0 || bestA < 0.02 * W * H) return null;
    const c = contours.get(best);
    const approx = keep(new cv.Mat());
    cv.approxPolyDP(c, approx, Math.max(2, 120 / mmPerPx), true);
    c.delete();
    const d = approx.data32S as Int32Array;
    const pts: Pt[] = [];
    for (let i = 0; i < d.length; i += 2) pts.push({ x: d[i] - kPx + 0.5, y: d[i + 1] - kPx + 0.5 });
    const mm = orthogonalize(pts).map((p) => ({ x: Math.round(p.x * mmPerPx), y: Math.round(p.y * mmPerPx) }));
    return mm.length >= 3 ? mm : null;
  } finally {
    for (const m of mats) m.delete();
  }
}

type Keep = <T extends { delete(): void }>(m: T) => T;

/** Заливает замкнутые светлые области, узкие по всей длине (расстояние до линии ≤ halfPx): полости полых стен. */
function fillHollow(cv: OpenCV, ink: OpenCV, solid: OpenCV, halfPx: number, keep: <T extends { delete(): void }>(m: T) => T) {
  const W = ink.cols;
  const H = ink.rows;
  const bg = keep(new cv.Mat());
  cv.bitwise_not(ink, bg);
  const dist = keep(new cv.Mat());
  cv.distanceTransform(bg, dist, cv.DIST_L2, 3);
  const lab = keep(new cv.Mat());
  const stats = keep(new cv.Mat());
  const cent = keep(new cv.Mat());
  const n = cv.connectedComponentsWithStats(bg, lab, stats, cent, 4, cv.CV_32S);
  const l = lab.data32S as Int32Array;
  const dd = dist.data32F as Float32Array;
  const maxDist = new Float32Array(n);
  for (let i = 0; i < l.length; i++) if (dd[i] > maxDist[l[i]]) maxDist[l[i]] = dd[i];
  const fill = new Uint8Array(n);
  for (let k = 1; k < n; k++) if (!touchesBorder(stats, k, W, H) && maxDist[k] <= halfPx) fill[k] = 1;
  const sd = solid.data as Uint8Array;
  for (let i = 0; i < sd.length; i++) if (sd[i] === 0 && fill[l[i]]) sd[i] = 255;
}

function stat(stats: OpenCV, k: number) {
  const d = stats.data32S as Int32Array;
  const o = k * 5;
  return { left: d[o], top: d[o + 1], width: d[o + 2], height: d[o + 3], area: d[o + 4] };
}

function touchesBorder(stats: OpenCV, k: number, W: number, H: number): boolean {
  const s = stat(stats, k);
  return s.left === 0 || s.top === 0 || s.left + s.width >= W || s.top + s.height >= H;
}

/** Значение distanceTransform, ниже которого лежит доля q тёмных пикселей. */
function percentile(dist: Float32Array, mask: Uint8Array, q: number): number {
  const hist = new Uint32Array(512);
  let n = 0;
  for (let i = 0; i < dist.length; i++) {
    if (!mask[i]) continue;
    hist[Math.min(511, Math.round(dist[i] * 2))]++;
    n++;
  }
  if (!n) return 0;
  let acc = 0;
  for (let b = 0; b < hist.length; b++) {
    acc += hist[b];
    if (acc >= q * n) return b / 2;
  }
  return 255;
}

/** Убирает мелкие тёмные пятна (жирные буквы, значки), оставшиеся после чистки тонких линий. */
function dropSpecks(cv: OpenCV, walls: OpenCV, minPx: number, keep: <T extends { delete(): void }>(m: T) => T) {
  const lab = keep(new cv.Mat());
  const st = keep(new cv.Mat());
  const ce = keep(new cv.Mat());
  const n = cv.connectedComponentsWithStats(walls, lab, st, ce, 8, cv.CV_32S);
  const small = new Uint8Array(n);
  for (let k = 1; k < n; k++) if (stat(st, k).area < minPx) small[k] = 1;
  const l = lab.data32S as Int32Array;
  const d = walls.data as Uint8Array;
  for (let i = 0; i < d.length; i++) if (d[i] && small[l[i]]) d[i] = 0;
}

/**
 * Закрывает проёмы в стенах. Идём по строкам: промежуток между двумя участками стены длиной не больше maxGap
 * закрывается, если оба края — торцы горизонтальной стены (их вертикальная толщина не больше maxEnd).
 * То же по столбцам для вертикальных стен. Возвращает число закрытых пикселей.
 */
export function bridgeGaps(wall: Uint8Array, W: number, H: number, maxGap: number, maxEnd: number, out: Uint8Array): number {
  const vRun = runs(wall, W, H, false);
  const hRun = runs(wall, W, H, true);
  let count = 0;
  for (let y = 0; y < H; y++) {
    let last = -1;
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!wall[i]) continue;
      const gap = x - last - 1;
      if (last >= 0 && gap > 0 && gap <= maxGap && vRun[y * W + last] <= maxEnd && vRun[i] <= maxEnd) {
        for (let g = last + 1; g < x; g++) out[y * W + g] = 1;
        count += gap;
      }
      last = x;
    }
  }
  for (let x = 0; x < W; x++) {
    let last = -1;
    for (let y = 0; y < H; y++) {
      const i = y * W + x;
      if (!wall[i]) continue;
      const gap = y - last - 1;
      if (last >= 0 && gap > 0 && gap <= maxGap && hRun[last * W + x] <= maxEnd && hRun[i] <= maxEnd) {
        for (let g = last + 1; g < y; g++) out[g * W + x] = 1;
        count += gap;
      }
      last = y;
    }
  }
  return count;
}

/** Длина непрерывного участка стены через каждый пиксель: по строке (horizontal) или по столбцу. */
function runs(wall: Uint8Array, W: number, H: number, horizontal: boolean): Uint32Array {
  const out = new Uint32Array(W * H);
  const outer = horizontal ? H : W;
  const inner = horizontal ? W : H;
  const idx = horizontal ? (o: number, i: number) => o * W + i : (o: number, i: number) => i * W + o;
  for (let o = 0; o < outer; o++) {
    let start = 0;
    for (let i = 0; i <= inner; i++) {
      if (i < inner && wall[idx(o, i)]) continue;
      for (let j = start; j < i; j++) out[idx(o, j)] = i - start;
      start = i + 1;
    }
  }
  return out;
}

/** Внешний контур области k (дырки внутри — колонны, мебель — не учитываются), в пикселях. */
function contourOf(
  cv: OpenCV,
  labels: Int32Array,
  W: number,
  k: number,
  s: { left: number; top: number; width: number; height: number },
  eps: number,
  keep: <T extends { delete(): void }>(m: T) => T,
): Pt[] | null {
  // Маска в рамке области с полем в 1 пиксель, чтобы контур не прилипал к краю.
  const mw = s.width + 2;
  const mh = s.height + 2;
  const mask = keep(cv.Mat.zeros(mh, mw, cv.CV_8UC1));
  const md = mask.data as Uint8Array;
  for (let y = 0; y < s.height; y++) {
    const row = (s.top + y) * W + s.left;
    for (let x = 0; x < s.width; x++) if (labels[row + x] === k) md[(y + 1) * mw + x + 1] = 255;
  }
  const contours = keep(new cv.MatVector());
  const hier = keep(new cv.Mat());
  cv.findContours(mask, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
  let best = -1;
  let bestA = 0;
  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i);
    const a = cv.contourArea(c);
    if (a > bestA) {
      bestA = a;
      best = i;
    }
    c.delete();
  }
  if (best < 0) return null;
  const c = contours.get(best);
  const approx = keep(new cv.Mat());
  cv.approxPolyDP(c, approx, eps, true);
  c.delete();
  const d = approx.data32S as Int32Array;
  const pts: Pt[] = [];
  // Контур идёт по центрам крайних пикселей; +0.5 переносит его на их внешние грани (граница стены).
  for (let i = 0; i < d.length; i += 2) pts.push({ x: s.left + d[i] - 1 + 0.5, y: s.top + d[i + 1] - 1 + 0.5 });
  return pts;
}

/**
 * Выпрямляет почти горизонтальные и почти вертикальные стороны (до 8°) и убирает лишние вершины,
 * чтобы контур с картинки стал похож на нарисованный в CAD.
 */
export function orthogonalize(poly: Pt[], maxDeg = 8): Pt[] {
  const tan = Math.tan((maxDeg * Math.PI) / 180);
  let p = poly.map((q) => ({ ...q }));
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < p.length; i++) {
      const a = p[i];
      const b = p[(i + 1) % p.length];
      const dx = Math.abs(b.x - a.x);
      const dy = Math.abs(b.y - a.y);
      if (dy <= tan * dx) {
        const y = (a.y + b.y) / 2;
        a.y = y;
        b.y = y;
      } else if (dx <= tan * dy) {
        const x = (a.x + b.x) / 2;
        a.x = x;
        b.x = x;
      }
    }
    p = dropCollinear(p);
  }
  return p;
}

function dropCollinear(p: Pt[]): Pt[] {
  let out = p;
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const a = out[(i - 1 + out.length) % out.length];
      const b = out[i];
      const c = out[(i + 1) % out.length];
      const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      const len = Math.hypot(c.x - a.x, c.y - a.y) || 1;
      if (Math.abs(cross) / len < 0.75 || (Math.abs(b.x - a.x) < 1e-6 && Math.abs(b.y - a.y) < 1e-6)) {
        out = out.filter((_, j) => j !== i);
        changed = true;
        break;
      }
    }
  }
  return out;
}

/** Найденные помещения, которых ещё нет на плане (их внутренняя точка не попадает в существующие). */
export function newRooms(found: DetectedRoom[], existing: Pt[][]): DetectedRoom[] {
  return found.filter((r) => !existing.some((poly) => pointInPolygon(r.inside, poly)));
}
