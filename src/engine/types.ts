// Модель проекта. Все координаты в миллиметрах, мощности в ваттах.

export interface Pt {
  x: number;
  y: number;
}

export type RoomType =
  | 'kitchen'
  | 'living'
  | 'bedroom'
  | 'bath'
  | 'wc'
  | 'hall'
  | 'balcony'
  | 'other';

/** Прямоугольник на плане, мм. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Room {
  id: string;
  name: string;
  type: RoomType;
  poly: Pt[];
  /** Площадь, подписанная на плане, м²: распознана с подложки или введена вручную. */
  planAreaM2?: number;
  /** Где на подложке прочитано название. */
  nameSrc?: Box;
  /** Где на подложке прочитана площадь. */
  areaSrc?: Box;
}

/**
 * Как потребитель подключается: в общую розеточную группу, в группу освещения или отдельной линией.
 * 'none' — не электрический объект (проходное отверстие): есть в спецификации и на плане, но не в расчёте.
 */
export type DeviceKind = 'socket' | 'light' | 'dedicated' | 'none';

export type DeviceTypeKey =
  | 'socket'
  | 'light'
  | 'hob'
  | 'oven'
  | 'dishwasher'
  | 'washer'
  | 'boiler'
  | 'ac'
  | 'floor_heating'
  | 'hood'
  | 'fridge'
  | 'microwave'
  | 'switch'
  | 'passage'
  | 'other';

export interface DeviceTypeInfo {
  key: DeviceTypeKey;
  label: string;
  kind: DeviceKind;
  defaultPowerW: number;
  cosPhi: number;
  /** Высота установки от пола, мм. */
  mountH: number;
  /** Требует УЗО 30 мА (мокрая зона или розеточная цепь). */
  needsRcd: boolean;
  /** Условное обозначение на плане (1–2 символа). */
  glyph: string;
}

export interface SpecItem {
  id: string;
  /** Наименование как в спецификации. */
  name: string;
  qty: number;
  powerW: number;
  typeKey: DeviceTypeKey;
  /** Помещение из спецификации (как написано), если указано. */
  roomHint: string;
  /** Насколько уверенно распознан тип: 1 — по ключевому слову, 0 — не распознан. */
  confidence: number;
}

export interface Device {
  id: string;
  specId: string;
  typeKey: DeviceTypeKey;
  label: string;
  powerW: number;
  roomId: string | null;
  pos: Pt;
  /** Ручное назначение в группу (ключ группы). Пусто — группа подбирается автоматически. */
  groupKey?: string;
}

export interface Settings {
  phases: 1 | 3;
  /** Фазное напряжение, В. */
  U: number;
  /** Разрешённая мощность по ТУ, Вт. */
  pAllowedW: number;
  /** Коэффициент спроса для расчётной мощности на вводе. */
  kc: number;
  /** Сопротивление петли «фаза–нуль» до щита квартиры, Ом. */
  zExtOhm: number;
  /** Допустимая потеря напряжения в групповой линии, %. */
  dUMaxPct: number;
  /** Запас длины кабеля, доля (0.1 = +10 %). */
  lengthReserve: number;
  /** Высота потолка, мм (трассы по потолку). */
  ceilingH: number;
  /** Мощность, начиная с которой потребитель идёт отдельной линией, Вт. */
  dedicatedFromW: number;
  /** Предел мощности розеточной группы, Вт. */
  socketGroupMaxW: number;
  /** Предел числа розеток в группе. */
  socketGroupMaxCount: number;
  /** Предел мощности группы освещения, Вт. */
  lightGroupMaxW: number;
  /** Ставить выключатель в каждое помещение со светильниками, если в спецификации их не хватает. */
  autoSwitches?: boolean;
}

export interface PlanImage {
  dataUrl: string;
  widthPx: number;
  heightPx: number;
  /** Масштаб подложки: миллиметров на пиксель. */
  mmPerPx: number;
}

export interface Project {
  version: 1;
  name: string;
  rooms: Room[];
  spec: SpecItem[];
  devices: Device[];
  panel: Pt;
  settings: Settings;
  image: PlanImage | null;
  /** Ручные положения распределительных коробок: ключ «группа@помещение» → точка. */
  boxPos?: Record<string, Pt>;
}

/** Строка обоснования: что посчитано, по какой формуле, откуда норма. */
export interface Trace {
  what: string;
  value: string;
  how: string;
  source?: string;
}

export type BreakerCurve = 'B' | 'C';

export interface GroupCalc {
  key: string;
  /** Номер группы в щите: 1, 2, … */
  no: number;
  title: string;
  kind: DeviceKind;
  deviceIds: string[];
  roomNames: string[];
  powerW: number;
  cosPhi: number;
  currentA: number;
  phase: 1 | 2 | 3;
  breakerA: number;
  curve: BreakerCurve;
  rcd: boolean;
  sectionMm2: number;
  cableMark: string;
  iAllowedA: number;
  lengthM: number;
  /** Трассы для отрисовки: щит → коробки (магистраль) и коробка → точка (ответвления). */
  paths: Pt[][];
  /** Распределительные коробки группы: по одной на каждое помещение. */
  boxes: JunctionBox[];
  /** Через какие проходы в стенах идут кабели группы (ключ прохода на каждый кабель). */
  passages: string[];
  dUPct: number;
  loopOhm: number;
  ikA: number;
  ikRequiredA: number;
  checks: { ok: boolean; text: string }[];
  trace: Trace[];
}

export interface JunctionBox {
  /** «ключ группы@id помещения» — по нему хранится ручное положение. */
  key: string;
  groupKey: string;
  roomId: string;
  pos: Pt;
  /** Сколько точек подключено к коробке. */
  outlets: number;
}

export interface PanelCalc {
  installedW: number;
  designW: number;
  currentA: number;
  inputBreakerA: number;
  phaseLoadsW: [number, number, number];
  checks: { ok: boolean; text: string }[];
  trace: Trace[];
}

export interface ProjectCalc {
  groups: GroupCalc[];
  panel: PanelCalc;
  /** Используемые проходы в стенах. */
  passages: PassageCalc[];
}

/** Проходное отверстие в стене (точка на плане с типом «проход»). */
export interface PassageCalc {
  /** id точки отверстия. */
  key: string;
  /** Помещения по обе стороны стены; null — отверстие не у стены между помещениями. */
  rooms: [string, string] | null;
  pos: Pt;
  /** Участок стены, вдоль которого отверстие можно двигать. */
  a: Pt;
  b: Pt;
  vertical: boolean;
  /** Сколько кабелей проходит через отверстие. */
  cables: number;
  groupNos: number[];
  /** Ориентировочный диаметр гильзы, мм. */
  sleeveMm: number;
}
