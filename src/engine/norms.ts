// Нормативные таблицы и справочные данные.
// Каждое значение помечено источником. Перед использованием в реальном проекте
// таблицы должен сверить проектировщик с действующими редакциями документов.

import type { DeviceTypeInfo, DeviceTypeKey, RoomType } from './types';

export const DEVICE_TYPES: Record<DeviceTypeKey, DeviceTypeInfo> = {
  socket: { key: 'socket', label: 'Розетка', kind: 'socket', defaultPowerW: 300, cosPhi: 0.95, mountH: 300, needsRcd: true, glyph: 'Р' },
  light: { key: 'light', label: 'Светильник', kind: 'light', defaultPowerW: 40, cosPhi: 0.95, mountH: 2700, needsRcd: false, glyph: 'С' },
  hob: { key: 'hob', label: 'Варочная панель', kind: 'dedicated', defaultPowerW: 7000, cosPhi: 0.98, mountH: 600, needsRcd: false, glyph: 'ВП' },
  oven: { key: 'oven', label: 'Духовой шкаф', kind: 'dedicated', defaultPowerW: 3500, cosPhi: 0.98, mountH: 600, needsRcd: false, glyph: 'ДШ' },
  dishwasher: { key: 'dishwasher', label: 'Посудомоечная машина', kind: 'dedicated', defaultPowerW: 2000, cosPhi: 0.9, mountH: 300, needsRcd: true, glyph: 'ПМ' },
  washer: { key: 'washer', label: 'Стиральная машина', kind: 'dedicated', defaultPowerW: 2200, cosPhi: 0.9, mountH: 1000, needsRcd: true, glyph: 'СМ' },
  boiler: { key: 'boiler', label: 'Водонагреватель', kind: 'dedicated', defaultPowerW: 2000, cosPhi: 1, mountH: 1800, needsRcd: true, glyph: 'ВН' },
  ac: { key: 'ac', label: 'Кондиционер', kind: 'dedicated', defaultPowerW: 1000, cosPhi: 0.85, mountH: 2400, needsRcd: false, glyph: 'К' },
  floor_heating: { key: 'floor_heating', label: 'Тёплый пол', kind: 'dedicated', defaultPowerW: 800, cosPhi: 1, mountH: 900, needsRcd: true, glyph: 'ТП' },
  hood: { key: 'hood', label: 'Вытяжка', kind: 'socket', defaultPowerW: 200, cosPhi: 0.9, mountH: 2000, needsRcd: true, glyph: 'В' },
  fridge: { key: 'fridge', label: 'Холодильник', kind: 'socket', defaultPowerW: 300, cosPhi: 0.85, mountH: 300, needsRcd: true, glyph: 'Х' },
  microwave: { key: 'microwave', label: 'СВЧ-печь', kind: 'socket', defaultPowerW: 1200, cosPhi: 0.9, mountH: 1100, needsRcd: true, glyph: 'М' },
  other: { key: 'other', label: 'Прочее', kind: 'socket', defaultPowerW: 500, cosPhi: 0.9, mountH: 300, needsRcd: true, glyph: '?' },
};

export const ROOM_TYPES: Record<RoomType, { label: string; wet: boolean }> = {
  kitchen: { label: 'Кухня', wet: false },
  living: { label: 'Гостиная', wet: false },
  bedroom: { label: 'Спальня', wet: false },
  bath: { label: 'Ванная', wet: true },
  wc: { label: 'Санузел', wet: true },
  hall: { label: 'Прихожая / коридор', wet: false },
  balcony: { label: 'Балкон / лоджия', wet: false },
  other: { label: 'Прочее', wet: false },
};

/** Стандартный ряд номинальных токов модульных автоматов, А. ГОСТ IEC 60898-1. */
export const BREAKER_SERIES = [6, 10, 13, 16, 20, 25, 32, 40, 50, 63, 80, 100];

/** Кратность тока мгновенного расцепления (верхняя граница зоны), ГОСТ IEC 60898-1: B — 5·In, C — 10·In. */
export const INSTANT_TRIP_MULT = { B: 5, C: 10 } as const;

export const CABLE_TABLE_SOURCE = 'ПУЭ 7, табл. 1.3.6 (медные жилы, трёхжильный кабель, прокладка в воздухе)';

/** Длительно допустимый ток для трёхжильного медного кабеля в воздухе, А. */
export const CABLE_TABLE: { s: number; iA: number }[] = [
  { s: 1.5, iA: 19 },
  { s: 2.5, iA: 25 },
  { s: 4, iA: 35 },
  { s: 6, iA: 42 },
  { s: 10, iA: 55 },
  { s: 16, iA: 75 },
];

/** Минимальные сечения, принятые в прототипе для квартир (практика проектирования; уточнить по заданию). */
export const MIN_SECTION = { light: 1.5, socket: 2.5, dedicated: 2.5 } as const;

/** Удельное сопротивление меди при рабочей температуре жилы, Ом·мм²/м (приближение). */
export const RHO_CU = 0.0225;

export const CABLE_BRAND = 'ВВГнг(А)-LS';

export const SOURCES = {
  rcdSockets: 'ГОСТ Р 50571.4.41, п. 411.3.3 — розеточные цепи до 20 А защищаются УЗО ≤ 30 мА',
  rcdBath: 'ГОСТ Р 50571.7.701, п. 701.411.3.3 — цепи ванных комнат защищаются УЗО ≤ 30 мА',
  breakerVsCable: 'ГОСТ Р 50571.4.43, п. 433.1 — Iр ≤ In ≤ Iдоп (ток линии ≤ номинал автомата ≤ допустимый ток кабеля)',
  loop: 'ГОСТ Р 50571.4.41, п. 411.4.4 — автоматическое отключение: Iкз ≥ кратность мгн. расцепления × In',
  dU: 'ГОСТ 32144 и практика проектирования: порог потери напряжения задаётся в настройках',
  kc: 'Коэффициент спроса задан в настройках. В рабочей версии — по табл. 7.1 СП 256.1325800',
};
