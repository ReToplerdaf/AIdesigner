// Разбор подписей помещений, прочитанных с плана распознаванием текста:
// «Гостиная 17,8 м²», «С/у 2,8», «Кух. 8,3 м?» → название, тип и площадь.
import { ROOM_RULES } from './classify';
import type { Box, RoomType } from './types';

export interface OcrWord {
  text: string;
  /** Уверенность распознавания, 0–100. */
  conf: number;
  box: Box;
  /** Номер строки: слова одной строки склеиваются в название («Жилая комната»). */
  line: number;
}

export interface RoomLabel {
  name?: { text: string; type: RoomType; box: Box };
  area?: { m2: number; box: Box };
}

/** Слова, которые встречаются в названиях помещений, в нормальном написании. */
const DICT = [
  'кухня', 'кухня-гостиная', 'столовая', 'гостиная', 'зал', 'спальня', 'детская', 'кабинет', 'комната', 'жилая',
  'прихожая', 'коридор', 'холл', 'тамбур', 'ванная', 'душевая', 'санузел', 'туалет', 'уборная', 'балкон',
  'лоджия', 'гардероб', 'гардеробная', 'кладовая', 'постирочная', 'котельная', 'терраса',
];
/** Сокращения с планов. */
const ABBR: Record<string, string> = {
  'с/у': 'С/у', 'су': 'С/у', 'с.у': 'С/у', 'кух': 'Кухня', 'гост': 'Гостиная', 'спал': 'Спальня', 'прих': 'Прихожая',
  'кор': 'Коридор', 'ван': 'Ванная', 'гард': 'Гардеробная', 'клад': 'Кладовая', 'лодж': 'Лоджия', 'балк': 'Балкон',
};

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^а-яa-z/.\-]/g, '').replace(/\.+$/, '');

function lev(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return d[b.length];
}

/** Слово из словаря, на которое похоже распознанное, с поправкой на ошибки распознавания. */
export function dictWord(raw: string): string | null {
  const w = norm(raw);
  if (w.length < 2) return null;
  if (ABBR[w]) return ABBR[w];
  let best: string | null = null;
  let bestD = Infinity;
  for (const d of DICT) {
    const dist = lev(w, d);
    if (dist < bestD) {
      bestD = dist;
      best = d;
    }
  }
  const allowed = w.length <= 4 ? 0 : w.length <= 7 ? 1 : 2;
  return best && bestD <= allowed ? best[0].toUpperCase() + best.slice(1) : null;
}

const typeOf = (name: string): RoomType => ROOM_RULES.find((r) => r.re.test(name))?.type ?? 'other';

export const unionBox = (boxes: Box[]): Box => {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
};

/** Площадь из текста: «17,8», «17.8 м²», «12 м2». Целое без «м» не берём — это скорее номер помещения. */
export function areaOf(text: string, next = ''): number | null {
  const t = text.replace(/[oо]/gi, '0').replace(/\s/g, '');
  // Дробное число ищем внутри слова: к нему часто прилипают обрывки соседних букв («са17,8»).
  const m = t.match(/(\d{1,3})[.,](\d{1,2})(?!\d)/) ?? (/^м/i.test(next) || /м/i.test(t) ? t.match(/^(\d{1,3})(?:м.?)?$/i) : null);
  if (!m) return null;
  const v = parseFloat(`${m[1]}.${m[2] ?? '0'}`.replace(/\.$/, ''));
  return v >= 0.5 && v <= 300 ? v : null;
}

/** Название и площадь помещения из распознанных слов. */
export function readLabel(words: OcrWord[], minConf = 45): RoomLabel {
  const ok = words.filter((w) => w.conf >= minConf && w.text.trim());
  const out: RoomLabel = {};

  // Название: строка, в которой есть слова из словаря; если таких нет — самое длинное уверенное слово из букв.
  const lines = new Map<number, OcrWord[]>();
  for (const w of ok) lines.set(w.line, [...(lines.get(w.line) ?? []), w]);
  let best: { text: string; box: Box; score: number } | null = null;
  for (const ws of lines.values()) {
    const hits = ws.map((w) => ({ w, d: dictWord(w.text) })).filter((h) => h.d);
    if (!hits.length) continue;
    const text = hits.map((h) => h.d!).join(' ').replace(/ (\S)/g, (_, c: string) => ` ${c.toLowerCase()}`);
    const score = hits.reduce((s, h) => s + h.w.conf, 0);
    if (!best || score > best.score) best = { text, box: unionBox(hits.map((h) => h.w.box)), score };
  }
  if (!best) {
    const letters = ok.filter((w) => /^[а-яё][а-яё\-/.]{2,}$/i.test(w.text.trim()) && w.conf >= 70);
    letters.sort((a, b) => b.text.length - a.text.length);
    if (letters[0]) {
      const t = letters[0].text.trim().replace(/\.$/, '');
      best = { text: t[0].toUpperCase() + t.slice(1).toLowerCase(), box: letters[0].box, score: 0 };
    }
  }
  if (best) out.name = { text: best.text, type: typeOf(best.text), box: best.box };

  // Площадь: число вида 17,8; рядом может стоять «м²».
  for (let i = 0; i < ok.length && !out.area; i++) {
    const next = ok[i + 1]?.line === ok[i].line ? ok[i + 1].text : '';
    const m2 = areaOf(ok[i].text, next);
    if (m2 == null) continue;
    const unit = /^м/i.test(next.trim()) ? [ok[i + 1].box] : [];
    out.area = { m2, box: unionBox([ok[i].box, ...unit]) };
  }
  return out;
}

/** Все подписи площади в распознанных словах: в слитом контуре смежных помещений их несколько. */
export function readAreas(words: OcrWord[], minConf = 45): { m2: number; box: Box }[] {
  const ok = words.filter((w) => w.conf >= minConf && w.text.trim());
  const out: { m2: number; box: Box }[] = [];
  for (let i = 0; i < ok.length; i++) {
    const next = ok[i + 1]?.line === ok[i].line ? ok[i + 1].text : '';
    const m2 = areaOf(ok[i].text, next);
    if (m2 == null) continue;
    const unit = /^м/i.test(next.trim()) ? [ok[i + 1].box] : [];
    out.push({ m2, box: unionBox([ok[i].box, ...unit]) });
  }
  return out;
}
