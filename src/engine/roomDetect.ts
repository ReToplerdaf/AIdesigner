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
  /**
   * Во сколько раз сильнее обычного чистить тонкие линии (мебель, штриховку): 1 — обычно. Больше — пропадают
   * и более толстые линии; помогает, когда комната вышла меньше подписанной площади из-за мебели.
   */
  thinScale?: number;
  /**
   * Закрывать широкие проёмы вдоль границы дома (панорамные окна), по умолчанию да. Без этого в контур
   * комнаты попадают ниши оконных проёмов, зато эркер не отрезается от комнаты.
   */
  windowBridges?: boolean;
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
/**
 * Самый широкий проём в стене под 45°, мм. Шире не берём: косые линии мебели и дверных полотен похожи на торцы
 * косых стен, и длинные диагональные мостики резали бы комнаты наискосок.
 */
const DIAG_GAP_MM = 1400;
/** Тёмные области толще этого — заливка пола или чёрный фон, а не стена, мм. */
const FILL_MM = 1000;
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
    const { walls, wallPx, tMin } = wallMask(cv, plan, keep, opts.thinScale);

    // 4. Проёмы. Мостик ставится, только если по обе стороны — торцы стены, а не длинные стены поперёк:
    // иначе узкий коридор или санузел «зашился» бы целиком.
    await opts.onStage?.('gaps');
    const wd = walls.data as Uint8Array;
    const maxGapPx = maxGapMm / mmPerPx;
    const maxEndPx = Math.max(1.6 * wallPx, 3 * tMin, 3);
    const bridge = new Uint8Array(N);
    let bridgedPx = bridgeGaps(wd, W, H, maxGapPx, maxEndPx, bridge, 2, 1.5 * wallPx);
    bridgedPx += bridgeDiagonal(wd, W, H, Math.min(maxGapPx, DIAG_GAP_MM / mmPerPx), maxEndPx, 2, bridge);
    bridgedPx += bridgeSkewed(cv, walls, wallPx, maxGapPx, maxEndPx, bridge, keep);

    // Граница дома, если её задали: всё снаружи — стена. Окна любой ширины на наружных стенах
    // закрываются мостиком вдоль границы, поэтому комната с панорамным окном не «вытекает» наружу.
    let inside: Uint8Array | null = null;
    if (opts.boundary && opts.boundary.length >= 3) {
      const windows = opts.windowBridges ?? true;
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
      bridgeGaps(wd, W, H, Math.max(W, H), maxEndPx, long, 2, 1.5 * wallPx);
      for (let i = 0; i < N && windows; i++)
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
    // Внутренняя точка — самая далёкая от стен: она остаётся внутри и при другой очистке линий.
    const fdist = keep(new cv.Mat());
    cv.distanceTransform(free, fdist, cv.DIST_L2, 3);
    const fdd = fdist.data32F as Float32Array;
    const firstPx = new Int32Array(n2).fill(-1);
    for (let i = 0; i < N; i++) if (firstPx[l2[i]] < 0 || fdd[i] > fdd[firstPx[l2[i]]]) firstPx[l2[i]] = i;

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
    // Область внутри другого помещения — контур мебели жирной линией (остров, шкаф), а не комната.
    const outer = rooms.filter((r) => !rooms.some((o) => o !== r && pointInPolygon(r.inside, o.poly)));
    return { rooms: outer, wallMm: Math.round(wallPx * mmPerPx), bridgedPx };
  } finally {
    for (const m of mats) m.delete();
  }
}

/** Шаги 1–3: маска стен (255 — стена), оценка толщины стен и порог «тонких» линий, пиксели. */
export function wallMask(cv: OpenCV, plan: RasterPlan, keep: Keep, thinScale = 1): { walls: OpenCV; wallPx: number; tMin: number } {
  const { width: W, height: H, mmPerPx } = plan;
    const src = keep(cv.matFromImageData({ data: plan.rgba, width: W, height: H }));
    const gray = keep(new cv.Mat());
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    // 1. Всё, что заметно темнее бумаги, — 255. Стены бывают и чёрными, и светло-серыми (на обмерных планах
    // заливка 170–195), поэтому порог считается от цвета листа, а не делит тёмное и светлое пополам.
    const ink = keep(new cv.Mat());
    const paper = grayPercentile(gray.data as Uint8Array, 0.9);
    cv.threshold(gray, ink, Math.max(100, paper - 30), 255, cv.THRESH_BINARY_INV);
    // Заливка пола (цветом или серым) толще любой стены: всё, во что пролезает квадрат FILL_MM, — не стена.
    const fillPx = Math.round(FILL_MM / mmPerPx);
    if (fillPx >= 5) {
      const fill = keep(new cv.Mat());
      const fk = keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(fillPx, fillPx)));
      cv.morphologyEx(ink, fill, cv.MORPH_OPEN, fk);
      cv.subtract(ink, fill, ink);
    }

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
    let tMin = Math.round(Math.min((THIN_LINE_MM / mmPerPx) * thinScale, 0.4 * wallPx * Math.min(thinScale, 2)));
    if (wallPx < 4) tMin = 1; // тонкие стены одной линией: не чистим, иначе пропадут и стены
    tMin = Math.max(1, tMin);
    const walls = keep(new cv.Mat());
    if (tMin > 1) {
      // Круглое ядро: квадратное «не пролезает» в косую стену той же толщины (диагональ квадрата длиннее стороны),
      // и тонкие перегородки под углом пропадали бы вместе с мебелью.
      const k = keep(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(tMin, tMin)));
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
    const maxEnd = Math.max(1.6 * wallPx, 3 * tMin, 3);
    bridgeGaps(wd, W, H, Math.max(W, H), maxEnd, bridge, 2, 1.5 * wallPx);
    bridgeDiagonal(wd, W, H, DIAG_GAP_MM / mmPerPx, maxEnd, 2, bridge);
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

