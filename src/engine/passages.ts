// Проходы в стенах: одно общее отверстие на стену между двумя помещениями.
// Все кабели из помещения в помещение идут через него, а не пробивают стену каждый в своём месте.

import { manhattan } from './geometry';
import type { Pt, Room } from './types';

/** Стены считаются общими, если между гранями помещений не больше этого (толщина стены), мм. */
const WALL_GAP = 450;
/** Минимальная длина общего участка стены, мм. */
const MIN_OVERLAP = 500;
/** Отверстие не ставится ближе этого к углу, мм. */
const CORNER_MARGIN = 150;
/**
 * Штраф за каждое лишнее пересечение стены при выборе пути, мм: лучше немного длиннее,
 * но через меньшее число стен (меньше отверстий и гильз).
 */
export const WALL_PENALTY = 2500;

export interface Passage {
  /** «id1|id2» в алфавитном порядке. */
  key: string;
  rooms: [string, string];
  /** Точка отверстия на оси стены. */
  pos: Pt;
  /** Общий участок стены (по оси), вдоль которого отверстие можно двигать. */
  a: Pt;
  b: Pt;
  /** Стена вертикальная на плане (x = const). */
  vertical: boolean;
}

export const passageKey = (r1: string, r2: string) => (r1 < r2 ? `${r1}|${r2}` : `${r2}|${r1}`);

type Edge = { a: Pt; b: Pt };
const edges = (poly: Pt[]): Edge[] => poly.map((a, i) => ({ a, b: poly[(i + 1) % poly.length] }));

/** Общий участок двух граней, если они параллельны осям, лежат рядом и перекрываются. */
function shared(e1: Edge, e2: Edge): { a: Pt; b: Pt; vertical: boolean } | null {
  const v1 = e1.a.x === e1.b.x;
  const h1 = e1.a.y === e1.b.y;
  const v2 = e2.a.x === e2.b.x;
  const h2 = e2.a.y === e2.b.y;
  if (v1 && v2 && Math.abs(e1.a.x - e2.a.x) <= WALL_GAP) {
    const lo = Math.max(Math.min(e1.a.y, e1.b.y), Math.min(e2.a.y, e2.b.y));
    const hi = Math.min(Math.max(e1.a.y, e1.b.y), Math.max(e2.a.y, e2.b.y));
    if (hi - lo < MIN_OVERLAP) return null;
    const x = (e1.a.x + e2.a.x) / 2;
    return { a: { x, y: lo }, b: { x, y: hi }, vertical: true };
  }
  if (h1 && h2 && Math.abs(e1.a.y - e2.a.y) <= WALL_GAP) {
    const lo = Math.max(Math.min(e1.a.x, e1.b.x), Math.min(e2.a.x, e2.b.x));
    const hi = Math.min(Math.max(e1.a.x, e1.b.x), Math.max(e2.a.x, e2.b.x));
    if (hi - lo < MIN_OVERLAP) return null;
    const y = (e1.a.y + e2.a.y) / 2;
    return { a: { x: lo, y }, b: { x: hi, y }, vertical: false };
  }
  return null;
}

/** Точка на общем участке стены: ручная (спроецированная на стену) или середина участка. */
export function snapToWall(p: Pick<Passage, 'a' | 'b' | 'vertical'>, want?: Pt): Pt {
  const r = (v: number) => Math.round(v);
  if (p.vertical) {
    const lo = p.a.y + CORNER_MARGIN;
    const hi = p.b.y - CORNER_MARGIN;
    const y = want ? Math.min(Math.max(want.y, lo), hi) : (p.a.y + p.b.y) / 2;
    return { x: r(p.a.x), y: r(y) };
  }
  const lo = p.a.x + CORNER_MARGIN;
  const hi = p.b.x - CORNER_MARGIN;
  const x = want ? Math.min(Math.max(want.x, lo), hi) : (p.a.x + p.b.x) / 2;
  return { x: r(x), y: r(p.a.y) };
}

