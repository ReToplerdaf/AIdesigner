import { parseSpecRows } from '../engine/classify';
import { rect } from '../engine/geometry';
import { autoPlace } from '../engine/placement';
import type { Project, Room, Settings } from '../engine/types';

export const DEFAULT_SETTINGS: Settings = {
  phases: 1,
  U: 230,
  pAllowedW: 11000,
  kc: 0.4,
  zExtOhm: 0.3,
  dUMaxPct: 3,
  lengthReserve: 0.1,
  ceilingH: 2700,
  dedicatedFromW: 1500,
  socketGroupMaxW: 3500,
  socketGroupMaxCount: 8,
  lightGroupMaxW: 1500,
};

/** Двухкомнатная квартира ~58 м² для демонстрации. */
export const DEMO_ROOMS: Room[] = [
  { id: 'r-kitchen', name: 'Кухня', type: 'kitchen', poly: rect(0, 0, 3500, 3500) },
  { id: 'r-living', name: 'Гостиная', type: 'living', poly: rect(3500, 0, 8000, 3500) },
  { id: 'r-bedroom', name: 'Спальня', type: 'bedroom', poly: rect(8000, 0, 11000, 3500) },
  { id: 'r-hall', name: 'Прихожая', type: 'hall', poly: rect(0, 3500, 8000, 5000) },
  { id: 'r-bath', name: 'Ванная', type: 'bath', poly: rect(8000, 3500, 10000, 5500) },
  { id: 'r-wc', name: 'Санузел', type: 'wc', poly: rect(10000, 3500, 11000, 5500) },
];

export const DEMO_SPEC_TEXT = [
  'Наименование\tКол-во\tМощность, кВт\tПомещение',
  'Розетка двойная с заземлением\t12\t\t',
  'Розетка над столешницей\t4\t\tКухня',
  'Светильник потолочный LED 40 Вт\t8\t\t',
  'Варочная панель индукционная\t1\t7,0\t',
  'Духовой шкаф\t1\t3,5\t',
  'Посудомоечная машина\t1\t2,0\t',
  'Холодильник\t1\t0,3\t',
  'Вытяжка\t1\t0,2\t',
  'Стиральная машина\t1\t2,2\t',
  'Водонагреватель накопительный\t1\t2,0\t',
  'Тёплый пол\t1\t0,8\tВанная',
  'Кондиционер\t2\t1,0\t',
].join('\n');

export function demoProject(): Project {
  const spec = parseSpecRows(DEMO_SPEC_TEXT.split('\n').map((l) => l.split('\t')));
  const panel = { x: 300, y: 4250 };
  return {
    version: 1,
    name: 'Демо: двухкомнатная квартира',
    rooms: DEMO_ROOMS,
    spec,
    devices: autoPlace(spec, DEMO_ROOMS, panel),
    panel,
    settings: { ...DEFAULT_SETTINGS },
    image: null,
  };
}