/** Яркость, темнее которой доля q пикселей картинки. */
function grayPercentile(g: Uint8Array, q: number): number {
  const hist = new Uint32Array(256);
  for (let i = 0; i < g.length; i++) hist[g[i]]++;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= q * g.length) return v;
  }
  return 255;
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
 * закрывается, если оба края — торцы горизонтальной стены: вертикальная толщина не больше maxEnd, а вдоль строки
 * стена тянется хотя бы в alongRatio раз дальше своей толщины или хотя бы на minAlong. Второе условие отсекает
 * косые стены: строка пересекает их коротким отрезком, и без него комнату между двумя скосами «зашило» бы поперёк.
 * Короткий торец тонкой перегородки у двери (200 мм при толщине 100) проходит по первой части условия,
 * простенок толстой наружной стены у окна — по второй. То же по столбцам для вертикальных стен.
 * Возвращает число закрытых пикселей.
 */
export function bridgeGaps(
  wall: Uint8Array,
  W: number,
  H: number,
  maxGap: number,
  maxEnd: number,
  out: Uint8Array,
  alongRatio = 0,
  minAlong = 0,
  junctions = true,
): number {
  const long = (along: number, across: number) => along >= Math.min(alongRatio * across, minAlong || Infinity);
  const vRun = runs(wall, W, H, false);
  const hRun = runs(wall, W, H, true);
  /**
   * Край стены у промежутка: 2 — свободный торец; 1 — торец у примыкания поперечной стены (дверь прямо у угла:
   * сам крайний пиксель лежит в поперечной стене, а тонкая перегородка начинается за ней); 0 — не торец.
   * back — шаг по индексу вглубь стены, limit — сколько шагов можно сделать, не выходя за край картинки.
   */
  const end = (i: number, back: number, limit: number, along: Uint32Array, across: Uint32Array): number => {
    if (across[i] <= maxEnd) return long(along[i], across[i]) ? 2 : 0;
    if (!junctions) return 0;
    for (let j = 1, p = i + back; j <= Math.min(limit, maxEnd) && wall[p]; j++, p += back)
      // За примыканием должна начинаться настоящая стена, длинная вдоль, а не штриховка или значок.
      if (across[p] <= maxEnd) return long(along[p], across[p]) && along[p] >= minAlong ? 1 : 0;
    return 0;
  };
  // Хотя бы один край — свободный торец: два примыкания друг напротив друга — это коридор, а не дверь.
  const ok = (a: number, b: number) => a > 0 && b > 0 && a + b >= 3;
  let count = 0;
  for (let y = 0; y < H; y++) {
    let last = -1;
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!wall[i]) continue;
      const gap = x - last - 1;
      if (last >= 0 && gap > 0 && gap <= maxGap && ok(end(y * W + last, -1, last, hRun, vRun), end(i, 1, W - 1 - x, hRun, vRun))) {
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
      if (last >= 0 && gap > 0 && gap <= maxGap && ok(end(last * W + x, -W, last, vRun, hRun), end(i, W, H - 1 - y, vRun, hRun))) {
        for (let g = last + 1; g < y; g++) out[g * W + x] = 1;
        count += gap;
      }
      last = y;
    }
  }
  return count;
}

/**
 * То же для стен под 45° (скошенные углы, эркеры): идём по диагоналям. Торец косой стены — тонкий поперёк
 * (не толще maxEnd) и вдоль в alongRatio раз длиннее, чем поперёк; у прямых стен, пересечённых по диагонали,
 * оба размера одинаковы, поэтому коридоры и простенки диагональными мостиками не зашиваются.
 */
