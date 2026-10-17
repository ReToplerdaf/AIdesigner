// Автораскладка: позиции спецификации → помещения → точки на плане.
// Правила простые и предсказуемые; инженер затем двигает точки вручную.

import { area, bbox, centroid, dist, perimeter, pointInPolygon, pointOnPerimeter } from './geometry';
import { roomTypeFromText } from './classify';
import { nearestWallPoint } from './wall';
import { findPassages } from './passages';
import { DEVICE_TYPES } from './norms';
import type { Device, DeviceTypeKey, Pt, Room, RoomType, SpecItem } from './types';

/** Куда ставить потребитель, если в спецификации не указано помещение (по приоритету). */
const DEFAULT_ROOMS: Partial<Record<DeviceTypeKey, RoomType[]>> = {
  hob: ['kitchen'],
  oven: ['kitchen'],
  dishwasher: ['kitchen'],
  hood: ['kitchen'],
  fridge: ['kitchen'],
  microwave: ['kitchen'],
  washer: ['bath', 'wc', 'kitchen'],
  boiler: ['bath', 'wc', 'kitchen'],
  floor_heating: ['bath', 'wc'],
  ac: ['living', 'bedroom'],
};

/** Вес помещения при распределении розеток (умножается на √площади). */
const SOCKET_WEIGHT: Record<RoomType, number> = {
  kitchen: 3,
  living: 2,
  bedroom: 1.6,
  hall: 0.7,
  bath: 0.5,
  wc: 0,
  balcony: 0.3,
  other: 1,
};

const WALL_INSET = 150;

let seq = 0;
const nextId = () => `d${Date.now().toString(36)}${(seq++).toString(36)}`;

/** Распределить n штук по весам методом наибольших остатков. */
export function distribute(n: number, weights: number[]): number[] {
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) return weights.map((_, i) => (i === 0 ? n : 0));
  const raw = weights.map((w) => (w / total) * n);
  const out = raw.map(Math.floor);
  let left = n - out.reduce((s, v) => s + v, 0);
  const order = raw.map((v, i) => ({ i, r: v - Math.floor(v) })).sort((a, b) => b.r - a.r);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) out[order[k].i]++;
  return out;
}

export function matchRooms(hint: string, rooms: Room[]): Room[] {
  if (!hint) return [];
  const h = hint.toLowerCase().trim();
  const byName = rooms.filter((r) => {
    const n = r.name.toLowerCase();
    return n === h || n.includes(h) || h.includes(n);
  });
  if (byName.length) return byName;
  const t = roomTypeFromText(hint);
  return t ? rooms.filter((r) => r.type === t) : [];
}

/** Помещения позиции спецификации: заданное явно или найденное по подсказке. */
export function specRooms(item: Pick<SpecItem, 'roomId' | 'roomHint'>, rooms: Room[]): Room[] {
  const own = item.roomId ? rooms.find((r) => r.id === item.roomId) : undefined;
  return own ? [own] : matchRooms(item.roomHint, rooms);
}

function roomsByType(rooms: Room[], types: RoomType[]): Room[] {
  for (const t of types) {
    const found = rooms.filter((r) => r.type === t);
    if (found.length) return found;
  }
  return [];
}

/** Сколько единиц позиции уходит в каждое помещение. */
function allocate(item: SpecItem, rooms: Room[]): Map<string, number> {
  const res = new Map<string, number>();
  if (rooms.length === 0) return res;
  const add = (r: Room, n: number) => n > 0 && res.set(r.id, (res.get(r.id) ?? 0) + n);

  const own = item.roomId ? rooms.find((r) => r.id === item.roomId) : undefined;
  if (own) {
    add(own, item.qty);
    return res;
  }

  const hinted = matchRooms(item.roomHint, rooms);
  if (hinted.length) {
    distribute(item.qty, hinted.map((r) => area(r.poly))).forEach((n, i) => add(hinted[i], n));
    return res;
  }

  if (item.typeKey === 'light' || item.typeKey === 'switch') {
    const areas = rooms.map((r) => area(r.poly));
    if (item.qty >= rooms.length) {
      rooms.forEach((r) => add(r, 1));
      distribute(item.qty - rooms.length, areas).forEach((n, i) => add(rooms[i], n));
    } else {
      distribute(item.qty, areas).forEach((n, i) => add(rooms[i], n));
    }
    return res;
  }

  if (item.typeKey === 'socket' || item.typeKey === 'other') {
    const w = rooms.map((r) => SOCKET_WEIGHT[r.type] * Math.sqrt(area(r.poly) / 1e6));
    distribute(item.qty, w).forEach((n, i) => add(rooms[i], n));
    return res;
  }

  const targets = roomsByType(rooms, DEFAULT_ROOMS[item.typeKey] ?? []);
  const list = targets.length ? targets : [rooms[0]];
  const sorted = [...list].sort((a, b) => area(b.poly) - area(a.poly));
  for (let k = 0; k < item.qty; k++) add(sorted[k % sorted.length], 1);
  return res;
}

