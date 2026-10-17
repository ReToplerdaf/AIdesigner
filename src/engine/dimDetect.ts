// Масштаб плана без ручной калибровки. Два независимых источника:
//   1) размерная линия: число вроде «10000», под ним (или над ним) тонкая линия; по линии «бежит» окошко чуть шире её
//      и ищет конец — место, где заполнение окошка максимально (засечка, стрелка, выносная линия);
//      длина линии в пикселях и число в мм дают мм на пиксель;
//   2) подписанная площадь: от подписи «17,8 м²» заливается комната, площадь заливки в пикселях² и площадь в м²
//      дают мм на пиксель. Проёмы дверей и окон закрываются морфологическим закрытием растущего размера,
//      а какой из уровней верный, решает согласие между комнатами.
// Модуль не зависит от браузера и OpenCV: работает с маской тёмных пикселей, поэтому проверяется тестами.

import type { Box, Pt } from './types';

/** Маска «чернил»: 1 — тёмный пиксель. */
export interface Ink {
  width: number;
  height: number;
  data: Uint8Array;
}

export function inkOf(rgba: Uint8ClampedArray, width: number, height: number, threshold = 160): Ink {
  const data = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++) data[i] = rgba[i * 4] * 0.3 + rgba[i * 4 + 1] * 0.59 + rgba[i * 4 + 2] * 0.11 < threshold ? 1 : 0;
  return { width, height, data };
}

/**
 * Размер из текста, мм: «10000», «10 000», «3600» — миллиметры; «3,45», «12.60» — метры.
 * Площади («17,8») сюда тоже могут попасть как метры: отсеет проверка линии под числом.
 */
export function dimensionOf(text: string): number | null {
  const t = text.replace(/[oо]/gi, '0').replace(/\s/g, '');
  if (/^\d{3,5}$/.test(t)) {
    const v = +t;
    return v >= 100 ? v : null;
  }
  const m = t.match(/^(\d{1,2})[.,](\d{2,3})$/);
  if (m) return Math.round(parseFloat(`${m[1]}.${m[2]}`) * 1000);
  return null;
}

export interface DimLine {
  /** Концы размерной линии, пиксели. */
  a: Pt;
  b: Pt;
  lenPx: number;
}

/** Окошко считается упёршимся в засечку или выносную, если оно заполнено во столько раз больше, чем на голой линии. */
const PEAK = 1.6;

/**
 * Размерная линия под (или над) горизонтальным числом. numBox — рамка числа, пиксели.
 * Возвращает null, если под числом нет тонкой линии длиннее самого числа.
 */
export function traceDimLine(ink: Ink, numBox: Box): DimLine | null {
  const { width: W, height: H, data } = ink;
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && data[y * W + x] === 1;
  const cx0 = Math.max(0, Math.round(numBox.x));
  const cx1 = Math.min(W - 1, Math.round(numBox.x + numBox.w));
  const span = cx1 - cx0 + 1;
  if (span < 3) return null;
  const rowFull = (y: number) => {
    if (y < 0 || y >= H) return false;
    let n = 0;
    for (let x = cx0; x <= cx1; x++) n += data[y * W + x];
    return n >= 0.9 * span;
  };
  const maxThick = Math.max(3, Math.round(numBox.h / 4));

  // Линия — первая сплошная строка под числом (или над ним), не толще нескольких пикселей: толстая — это стена.
  const findRow = (dir: 1 | -1) => {
    const start = dir > 0 ? Math.round(numBox.y + numBox.h) - 1 : Math.round(numBox.y) + 1;
    for (let i = 0; i <= Math.round(numBox.h * 1.5); i++) {
      const y = start + dir * i;
      if (!rowFull(y)) continue;
      let y0 = y;
      let y1 = y;
      while (rowFull(y0 - 1)) y0--;
      while (rowFull(y1 + 1)) y1++;
      return y1 - y0 + 1 <= maxThick ? { y0, y1 } : null;
    }
    return null;
  };
  const row = findRow(1) ?? findRow(-1);
  if (!row) return null;
  const { y0, y1 } = row;
  const yc = Math.round((y0 + y1) / 2);
  const thick = y1 - y0 + 1;
  const r = thick + 3;
  const fill = (x: number) => {
    let n = 0;
    for (let y = yc - r; y <= yc + r; y++) for (let xx = x - r; xx <= x + r; xx++) if (at(xx, y)) n++;
    return n;
  };
  const base = (2 * r + 1) * thick;
  const onLine = (x: number) => {
    for (let y = y0 - 1; y <= y1 + 1; y++) if (at(x, y)) return true;
    return false;
  };

  // Окошко бежит от числа в сторону; первый всплеск заполнения — засечка, стрелка или выносная.
  // Конец отрезка — самое заполненное место всплеска. Если всплеска нет, конец там, где линия пропала.
  const walk = (dir: 1 | -1) => {
    let x = dir > 0 ? cx1 + r : cx0 - r; // у самого числа в окошко попадают низы цифр
    let last = x;
    let gap = 0;
    for (;;) {
      x += dir;
      if (x < 0 || x >= W) break;
      if (onLine(x)) {
        gap = 0;
        last = x;
      } else if (++gap > 2) break;
      const f = fill(x);
      if (f >= PEAK * base) {
        // Окошко упёрлось в поперечную черту. Сам конец — столбец, где черты больше всего (середина, если таких несколько).
        const col = (xx: number) => {
          let n = 0;
          for (let y = yc - r; y <= yc + r; y++) if (at(xx, y)) n++;
          return n;
        };
        const cs = Array.from({ length: 2 * r + 1 }, (_, k) => col(x + dir * k));
        const top = Math.max(...cs);
        const ks = cs.flatMap((v, k) => (v === top ? [k] : []));
        return x + dir * Math.round((ks[0] + ks[ks.length - 1]) / 2);
      }
    }
    return last;
  };
  const xa = walk(-1);
  const xb = walk(1);
  const lenPx = xb - xa;
  if (lenPx < 1.5 * span) return null;
  return { a: { x: xa, y: yc }, b: { x: xb, y: yc }, lenPx };
}

