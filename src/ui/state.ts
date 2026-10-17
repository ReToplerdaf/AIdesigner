import type { Project } from '../engine/types';
import { clonePresets, STANDARD_PRESETS, type PresetTable } from '../engine/presets';

export type Selection =
  | { kind: 'device'; id: string }
  | { kind: 'group'; key: string }
  | { kind: 'room'; id: string }
  | { kind: 'panel' }
  | null;

/** room — прямоугольник, poly — многоугольник по углам, stretch — правка контура за углы и стены. */
export type Tool = 'select' | 'calibrate' | 'room' | 'poly' | 'stretch';

export type Update = (fn: (p: Project) => Project) => void;

const PALETTE = [
  '#d9480f', '#1971c2', '#2b8a3e', '#9c36b5', '#e67700', '#0c8599',
  '#c2255c', '#5c940d', '#3b5bdb', '#a61e4d', '#087f5b', '#862e9c',
];

export function groupColor(no: number): string {
  return PALETTE[(no - 1) % PALETTE.length];
}

const STORAGE_KEY = 'aidesigner.project.v1';

export function loadSaved(): Project | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Project;
    return p.version === 1 ? p : null;
  } catch {
    return null;
  }
}

export function save(p: Project) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    // подложка может не влезть в localStorage — проект всё равно можно сохранить файлом
  }
}

export function download(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const fmt = (v: number, d = 1) =>
  v.toLocaleString('ru-RU', { maximumFractionDigits: d, minimumFractionDigits: d });

/** Перетаскивание из списка на план: позиция спецификации или тип прибора без спецификации. */
export const DRAG_MIME = 'application/x-aid-device';
export type DragPayload = { specId: string } | { typeKey: string };

const PRESETS_KEY = 'aidesigner.presets.v1';

/** Свой стандарт типовых наборов хранится в браузере; без него — стандартный объект. */
export function loadPresets(): PresetTable {
  try {
    const raw = localStorage.getItem(PRESETS_KEY);
    if (raw) return { ...clonePresets(STANDARD_PRESETS), ...(JSON.parse(raw) as PresetTable) };
  } catch {
    // нет доступа к localStorage — работаем со стандартными наборами
  }
  return clonePresets(STANDARD_PRESETS);
}

export function savePresets(t: PresetTable) {
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(t));
  } catch {
    // не сохранилось — наборы останутся до перезагрузки страницы
  }
}