export function bridgeDiagonal(
  wall: Uint8Array,
  W: number,
  H: number,
  maxGap: number,
  maxEnd: number,
  alongRatio: number,
  out: Uint8Array,
): number {
  const down = diagRuns(wall, W, H, 1); // вдоль (1, 1)
  const up = diagRuns(wall, W, H, -1); // вдоль (1, −1)
  let count = 0;
  for (const dir of [1, -1] as const) {
    const along = dir === 1 ? down : up;
    const across = dir === 1 ? up : down;
    const isEnd = (i: number) => across[i] * Math.SQRT2 <= maxEnd && along[i] >= alongRatio * across[i];
    forEachDiagonal(W, H, dir, (line) => {
      let last = -1;
      for (let j = 0; j < line.length; j++) {
        const i = line[j];
        if (!wall[i]) continue;
        const gap = j - last - 1;
        if (last >= 0 && gap > 0 && gap * Math.SQRT2 <= maxGap && isEnd(line[last]) && isEnd(i)) {
          for (let g = last + 1; g < j; g++) {
            out[line[g]] = 1;
            // Соседний пиксель по строке: диагональная цепочка пикселей иначе протекает «наискосок» (4-связность).
            const k = line[g];
            if (k % W < W - 1) out[k + 1] = 1;
          }
          count += gap;
        }
        last = j;
      }
    });
  }
  return count;
}

/**
 * Проёмы в стенах под произвольным углом (косые перегородки под 30°, 60° и т. п.). Углы таких стен находятся
 * преобразованием Хафа; для каждого картинка поворачивается так, чтобы стены легли по осям, и проёмы
 * закрываются как обычно. Углы ближе 20° к осям не берём: там прямые стены, пересечённые наискосок,
 * похожи на торцы, и мостики зашили бы коридоры.
 */
function bridgeSkewed(
  cv: OpenCV,
  walls: OpenCV,
  wallPx: number,
  maxGap: number,
  maxEnd: number,
  out: Uint8Array,
  keep: Keep,
): number {
  const W = walls.cols;
  const H = walls.rows;
  const lines = keep(new cv.Mat());
  const minLen = Math.max(20, 6 * wallPx);
  cv.HoughLinesP(walls, lines, 1, Math.PI / 360, Math.round(minLen), minLen, Math.max(2, wallPx / 2));
  const L = lines.data32S as Int32Array;
  // Суммарная длина отрезков по углам с шагом 1°.
  const hist = new Float64Array(180);
  for (let i = 0; i < L.length; i += 4) {
    const dx = L[i + 2] - L[i];
    const dy = L[i + 3] - L[i + 1];
    const a = (Math.round((Math.atan2(dy, dx) * 180) / Math.PI) + 180) % 180;
    hist[a] += Math.hypot(dx, dy);
  }
  const angles: number[] = [];
  for (let a = 0; a < 180; a++) {
    const fromAxis = Math.min(a % 90, 90 - (a % 90));
    if (fromAxis < 20 || Math.abs(fromAxis - 45) < 3) continue; // оси — обычные мостики, 45° — диагональные
    const sum = hist[(a + 179) % 180] + hist[a] + hist[(a + 1) % 180];
    if (sum >= 3 * minLen && hist[a] >= hist[(a + 179) % 180] && hist[a] >= hist[(a + 1) % 180]) angles.push(a);
  }
  let count = 0;
  for (const a of angles.slice(0, 4)) {
    // Поворот на холст с запасом, чтобы углы картинки не обрезались.
    const D = Math.ceil(Math.hypot(W, H));
    const toRot = cv.getRotationMatrix2D(new cv.Point(W / 2, H / 2), a, 1);
    const td = toRot.data64F as Float64Array;
    td[2] += (D - W) / 2;
    td[5] += (D - H) / 2;
    const rot = keep(new cv.Mat());
    cv.warpAffine(walls, rot, toRot, new cv.Size(D, D), cv.INTER_NEAREST, cv.BORDER_CONSTANT, new cv.Scalar(0));
    const rb = new Uint8Array(D * D);
    count += bridgeGaps(rot.data as Uint8Array, D, D, maxGap, maxEnd, rb, 3, 0, false);
    const bm = keep(cv.matFromArray(D, D, cv.CV_8UC1, rb.map((v) => v * 255)));
    // Мостик чуть толще, чтобы после поворота обратно в нём не осталось щелей между пикселями.
    cv.dilate(bm, bm, keep(cv.Mat.ones(3, 3, cv.CV_8U)));
    const back = keep(new cv.Mat());
    // Обратное преобразование: [R | t]⁻¹ = [Rᵀ | −Rᵀt] (R — поворот).
    const [r00, r01, t0, r10, r11, t1] = Array.from(td);
    const inv = keep(cv.matFromArray(2, 3, cv.CV_64F, [r00, r10, -(r00 * t0 + r10 * t1), r01, r11, -(r01 * t0 + r11 * t1)]));
    toRot.delete();
    cv.warpAffine(bm, back, inv, new cv.Size(W, H), cv.INTER_NEAREST, cv.BORDER_CONSTANT, new cv.Scalar(0));
    const bd = back.data as Uint8Array;
    for (let i = 0; i < bd.length; i++) if (bd[i]) out[i] = 1;
  }
  return count;
}