function lightGrid(room: Room, n: number): Pt[] {
  const b = bbox(room.poly);
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  const cols = Math.max(1, Math.round(Math.sqrt((n * w) / Math.max(h, 1))));
  const rows = Math.ceil(n / cols);
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const inRow = r === rows - 1 ? n - cols * (rows - 1) : cols;
    const p = { x: b.minX + (w * (c + 0.5)) / inRow, y: b.minY + (h * (r + 0.5)) / rows };
    pts.push(pointInPolygon(p, room.poly) ? p : centroid(room.poly));
  }
  return pts;
}

/** Отступ точки «в углу» от угла вдоль стены, мм. */
const CORNER_OFFSET = 350;

/** Положения у выпуклых углов помещения: по одному на угол, отступ вдоль следующей стены. */
export function cornerSpots(poly: Pt[], inset = WALL_INSET): Pt[] {
  const total = perimeter(poly);
  const spots: Pt[] = [];
  let run = 0;
  for (let i = 0; i < poly.length; i++) {
    const v = poly[i];
    const prev = poly[(i - 1 + poly.length) % poly.length];
    const next = poly[(i + 1) % poly.length];
    const lp = dist(prev, v) || 1;
    const ln = dist(v, next) || 1;
    const probe = {
      x: v.x + ((prev.x - v.x) / lp + (next.x - v.x) / ln) * 50,
      y: v.y + ((prev.y - v.y) / lp + (next.y - v.y) / ln) * 50,
    };
    if (total > 0 && pointInPolygon(probe, poly)) {
      spots.push(pointOnPerimeter(poly, (run + Math.min(CORNER_OFFSET, ln / 3)) / total, inset));
    }
    run += ln;
  }
  return spots;
}

/** Сначала крупные приборы, потом бытовые розетки — так приборы встают в начало периметра. */
const WALL_ORDER: DeviceTypeKey[] = [
  'hob', 'hood', 'oven', 'dishwasher', 'washer', 'boiler', 'ac', 'floor_heating',
  'fridge', 'microwave', 'other', 'socket',
];

/** Выключатель, который добавляется автоматически в помещение со светильниками. */
export const AUTO_SWITCH: SpecItem = {
  id: 'auto-switch',
  name: 'Выключатель',
  qty: 1,
  powerW: 0,
  typeKey: 'switch',
  roomHint: '',
  confidence: 1,
};

/** Проходное отверстие, которое добавляется в спецификацию при раскладке, если его там нет. */
export const AUTO_PASSAGE: SpecItem = {
  id: 'auto-passage',
  name: 'Проходное отверстие в стене (гильза)',
  qty: 1,
  powerW: 0,
  typeKey: 'passage',
  roomHint: '',
  confidence: 1,
};

/**
 * Строка спецификации для проходных отверстий: количество — сколько отверстий стоит на плане.
 * Если строки нет, а отверстия есть, добавляется автоматическая.
 */
export function withPassageSpec(spec: SpecItem[], devices: Device[]): SpecItem[] {
  const item = spec.find((s) => s.typeKey === 'passage') ?? AUTO_PASSAGE;
  const n = devices.filter((d) => d.typeKey === 'passage').length;
  if (spec.includes(item)) return spec.map((s) => (s === item ? { ...s, qty: Math.max(n, 1) } : s));
  return n ? [...spec, { ...item, qty: n }] : spec;
}