/** Шахматное расстояние до ближайшего пикселя, где set[i] === 1 (две прохода). */
function chessDist(set: Uint8Array, W: number, H: number): Int32Array {
  const INF = 1 << 29;
  const d = new Int32Array(W * H);
  for (let i = 0; i < d.length; i++) d[i] = set[i] ? 0 : INF;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!d[i]) continue;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + 1);
      if (y > 0) {
        v = Math.min(v, d[i - W] + 1);
        if (x > 0) v = Math.min(v, d[i - W - 1] + 1);
        if (x < W - 1) v = Math.min(v, d[i - W + 1] + 1);
      }
      d[i] = v;
    }
  for (let y = H - 1; y >= 0; y--)
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      if (!d[i]) continue;
      let v = d[i];
      if (x < W - 1) v = Math.min(v, d[i + 1] + 1);
      if (y < H - 1) {
        v = Math.min(v, d[i + W] + 1);
        if (x < W - 1) v = Math.min(v, d[i + W + 1] + 1);
        if (x > 0) v = Math.min(v, d[i + W - 1] + 1);
      }
      d[i] = v;
    }
  return d;
}

/** Морфология квадратом (2r+1)²: расширение — расстояние до множества ≤ r, сужение — расстояние до дополнения > r. */
function dilate(set: Uint8Array, W: number, H: number, r: number): Uint8Array {
  const d = chessDist(set, W, H);
  return Uint8Array.from(d, (v) => (v <= r ? 1 : 0));
}
function erode(set: Uint8Array, W: number, H: number, r: number): Uint8Array {
  const inv = Uint8Array.from(set, (v) => 1 - v);
  const d = chessDist(inv, W, H);
  return Uint8Array.from(d, (v) => (v > r ? 1 : 0));
}

export interface AreaSeed {
  /** Где подписана площадь, пиксели. */
  at: Pt;
  m2: number;
}

export interface AreaFit {
  /** Заливка комнаты: площадь (с дырками от мебели и текста) и рамка, пиксели. */
  areaPx: number;
  box: Box;
  /** мм на пиксель по этой комнате. */
  mmPerPx: number;
  /** Насколько комната прямоугольная: площадь заливки к площади рамки, 1 — ровный прямоугольник. */
  rect: number;
}

/**
 * Комнаты вокруг подписей площади. Для каждой подписи — все устойчивые варианты заливки, а какой верный,
 * решает scaleFromAreas по согласию комнат. Варианты получаются двумя способами:
 *  - по всем линиям плана: двери (полотно и дуга) и окна (стёкла) обычно сами замыкают комнату;
 *  - по одним стенам (тонкое убрано) с закрытием проёмов растущего размера: при малом закрытии комната сливается
 *    с соседями через двери, при достаточном становится собой.
 */