/** Обходит все диагонали картинки направления (1, dir), передавая индексы пикселей по порядку. */
function forEachDiagonal(W: number, H: number, dir: 1 | -1, fn: (line: number[]) => void) {
  const starts: [number, number][] = [];
  if (dir === 1) {
    for (let y = H - 1; y > 0; y--) starts.push([0, y]);
    for (let x = 0; x < W; x++) starts.push([x, 0]);
  } else {
    for (let y = 0; y < H - 1; y++) starts.push([0, y]);
    for (let x = 0; x < W; x++) starts.push([x, H - 1]);
  }
  const line: number[] = [];
  for (const [x0, y0] of starts) {
    line.length = 0;
    for (let x = x0, y = y0; x < W && y >= 0 && y < H; x++, y += dir) line.push(y * W + x);
    fn(line);
  }
}

/** Длина участка стены через каждый пиксель вдоль диагонали (1, dir), в шагах. */
function diagRuns(wall: Uint8Array, W: number, H: number, dir: 1 | -1): Uint32Array {
  const out = new Uint32Array(W * H);
  forEachDiagonal(W, H, dir, (line) => {
    let start = 0;
    for (let j = 0; j <= line.length; j++) {
      if (j < line.length && wall[line[j]]) continue;
      for (let k = start; k < j; k++) out[line[k]] = j - start;
      start = j + 1;
    }
  });
  return out;
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

/** Помещение и площадь с его подписи на плане. */
export interface AreaTarget {
  /** Точка внутри помещения, мм. */
  inside: Pt;
  m2: number;
}

/**
 * Варианты распознавания по очереди: не закрывать окна вдоль границы (эркер отрезан от комнаты), сильнее чистить
 * линии (мебель режет комнату), шире закрывать проёмы (комната утекает).
 */
const VARIANTS: Pick<DetectOptions, 'thinScale' | 'maxGapMm' | 'windowBridges'>[] = [
  { windowBridges: false },
  { thinScale: 1.6 },
  { thinScale: 2.4 },
  { maxGapMm: 3600 },
  { thinScale: 1.6, maxGapMm: 3600 },
];

/**
 * Подгонка под подписанную площадь. Пока площадь контура расходится с подписью больше чем на tol, план
 * распознаётся заново с другими настройками очистки линий и проёмов; из всех вариантов берётся контур,
 * ближайший к подписи и не захватывающий соседние помещения (others — их внутренние точки; точки, которые
 * уже лежат в исходном контуре, не мешают: значит, комната и была одна).
 * Возвращает новый контур для каждой цели или null, если лучше не стало.
 */
export async function fitToAreas(
  cv: OpenCV,
  plan: RasterPlan,
  opts: DetectOptions,
  targets: (AreaTarget & { poly: Pt[] })[],
  others: Pt[],
  tol = 0.02,
  onVariant?: (i: number, n: number) => Promise<void> | void,
): Promise<(Pt[] | null)[]> {
  // Подпись округлена до 0,1 м², поэтому у маленьких комнат допуск не меньше 0,1 м².
  const off = (poly: Pt[], m2: number) => Math.max(0, Math.abs(polyArea(poly) / 1e6 - m2) - 0.05) / m2;
  const best = targets.map((t) => ({ poly: t.poly, off: off(t.poly, t.m2), changed: false }));
  for (let v = 0; v < VARIANTS.length; v++) {
    if (best.every((b) => b.off <= tol)) break;
    await onVariant?.(v, VARIANTS.length);
    const { rooms } = await detectRooms(cv, plan, { ...opts, ...VARIANTS[v], onStage: undefined });
    targets.forEach((t, i) => {
      if (best[i].off <= tol) return;
      const r = rooms.find((q) => pointInPolygon(t.inside, q.poly));
      if (!r || others.some((o) => !pointInPolygon(o, t.poly) && pointInPolygon(o, r.poly))) return;
      const o = off(r.poly, t.m2);
      if (o < best[i].off) best[i] = { poly: r.poly, off: o, changed: true };
    });
  }
  return best.map((b) => (b.changed ? b.poly : null));
}

/** Найденные помещения, которых ещё нет на плане (их внутренняя точка не попадает в существующие). */
export function newRooms(found: DetectedRoom[], existing: Pt[][]): DetectedRoom[] {
  return found.filter((r) => !existing.some((poly) => pointInPolygon(r.inside, poly)));
}