export function autoPlace(
  spec: SpecItem[],
  rooms: Room[],
  panel: Pt,
  opts: { autoSwitches?: boolean; passages?: boolean } = {},
): Device[] {
  type Pending = { item: SpecItem; roomId: string | null };
  const perRoom = new Map<string | null, Pending[]>();
  for (const item of spec) {
    // Проходные отверстия ставятся по стенам ниже, а не по помещениям.
    if (item.typeKey === 'passage') continue;
    const alloc = allocate(item, rooms);
    if (alloc.size === 0) {
      const list = perRoom.get(null) ?? [];
      for (let k = 0; k < item.qty; k++) list.push({ item, roomId: null });
      perRoom.set(null, list);
      continue;
    }
    for (const [roomId, n] of alloc) {
      const list = perRoom.get(roomId) ?? [];
      for (let k = 0; k < n; k++) list.push({ item, roomId });
      perRoom.set(roomId, list);
    }
  }

  if (opts.autoSwitches ?? true) {
    for (const [roomId, list] of perRoom) {
      if (roomId == null) continue;
      const lit = list.some((p) => p.item.typeKey === 'light');
      const hasSwitch = list.some((p) => p.item.typeKey === 'switch');
      if (lit && !hasSwitch) list.push({ item: AUTO_SWITCH, roomId });
    }
  }

  const devices: Device[] = [];
  const make = (p: Pending, pos: Pt): Device => ({
    id: nextId(),
    specId: p.item.id,
    typeKey: p.item.typeKey,
    label: p.item.name,
    powerW: p.item.powerW,
    roomId: p.roomId,
    pos,
  });

  for (const [roomId, list] of perRoom) {
    const room = rooms.find((r) => r.id === roomId);
    if (!room) {
      list.forEach((p, i) => devices.push(make(p, { x: panel.x + 400 + i * 300, y: panel.y })));
      continue;
    }
    const lights = list.filter((p) => p.item.typeKey === 'light');
    lightGrid(room, lights.length).forEach((pos, i) => devices.push(make(lights[i], pos)));

    // Выключатели — у стены со стороны щита (там, откуда приходят в помещение), рядом друг с другом.
    const switches = list.filter((p) => p.item.typeKey === 'switch');
    const entry = nearestWallPoint(room.poly, panel, WALL_INSET);
    switches.forEach((p, i) => devices.push(make(p, { x: entry.x + i * 250, y: entry.y })));

    // Позиции «по углам»: по одной на угол, остальные идут вдоль стен вместе со всеми.
    const corners = cornerSpots(room.poly);
    const atCorners = list.filter((p) => p.item.place === 'corners' && DEVICE_TYPES[p.item.typeKey].kind !== 'light');
    const cornerSet = new Set(atCorners.slice(0, corners.length));
    const used = pickEven(corners.length, cornerSet.size);
    [...cornerSet].forEach((p, i) => devices.push(make(p, corners[used[i]])));

    const wall = list
      .filter((p) => DEVICE_TYPES[p.item.typeKey].kind !== 'light' && !cornerSet.has(p))
      .sort((a, b) => WALL_ORDER.indexOf(a.item.typeKey) - WALL_ORDER.indexOf(b.item.typeKey));
    const m = wall.length;
    // Небольшой сдвиг старта, чтобы точки не попадали в углы.
    const shift = 0.35 / Math.max(perimeter(room.poly) / 1000, 1) / 4;
    wall.forEach((p, k) => devices.push(make(p, pointOnPerimeter(room.poly, (k + 0.5) / m + shift, WALL_INSET))));
  }

  // По одному проходному отверстию посередине каждой общей стены между помещениями.
  if (opts.passages ?? true) {
    const item = spec.find((s) => s.typeKey === 'passage') ?? AUTO_PASSAGE;
    for (const w of findPassages(rooms)) devices.push(make({ item, roomId: null }, w.pos));
  }
  return devices;
}

/** m индексов из n, равномерно по кругу. */
function pickEven(n: number, m: number): number[] {
  return Array.from({ length: m }, (_, i) => Math.floor((i * n) / m));
}

/** Помещение, в котором оказалась точка после перетаскивания. */
export function roomAt(p: Pt, rooms: Room[]): string | null {
  return rooms.find((r) => pointInPolygon(p, r.poly))?.id ?? null;
}
