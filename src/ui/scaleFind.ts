// Поиск масштаба по подложке: читает все числа на плане, ищет под размерами линии, от подписей площади заливает комнаты.
// Возвращает варианты масштаба по убыванию доверия; какой верный, подтверждает пользователь.
import { agree, dimensionOf, inkOf, roomFills, scaleFromAreas, traceDimLine, withSupport, type DimLine } from '../engine/dimDetect';
import { areaOf, unionBox, type OcrWord } from '../engine/roomLabels';
import type { Box, PlanImage, Pt } from '../engine/types';
import { loadOcr, ocrBox } from './ocr';
import { rasterOf } from './opencv';

export interface ScaleCandidate {
  kind: 'dim' | 'area';
  /** Что прочитано: «10000 мм», «17,8 м²». */
  text: string;
  /** Масштаб подложки, мм на пиксель картинки. */
  mmPerPx: number;
  /** Прочитанное число: мм для размера, м² для площади. */
  value: number;
  /** Что подсветить на плане, пиксели картинки: число с линией или комната. */
  mark: Box;
  /** Отрезок, длина которого показывается пользователю, пиксели картинки: размерная линия или от стены до стены. */
  seg: { a: Pt; b: Pt };
  /** Для комнаты: насколько она прямоугольная (1 — ровный прямоугольник). */
  rect?: number;
  /** Сколько других находок согласны с этой. */
  support: number;
}

/** Числа, разорванные распознаванием на части («10 000»), склеиваются. */
function joinNumbers(words: OcrWord[]): OcrWord[] {
  const out: OcrWord[] = [];
  for (const w of words) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.line === w.line &&
      /^\d{1,3}$/.test(prev.text.trim()) &&
      /^\d{3}$/.test(w.text.trim()) &&
      w.box.x - (prev.box.x + prev.box.w) < prev.box.h
    ) {
      out[out.length - 1] = { ...prev, text: prev.text.trim() + w.text.trim(), box: unionBox([prev.box, w.box]), conf: Math.min(prev.conf, w.conf) };
    } else out.push(w);
  }
  return out;
}

export async function findScale(image: PlanImage, step: (pct: number, text: string) => void): Promise<ScaleCandidate[]> {
  const worker = await loadOcr((f) => step(5 + f * 50, `Загружаю распознавание текста… ${Math.round(f * 100)}%`));
  step(60, 'Читаю числа на плане…');
  const k = image.mmPerPx;
  const words = joinNumbers(
    (await ocrBox(worker, image, { x: 0, y: 0, w: image.widthPx * k, h: image.heightPx * k }, 11)).filter((w) => w.conf >= 50 && w.text.trim()),
  );

  step(80, 'Ищу размерные линии…');
  const raster = await rasterOf(image);
  const ink = inkOf(raster.rgba, raster.width, raster.height);
  const rk = raster.width / image.widthPx; // пикселей растра на пиксель картинки
  const toRaster = (b: Box): Box => ({ x: (b.x / k) * rk, y: (b.y / k) * rk, w: (b.w / k) * rk, h: (b.h / k) * rk });
  const toImage = (b: Box): Box => ({ x: b.x / rk, y: b.y / rk, w: b.w / rk, h: b.h / rk });

  const dims: { mm: number; line: DimLine; num: Box }[] = [];
  for (const w of words) {
    const mm = dimensionOf(w.text);
    if (mm == null) continue;
    const num = toRaster(w.box);
    const line = traceDimLine(ink, num);
    if (line) dims.push({ mm, line, num });
  }

  step(90, 'Сверяю с площадями комнат…');
  const areas = words.flatMap((w, i) => {
    const next = words[i + 1]?.line === w.line ? words[i + 1].text : '';
    const m2 = areaOf(w.text, next);
    return m2 == null ? [] : [{ m2, num: toRaster(w.box) }];
  });
  const fills = roomFills(
    ink,
    areas.map((a) => ({ at: { x: a.num.x + a.num.w / 2, y: a.num.y + a.num.h / 2 }, m2: a.m2 })),
  );
  const fromAreas = scaleFromAreas(fills, dims.map((d) => d.mm / d.line.lenPx));

  type Source = Omit<ScaleCandidate, 'mmPerPx' | 'support'>;
  const guesses: { mmPerPx: number; source: Source }[] = [
    ...dims.map((d) => ({
      mmPerPx: (d.mm / d.line.lenPx) * rk,
      source: {
        kind: 'dim' as const,
        text: `${d.mm.toLocaleString('ru-RU')} мм`,
        value: d.mm,
        mark: toImage(unionBox([d.num, { x: d.line.a.x, y: d.line.a.y - 1, w: d.line.lenPx, h: 2 }])),
        seg: { a: { x: d.line.a.x / rk, y: d.line.a.y / rk }, b: { x: d.line.b.x / rk, y: d.line.b.y / rk } },
      },
    })),
    ...(fromAreas?.picks ?? []).flatMap((p, i) => {
      if (!p) return [];
      // Отрезок от стены до стены — вдоль длинной стороны комнаты, через её середину.
      const b = toImage(p.box);
      const seg =
        b.w >= b.h
          ? { a: { x: b.x, y: b.y + b.h / 2 }, b: { x: b.x + b.w, y: b.y + b.h / 2 } }
          : { a: { x: b.x + b.w / 2, y: b.y }, b: { x: b.x + b.w / 2, y: b.y + b.h } };
      return [{ mmPerPx: p.mmPerPx * rk, source: { kind: 'area' as const, text: `${areas[i].m2.toLocaleString('ru-RU')} м²`, value: areas[i].m2, mark: b, seg, rect: p.rect } }];
    }),
  ];
  // Сначала то, с чем согласно больше всего других находок; при равенстве — размер (чем больше, тем точнее),
  // затем комната (чем ровнее прямоугольник, тем надёжнее её площадь).
  const rank = (g: { source: Source }) => (g.source.kind === 'dim' ? 1e9 + g.source.value : g.source.rect ?? 0);
  return withSupport(guesses)
    .sort((a, b) => b.support - a.support || rank(b) - rank(a))
    .map((g) => ({ ...g.source, mmPerPx: g.mmPerPx, support: g.support }));
}

/** Длина отрезка кандидата в мм при масштабе mmPerPx. */
export const segMm = (c: ScaleCandidate, mmPerPx: number) => Math.hypot(c.seg.b.x - c.seg.a.x, c.seg.b.y - c.seg.a.y) * mmPerPx;

/**
 * Сверка выбранного масштаба (подтверждённого или заданного вручную): до трёх других находок (сначала самые ровные комнаты), для каждой —
 * что подписано на плане и что получается при этом масштабе.
 */
export function crossCheck(mmPerPx: number, others: ScaleCandidate[]): { text: string; ok: boolean }[] {
  others = [...others].sort((a, b) => (b.kind === 'area' ? 1 : 0) - (a.kind === 'area' ? 1 : 0) || (b.rect ?? 0) - (a.rect ?? 0));
  return others.slice(0, 3).map((c) => {
    const ratio = mmPerPx / c.mmPerPx; // во сколько раз длины при выбранном масштабе больше, чем по этой находке
    const got = c.kind === 'area' ? c.value * ratio * ratio : c.value * ratio;
    const fmt = (v: number) => v.toLocaleString('ru-RU', { maximumFractionDigits: c.kind === 'area' ? 1 : 0 });
    return { text: `${c.text} на плане, по масштабу ${fmt(got)} ${c.kind === 'area' ? 'м²' : 'мм'}`, ok: agree(c.mmPerPx, mmPerPx) };
  });
}