export function roomFills(ink: Ink, seeds: AreaSeed[]): AreaFit[][] {
  // Для заливки хватает ~800 точек по длинной стороне: площадь всё равно сверяется с точностью в проценты.
  const f = Math.max(1, Math.ceil(Math.max(ink.width, ink.height) / 800));
  const W = Math.ceil(ink.width / f);
  const H = Math.ceil(ink.height / f);
  const raw = new Uint8Array(W * H);
  for (let y = 0; y < ink.height; y++)
    for (let x = 0; x < ink.width; x++) if (ink.data[y * ink.width + x]) raw[Math.floor(y / f) * W + Math.floor(x / f)] = 1;
  const small = seeds.map((s) => ({ at: { x: s.at.x / f, y: s.at.y / f }, m2: s.m2 }));

  // Тонкое — текст, мебель, дуги дверей, стёкла окон — убираем, мелкие обрывки (остатки жирного текста) тоже: остаются стены.
  const walls = dropSmall(dilate(erode(raw, W, H, 1), W, H, 1), W, H, Math.max(8, Math.min(W, H) / 40));
  const toWall = chessDist(walls, W, H);
  const levels = [1, 2, 3, 4, 6, 8, 11, 16, 22, 32, 45, 64, 90, 128].filter((r) => r < Math.min(W, H) / 2);
  const masks = function* () {
    yield raw;
    yield walls;
    // Закрытие: стены, раздутые на r и ужатые обратно, — проёмы уже 2r+1 закрыты, остальное как было.
    for (const r of levels) yield erode(Uint8Array.from(toWall, (v) => (v <= r ? 1 : 0)), W, H, r);
  };

  const found: AreaFit[][] = seeds.map(() => []);
  const prev: (number | null)[] = seeds.map(() => null);
  const ctx = { seen: new Int32Array(W * H), queue: new Int32Array(W * H), stamp: 0 };
  let i = 0;
  for (const m of masks()) {
    small.forEach((s, si) => {
      const fit = floodRoom(m, W, H, s.at, ctx);
      // Заливка по всем линиям берётся сразу, по стенам — когда устойчива на двух уровнях закрытия подряд:
      // случайная заливка через полузакрытый проём так не делает.
      const p = prev[si];
      prev[si] = i === 0 ? null : fit?.areaPx ?? null;
      if (!fit || (i > 0 && (p == null || Math.abs(p - fit.areaPx) / fit.areaPx > 0.03))) return;
      const areaPx = fit.areaPx * f * f;
      if (found[si].some((o) => Math.abs(o.areaPx - areaPx) / areaPx < 0.03)) return;
      const b = fit.box;
      found[si].push({
        areaPx,
        box: { x: b.x * f, y: b.y * f, w: b.w * f, h: b.h * f },
        mmPerPx: Math.sqrt((s.m2 * 1e6) / areaPx),
        rect: fit.areaPx / (b.w * b.h),
      });
    });
    i++;
  }
  return found;
}

/** Заливка свободного места от точки. null — ушла за край картинки (наружу дома) или почти на всю картинку. */
function floodRoom(
  closed: Uint8Array,
  W: number,
  H: number,
  at: Pt,
  ctx: { seen: Int32Array; queue: Int32Array; stamp: number },
): { areaPx: number; box: Box } | null {
  const start = freeNear(closed, W, H, at, 8);
  if (start < 0) return null;
  const { seen, queue } = ctx;
  const stamp = ++ctx.stamp;
  let head = 0;
  let tail = 0;
  queue[tail++] = start;
  seen[start] = stamp;
  let minX = W, maxX = 0, minY = H, maxY = 0;
  while (head < tail) {
    const i = queue[head++];
    const x = i % W;
    const y = (i - x) / W;
    if (x === 0 || y === 0 || x === W - 1 || y === H - 1) return null;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    for (const j of [i - 1, i + 1, i - W, i + W])
      if (!closed[j] && seen[j] !== stamp) {
        seen[j] = stamp;
        queue[tail++] = j;
      }
  }
  if (tail > (W * H) / 2) return null;
  return { areaPx: filledArea(seen, stamp, W, minX, minY, maxX, maxY), box: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } };
}

/** Убирает связные куски, у которых рамка меньше minSide по обеим сторонам. */
function dropSmall(set: Uint8Array, W: number, H: number, minSide: number): Uint8Array {
  const out = set.slice();
  const seen = new Uint8Array(W * H);
  const stack: number[] = [];
  const comp: number[] = [];
  for (let s = 0; s < W * H; s++) {
    if (!set[s] || seen[s]) continue;
    let minX = W, maxX = 0, minY = H, maxY = 0;
    comp.length = 0;
    stack.push(s);
    seen[s] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      comp.push(i);
      const x = i % W;
      const y = (i - x) / W;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          if (set[j] && !seen[j]) {
            seen[j] = 1;
            stack.push(j);
          }
        }
    }
    if (maxX - minX < minSide && maxY - minY < minSide) for (const i of comp) out[i] = 0;
  }
  return out;
}

