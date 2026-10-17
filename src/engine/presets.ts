// Типовые наборы потребителей по типам помещений.
// Если спецификации нет, она составляется из этих наборов по помещениям на плане:
// каждое помещение получает набор своего типа, количество — числом или по площади/периметру.

import { area, perimeter } from './geometry';
import { DEVICE_TYPES } from './norms';
import type { DeviceTypeKey, Project, Room, RoomType, SpecItem } from './types';

/** Как считается количество: штук на помещение, 1 шт. на step м² площади или на step м периметра. */
export type QtyRule = 'fixed' | 'area' | 'perimeter';

export interface PresetItem {
  name: string;
  typeKey: DeviceTypeKey;
  /** Мощность одной единицы, Вт. */
  powerW: number;
  rule: QtyRule;
  /** Для 'fixed' — количество, для 'area' — м² на 1 шт., для 'perimeter' — м на 1 шт. */
  value: number;
  /** Не меньше стольких штук (для правил по площади и периметру). */
  min?: number;
  place?: 'corners';
}

export type PresetTable = Record<RoomType, PresetItem[]>;

const item = (
  name: string,
  typeKey: DeviceTypeKey,
  value = 1,
  extra: Partial<PresetItem> = {},
): PresetItem => ({ name, typeKey, powerW: DEVICE_TYPES[typeKey].defaultPowerW, rule: 'fixed', value, ...extra });

const LIGHT = 'Светильник потолочный LED';
const SOCKET = 'Розетка двойная с заземлением';
const SWITCH = 'Выключатель';

/** Стандартный объект: типовая квартира. Значения — практика, правятся под заказчика. */
export const STANDARD_PRESETS: PresetTable = {
  living: [
    item(LIGHT, 'light', 8, { rule: 'area', min: 2 }),
    item(SWITCH, 'switch'),
    item(SOCKET, 'socket', 4, { place: 'corners' }),
    item('Кондиционер', 'ac'),
  ],
  bedroom: [
    item(LIGHT, 'light', 8, { rule: 'area', min: 2 }),
    item(SWITCH, 'switch'),
    item(SOCKET, 'socket', 4, { place: 'corners' }),
    item('Кондиционер', 'ac'),
  ],
  kitchen: [
    item(LIGHT, 'light', 6, { rule: 'area', min: 2 }),
    item(SWITCH, 'switch'),
    item('Варочная панель индукционная', 'hob', 1, { powerW: 7000 }),
    item('Духовой шкаф', 'oven'),
    item('Вытяжка', 'hood'),
    item('Посудомоечная машина', 'dishwasher'),
    item('Холодильник', 'fridge'),
    item('Розетка над столешницей', 'socket', 4),
    item(SOCKET, 'socket', 2, { place: 'corners' }),
  ],
  bath: [
    item(LIGHT, 'light', 4, { rule: 'area', min: 1 }),
    item(SWITCH, 'switch'),
    item('Стиральная машина', 'washer'),
    item('Водонагреватель накопительный', 'boiler'),
    item('Розетка у зеркала', 'socket'),
    item('Тёплый пол', 'floor_heating'),
  ],
  wc: [item(LIGHT, 'light'), item(SWITCH, 'switch')],
  hall: [
    item(LIGHT, 'light', 4, { rule: 'area', min: 1 }),
    item(SWITCH, 'switch'),
    item(SOCKET, 'socket', 2),
  ],
  balcony: [item(LIGHT, 'light'), item(SWITCH, 'switch'), item(SOCKET, 'socket')],
  other: [item(LIGHT, 'light'), item(SWITCH, 'switch'), item(SOCKET, 'socket', 2)],
};

export function clonePresets(t: PresetTable): PresetTable {
  return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.map((i) => ({ ...i }))])) as PresetTable;
}

/** Сколько штук позиции набора нужно в этом помещении. */
export function presetQty(it: PresetItem, room: Room): number {
  if (it.rule === 'fixed') return Math.max(0, Math.round(it.value));
  const measure = it.rule === 'area' ? area(room.poly) / 1e6 : perimeter(room.poly) / 1000;
  const n = it.value > 0 ? Math.round(measure / it.value) : 0;
  return Math.max(n, it.min ?? 0);
}

let seq = 0;
const nextId = () => `g${Date.now().toString(36)}${(seq++).toString(36)}`;

/** Спецификация по помещениям: по строке на каждую позицию набора в каждом помещении. */
export function generateSpec(rooms: Room[], table: PresetTable): SpecItem[] {
  const spec: SpecItem[] = [];
  for (const room of rooms) {
    for (const it of table[room.type] ?? []) {
      const qty = presetQty(it, room);
      if (qty <= 0) continue;
      spec.push({
        id: nextId(),
        name: it.name,
        qty,
        powerW: it.powerW,
        typeKey: it.typeKey,
        roomHint: room.name,
        roomId: room.id,
        confidence: 1,
        ...(it.place ? { place: it.place } : {}),
      });
    }
  }
  return spec;
}

/**
 * Наборы из готового объекта: для каждого типа помещения, который в нём есть, берётся
 * среднее по помещениям этого типа число точек каждой позиции на плане. Типы, которых
 * в объекте нет, остаются из base.
 */
export function presetsFromProject(p: Pick<Project, 'rooms' | 'spec' | 'devices'>, base: PresetTable): PresetTable {
  const out = clonePresets(base);
  const byType = new Map<RoomType, Room[]>();
  p.rooms.forEach((r) => byType.set(r.type, [...(byType.get(r.type) ?? []), r]));

  for (const [type, rooms] of byType) {
    const ids = new Set(rooms.map((r) => r.id));
    const counts = new Map<string, { it: PresetItem; n: number }>();
    for (const d of p.devices) {
      if (!d.roomId || !ids.has(d.roomId) || d.typeKey === 'passage') continue;
      const s = p.spec.find((x) => x.id === d.specId);
      const name = s?.name ?? d.label;
      const key = `${d.typeKey}|${name}|${d.powerW}`;
      const c = counts.get(key) ?? {
        it: { name, typeKey: d.typeKey, powerW: d.powerW, rule: 'fixed', value: 0, ...(s?.place ? { place: s.place } : {}) },
        n: 0,
      };
      c.n++;
      counts.set(key, c);
    }
    const items = [...counts.values()]
      .map(({ it, n }) => ({ ...it, value: Math.max(1, Math.round(n / rooms.length)) }))
      .sort((a, b) => order(a.typeKey) - order(b.typeKey));
    if (items.length) out[type] = items;
  }
  return out;
}

const ORDER: DeviceTypeKey[] = ['light', 'switch'];
const order = (k: DeviceTypeKey) => {
  const i = ORDER.indexOf(k);
  return i < 0 ? ORDER.length : i;
};