/** Все возможные проходы: по одному на каждую пару смежных помещений (по самому длинному общему участку). */
export function findPassages(rooms: Room[], manual: Record<string, Pt> = {}): Passage[] {
  const out: Passage[] = [];
  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      let best: ReturnType<typeof shared> = null;
      let bestLen = 0;
      for (const e1 of edges(rooms[i].poly)) {
        for (const e2 of edges(rooms[j].poly)) {
          const s = shared(e1, e2);
          if (s && manhattan(s.a, s.b) > bestLen) {
            best = s;
            bestLen = manhattan(s.a, s.b);
          }
        }
      }
      if (!best) continue;
      const key = passageKey(rooms[i].id, rooms[j].id);
      out.push({
        key,
        rooms: [rooms[i].id, rooms[j].id].sort() as [string, string],
        a: best.a,
        b: best.b,
        vertical: best.vertical,
        pos: snapToWall(best, manual[key]),
      });
    }
  }
  return out;
}

/**
 * Путь из точки `from` в помещении `fromRoom` в точку `to` в помещении `toRoom` через проходы:
 * кратчайший по ортогональной длине. Если помещения совпадают, неизвестны или не связаны, проходов нет.
 */
export function passRoute(
  from: Pt,
  fromRoom: string | null,
  to: Pt,
  toRoom: string | null,
  passages: Passage[],
): Passage[] {
  if (!fromRoom || !toRoom || fromRoom === toRoom) return [];
  // Дейкстра по вершинам «проход + помещение, в котором мы находимся после него».
  type Node = { p: Passage; room: string };
  const dist = new Map<string, number>();
  const prev = new Map<string, string | null>();
  const nodes = new Map<string, Node>();
  const id = (n: Node) => `${n.p.key}>${n.room}`;
  const open: { n: Node; d: number }[] = [];
  const push = (n: Node, d: number, from: string | null) => {
    const k = id(n);
    if (d >= (dist.get(k) ?? Infinity)) return;
    dist.set(k, d);
    prev.set(k, from);
    nodes.set(k, n);
    open.push({ n, d });
  };
  const other = (p: Passage, room: string) => (p.rooms[0] === room ? p.rooms[1] : p.rooms[0]);
  for (const p of passages) if (p.rooms.includes(fromRoom)) push({ p, room: other(p, fromRoom) }, manhattan(from, p.pos) + WALL_PENALTY, null);

  let bestEnd: string | null = null;
  let bestD = Infinity;
  while (open.length) {
    open.sort((x, y) => x.d - y.d);
    const { n, d } = open.shift()!;
    const k = id(n);
    if (d > (dist.get(k) ?? Infinity) || d >= bestD) continue;
    if (n.room === toRoom) {
      const total = d + manhattan(n.p.pos, to);
      if (total < bestD) {
        bestD = total;
        bestEnd = k;
      }
      continue;
    }
    for (const p of passages) {
      if (p === n.p || !p.rooms.includes(n.room)) continue;
      push({ p, room: other(p, n.room) }, d + manhattan(n.p.pos, p.pos) + WALL_PENALTY, k);
    }
  }
  const route: Passage[] = [];
  for (let k = bestEnd; k; k = prev.get(k) ?? null) route.unshift(nodes.get(k)!.p);
  return route;
}

type Dir = 'h' | 'v' | null;

/** Ортогональный участок a → b; dir — в каком направлении обязательно уйти из a и прийти в b. */
function leg(a: Pt, da: Dir, b: Pt, db: Dir): Pt[] {
  if (da === 'h' && db === 'h') {
    const mx = Math.round((a.x + b.x) / 2);
    return [{ x: mx, y: a.y }, { x: mx, y: b.y }, b];
  }
  if (da === 'v' && db === 'v') {
    const my = Math.round((a.y + b.y) / 2);
    return [{ x: a.x, y: my }, { x: b.x, y: my }, b];
  }
  if (da === 'v' || db === 'h') return [{ x: a.x, y: b.y }, b];
  return [{ x: b.x, y: a.y }, b];
}

/**
 * Ортогональная ломаная через проходы: к отверстию подходим и отходим перпендикулярно стене,
 * чтобы кабель пересекал стену именно в нём.
 */
export function pathVia(from: Pt, via: Passage[], to: Pt): Pt[] {
  const pts: Pt[] = [from];
  let cur = from;
  let dir: Dir = null;
  for (const p of via) {
    const d: Dir = p.vertical ? 'h' : 'v';
    pts.push(...leg(cur, dir, p.pos, d));
    cur = p.pos;
    dir = d;
  }
  pts.push(...leg(cur, dir, to, null));
  return pts.filter((q, i) => i === 0 || q.x !== pts[i - 1].x || q.y !== pts[i - 1].y);
}

export const polyLen = (pts: Pt[]) => pts.reduce((s, q, i) => (i ? s + manhattan(pts[i - 1], q) : 0), 0);
