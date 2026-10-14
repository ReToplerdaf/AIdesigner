// Распознавание позиций спецификации.
// В прототипе это правила по ключевым словам. В рабочей версии сюда подключается
// языковая модель с тем же интерфейсом: строка спецификации → тип, мощность, помещение.

import { DEVICE_TYPES } from './norms';
import type { DeviceTypeKey, RoomType, SpecItem } from './types';

const TYPE_RULES: { key: DeviceTypeKey; re: RegExp }[] = [
  { key: 'hob', re: /варочн|электроплит|плит[аы](?![а-яё])|индукц/i },
  { key: 'oven', re: /духов|жарочн/i },
  { key: 'dishwasher', re: /посудомо|(?<![а-яё])пмм(?![а-яё])/i },
  { key: 'washer', re: /стиральн|(?<![а-яё])сма?(?![а-яё])/i },
  { key: 'boiler', re: /водонагрев|бойлер|ewh/i },
  { key: 'ac', re: /кондиц|сплит/i },
  { key: 'floor_heating', re: /т[её]пл[а-яё]*\s+пол|нагревательн[а-яё]*\s+(мат|кабел)/i },
  { key: 'hood', re: /вытяж/i },
  { key: 'fridge', re: /холодил|морозил/i },
  { key: 'microwave', re: /свч|микроволн/i },
  { key: 'light', re: /светильн|люстр|спот|лампа|подсветк|(?<![а-яё])бра(?![а-яё])/i },
  { key: 'socket', re: /розетк/i },
];

export const ROOM_RULES: { type: RoomType; re: RegExp }[] = [
  { type: 'kitchen', re: /кухн|столов/i },
  { type: 'bath', re: /ванн|душев/i },
  { type: 'wc', re: /санузел|с\/у|туалет|уборн/i },
  { type: 'bedroom', re: /спальн|детск|кабинет/i },
  { type: 'living', re: /гостин|(?<![а-яё])зал(?![а-яё])|жил[а-яё]*\s+комн|комнат/i },
  { type: 'hall', re: /прихож|коридор|холл|тамбур/i },
  { type: 'balcony', re: /балкон|лоджи/i },
];

export function classifyName(name: string): { typeKey: DeviceTypeKey; confidence: number } {
  for (const r of TYPE_RULES) if (r.re.test(name)) return { typeKey: r.key, confidence: 1 };
  return { typeKey: 'other', confidence: 0 };
}

export function roomTypeFromText(text: string): RoomType | null {
  for (const r of ROOM_RULES) if (r.re.test(text)) return r.type;
  return null;
}

/** Мощность из текста: «7,0 кВт», «1500 Вт», «2kW». */
export function parsePowerW(text: string): number | null {
  const m = text.match(/(\d+(?:[.,]\d+)?)\s*(квт|kw|вт|w)(?![а-яёa-z])/i);
  if (!m) return null;
  const v = parseFloat(m[1].replace(',', '.'));
  const unit = m[2].toLowerCase();
  return unit === 'квт' || unit === 'kw' ? Math.round(v * 1000) : Math.round(v);
}

const HEADER_HINTS = {
  name: /наимен|назван|позиц|оборуд|потребит|name/i,
  qty: /кол|шт|qty|количество/i,
  power: /мощн|квт|вт|power|^p/i,
  room: /помещ|комнат|room|зона/i,
};

let seq = 0;
const nextId = () => `s${Date.now().toString(36)}${(seq++).toString(36)}`;

/**
 * Разбор таблицы спецификации (строки уже разбиты на ячейки).
 * Первая строка считается заголовком, если в ней есть «наименование» или «кол-во».
 */
export function parseSpecRows(rows: (string | number | null | undefined)[][]): SpecItem[] {
  const clean = rows
    .map((r) => r.map((c) => (c == null ? '' : String(c).trim())))
    .filter((r) => r.some((c) => c !== ''));
  if (clean.length === 0) return [];

  let col = { name: 0, qty: 1, power: 2, room: 3 };
  let start = 0;
  const head = clean[0];
  if (head.some((c) => HEADER_HINTS.name.test(c) || HEADER_HINTS.qty.test(c))) {
    const find = (re: RegExp, fallback: number) => {
      const i = head.findIndex((c) => re.test(c));
      return i >= 0 ? i : fallback;
    };
    col = {
      name: find(HEADER_HINTS.name, 0),
      qty: find(HEADER_HINTS.qty, -1),
      power: find(HEADER_HINTS.power, -1),
      room: find(HEADER_HINTS.room, -1),
    };
    start = 1;
  }

  const items: SpecItem[] = [];
  for (const r of clean.slice(start)) {
    const name = r[col.name] ?? '';
    if (!name) continue;
    const qtyRaw = col.qty >= 0 ? r[col.qty] : '';
    const qty = Math.max(1, Math.round(parseFloat(String(qtyRaw).replace(',', '.')) || 1));
    const { typeKey, confidence } = classifyName(name);
    const powerCell = col.power >= 0 ? r[col.power] : '';
    const powerW =
      parsePowerFromCell(powerCell) ?? parsePowerW(name) ?? DEVICE_TYPES[typeKey].defaultPowerW;
    const roomCell = col.room >= 0 ? r[col.room] : '';
    const roomHint = roomCell || (roomTypeFromText(name) ? name : '');
    items.push({ id: nextId(), name, qty, powerW, typeKey, roomHint, confidence });
  }
  return items;
}

/** Ячейка мощности: «7», «7,0», «7 кВт», «1500». Голое число < 100 считаем кВт. */
function parsePowerFromCell(cell: string | undefined): number | null {
  if (!cell) return null;
  const withUnit = parsePowerW(cell);
  if (withUnit != null) return withUnit;
  const v = parseFloat(cell.replace(',', '.'));
  if (!isFinite(v) || v <= 0) return null;
  return v < 100 ? Math.round(v * 1000) : Math.round(v);
}

/** Текст (вставка из Excel — табуляции, или CSV — ; или ,) → строки ячеек. */
export function splitText(text: string): string[][] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const sep = lines.some((l) => l.includes('\t')) ? '\t' : lines.some((l) => l.includes(';')) ? ';' : ',';
  return lines.map((l) => l.split(sep));
}