/** Ближайший к точке свободный пиксель (подпись могла оставить на месте точку-«стену»). */
function freeNear(closed: Uint8Array, W: number, H: number, p: Pt, maxR: number): number {
  const px = Math.round(p.x);
  const py = Math.round(p.y);
  for (let rr = 0; rr <= maxR; rr++)
    for (let dy = -rr; dy <= rr; dy++)
      for (let dx = -rr; dx <= rr; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== rr) continue;
        const x = px + dx;
        const y = py + dy;
        if (x > 0 && y > 0 && x < W - 1 && y < H - 1 && !closed[y * W + x]) return y * W + x;
      }
  return -1;
}

/** Площадь заливки вместе с дырками внутри неё (мебель, остатки текста): всё в рамке минус то, что снаружи. */
function filledArea(seen: Int32Array, stamp: number, W: number, x0: number, y0: number, x1: number, y1: number): number {
  const bw = x1 - x0 + 3;
  const bh = y1 - y0 + 3;
  const out = new Uint8Array(bw * bh);
  const inRegion = (bx: number, by: number) => {
    const x = bx + x0 - 1;
    const y = by + y0 - 1;
    return bx > 0 && by > 0 && bx < bw - 1 && by < bh - 1 && seen[y * W + x] === stamp;
  };
  const q: number[] = [0];
  out[0] = 1;
  let outside = 0;
  while (q.length) {
    const i = q.pop()!;
    outside++;
    const bx = i % bw;
    const by = (i - bx) / bw;
    for (const [nx, ny] of [[bx - 1, by], [bx + 1, by], [bx, by - 1], [bx, by + 1]]) {
      if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
      const j = ny * bw + nx;
      if (out[j] || inRegion(nx, ny)) continue;
      out[j] = 1;
      q.push(j);
    }
  }
  return bw * bh - outside;
}

/** Одна оценка масштаба и откуда она взялась. */
export interface ScaleGuess<T> {
  mmPerPx: number;
  source: T;
  /** Сколько других независимых оценок с ней согласны (расхождение до TOL). */
  support: number;
}

/** Две оценки масштаба считаются согласными при таком расхождении. */
export const TOL = 0.04;
export const agree = (a: number, b: number) => Math.abs(a - b) / Math.max(a, b) <= TOL;

/**
 * Масштаб по площадям: у каждой подписи несколько вариантов заливки, выбираем масштаб, с которым согласно больше всего
 * подписей, и для каждой подписи — её вариант, ближайший к нему. extra — масштабы из других источников (размеров),
 * они тоже голосуют.
 */
export function scaleFromAreas(fills: AreaFit[][], extra: number[] = []): { mmPerPx: number; votes: number; picks: (AreaFit | null)[] } | null {
  const all = fills.flat().map((f) => f.mmPerPx).concat(extra);
  let best: { mmPerPx: number; votes: number } | null = null;
  for (const s of all) {
    const votes = fills.filter((fs) => fs.some((f) => agree(f.mmPerPx, s))).length + extra.filter((e) => agree(e, s)).length;
    if (!best || votes > best.votes) best = { mmPerPx: s, votes };
  }
  if (!best) return null;
  const s = best.mmPerPx;
  const picks = fills.map((fs) => {
    const ok = fs.filter((f) => agree(f.mmPerPx, s));
    return ok.length ? ok.reduce((a, b) => (Math.abs(a.mmPerPx - s) < Math.abs(b.mmPerPx - s) ? a : b)) : null;
  });
  // Итог — медиана согласных оценок, а не первая попавшаяся.
  const agreeing = [...picks.filter((p): p is AreaFit => !!p).map((p) => p.mmPerPx), ...extra.filter((e) => agree(e, s))].sort((a, b) => a - b);
  return { mmPerPx: agreeing[Math.floor(agreeing.length / 2)] ?? s, votes: best.votes, picks };
}

/** Сколько других оценок согласны с каждой. */
export function withSupport<T>(guesses: { mmPerPx: number; source: T }[]): ScaleGuess<T>[] {
  return guesses.map((g, i) => ({ ...g, support: guesses.filter((h, j) => j !== i && agree(h.mmPerPx, g.mmPerPx)).length }));
}
