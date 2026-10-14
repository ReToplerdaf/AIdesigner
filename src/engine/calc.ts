// Расчётный движок: группы, токи, автоматы, сечения, потери напряжения, петля «фаза–нуль».
// Чистые функции без побочных эффектов: на вход проект, на выход полный расчёт с обоснованиями.

import { centroid, manhattan } from './geometry';
import {
  BREAKER_SERIES,
  CABLE_BRAND,
  CABLE_TABLE,
  CABLE_TABLE_SOURCE,
  DEVICE_TYPES,
  INSTANT_TRIP_MULT,
  MIN_SECTION,
  RHO_CU,
  ROOM_TYPES,
  SOURCES,
} from './norms';
import type {
  BreakerCurve,
  Device,
  DeviceKind,
  GroupCalc,
  PanelCalc,
  Project,
  ProjectCalc,
  Pt,
  Room,
  Settings,
  Trace,
} from './types';

/** Высота установки щита, мм. */
const PANEL_H = 1600;

const KIND_ORDER: Record<DeviceKind, number> = { light: 0, socket: 1, dedicated: 2 };
const KIND_TITLE: Record<DeviceKind, string> = { light: 'Освещение', socket: 'Розетки', dedicated: '' };

const fmt = (v: number, d = 1) => v.toLocaleString('ru-RU', { maximumFractionDigits: d, minimumFractionDigits: d });

export function pickBreaker(currentA: number, minA = 6): number {
  return BREAKER_SERIES.find((b) => b >= currentA && b >= minA) ?? BREAKER_SERIES[BREAKER_SERIES.length - 1];
}

/** Минимальное сечение из таблицы, у которого допустимый ток не меньше номинала автомата. */
export function pickSection(breakerA: number, minS: number): { s: number; iA: number } {
  return CABLE_TABLE.find((c) => c.s >= minS && c.iA >= breakerA) ?? CABLE_TABLE[CABLE_TABLE.length - 1];
}

export function nextSection(s: number): { s: number; iA: number } | null {
  return CABLE_TABLE.find((c) => c.s > s) ?? null;
}

/** Потеря напряжения в однофазной линии, %: ΔU = 2·L·I·cosφ·ρ/S. Реактивным сопротивлением пренебрегаем. */
export function voltageDropPct(lengthM: number, currentA: number, cosPhi: number, sMm2: number, U: number): number {
  return ((2 * lengthM * currentA * cosPhi * RHO_CU) / sMm2 / U) * 100;
}

export function loopImpedance(zExt: number, lengthM: number, sMm2: number): number {
  return zExt + (2 * RHO_CU * lengthM) / sMm2;
}

/** Порядок обхода точек группы: от щита к ближайшей, дальше к ближайшей непосещённой. */
export function routeOrder(panel: Pt, pts: { id: string; pos: Pt }[]): string[] {
  const left = [...pts];
  const order: string[] = [];
  let cur = panel;
  while (left.length) {
    let bi = 0;
    for (let i = 1; i < left.length; i++) if (manhattan(cur, left[i].pos) < manhattan(cur, left[bi].pos)) bi = i;
    const [next] = left.splice(bi, 1);
    order.push(next.id);
    cur = next.pos;
  }
  return order;
}

/** Ортогональная трасса: из точки в точку сначала по X, потом по Y. */
export function orthoPath(points: Pt[]): Pt[] {
  const out: Pt[] = [];
  points.forEach((p, i) => {
    if (i > 0) out.push({ x: p.x, y: points[i - 1].y });
    out.push(p);
  });
  return out;
}

interface DraftGroup {
  key: string;
  kind: DeviceKind;
  devices: Device[];
}

function roomOf(d: Device, rooms: Room[]): Room | undefined {
  return rooms.find((r) => r.id === d.roomId);
}

/** Автоматическое формирование групп. Устройства с ручным groupKey присоединяются после. */
export function buildGroups(project: Project): DraftGroup[] {
  const { devices, rooms, panel, settings } = project;
  const groups: DraftGroup[] = [];
  const auto = devices.filter((d) => !d.groupKey);

  const roomDist = (d: Device) => {
    const r = roomOf(d, rooms);
    return r ? manhattan(panel, centroid(r.poly)) : manhattan(panel, d.pos);
  };
  const byRoomThenPos = (a: Device, b: Device) =>
    roomDist(a) - roomDist(b) || (a.roomId ?? '').localeCompare(b.roomId ?? '') || manhattan(panel, a.pos) - manhattan(panel, b.pos);

  const isDedicated = (d: Device) =>
    DEVICE_TYPES[d.typeKey].kind === 'dedicated' || d.powerW >= settings.dedicatedFromW;

  // Отдельные линии
  // Порядок отдельных линий — как в спецификации, чтобы номера групп не прыгали при перетаскивании.
  for (const d of auto.filter(isDedicated)) {
    groups.push({ key: `ded:${d.id}`, kind: 'dedicated', devices: [d] });
  }

  const pack = (list: Device[], prefix: string, kind: DeviceKind, maxW: number, maxCount: number) => {
    let cur: Device[] = [];
    let w = 0;
    let n = 1;
    const flush = () => {
      if (cur.length) groups.push({ key: `${prefix}:${n++}`, kind, devices: cur });
      cur = [];
      w = 0;
    };
    for (const d of [...list].sort(byRoomThenPos)) {
      if (cur.length && (w + d.powerW > maxW || cur.length >= maxCount)) flush();
      cur.push(d);
      w += d.powerW;
    }
    flush();
  };

  const rest = auto.filter((d) => !isDedicated(d));
  const lights = rest.filter((d) => DEVICE_TYPES[d.typeKey].kind === 'light');
  pack(lights, 'light', 'light', settings.lightGroupMaxW, 40);

  const sockets = rest.filter((d) => DEVICE_TYPES[d.typeKey].kind === 'socket');
  const rtype = (d: Device) => roomOf(d, rooms)?.type;
  const kitchen = sockets.filter((d) => rtype(d) === 'kitchen');
  const wet = sockets.filter((d) => {
    const t = rtype(d);
    return t != null && ROOM_TYPES[t].wet;
  });
  const general = sockets.filter((d) => !kitchen.includes(d) && !wet.includes(d));
  pack(kitchen, 'sock-kitchen', 'socket', settings.socketGroupMaxW, settings.socketGroupMaxCount);
  pack(wet, 'sock-wet', 'socket', settings.socketGroupMaxW, settings.socketGroupMaxCount);
  pack(general, 'sock', 'socket', settings.socketGroupMaxW, settings.socketGroupMaxCount);

  // Ручные назначения
  for (const d of devices.filter((x) => x.groupKey)) {
    const g = groups.find((x) => x.key === d.groupKey);
    if (g) g.devices.push(d);
    else groups.push({ key: d.groupKey!, kind: DEVICE_TYPES[d.typeKey].kind, devices: [d] });
  }

  return groups
    .filter((g) => g.devices.length)
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
}

function groupTitle(g: DraftGroup, rooms: Room[]): { title: string; roomNames: string[] } {
  const names = [...new Set(g.devices.map((d) => roomOf(d, rooms)?.name ?? 'вне помещений'))];
  if (g.kind === 'dedicated' && g.devices.length === 1) {
    return { title: DEVICE_TYPES[g.devices[0].typeKey].label, roomNames: names };
  }
  return { title: `${KIND_TITLE[g.kind] || 'Группа'}: ${names.join(', ')}`, roomNames: names };
}

function calcGroup(g: DraftGroup, no: number, project: Project): GroupCalc {
  const { settings, panel, rooms } = project;
  const U = settings.U;
  const trace: Trace[] = [];
  const checks: GroupCalc['checks'] = [];

  const P = g.devices.reduce((s, d) => s + d.powerW, 0);
  const S = g.devices.reduce((s, d) => s + d.powerW / DEVICE_TYPES[d.typeKey].cosPhi, 0);
  const cosPhi = S > 0 ? P / S : 1;
  const I = P / (U * cosPhi);
  trace.push({ what: 'Мощность группы', value: `${fmt(P / 1000, 2)} кВт`, how: `Сумма мощностей ${g.devices.length} потребителей` });
  trace.push({ what: 'Расчётный ток', value: `${fmt(I)} А`, how: `I = P / (U·cosφ) = ${fmt(P, 0)} / (${U}·${fmt(cosPhi, 2)})` });

  const curve: BreakerCurve = g.kind === 'light' ? 'B' : 'C';
  const minBreaker = g.kind === 'light' ? 10 : 16;
  const breakerA = pickBreaker(I, minBreaker);
  trace.push({
    what: 'Автомат',
    value: `${curve}${breakerA}`,
    how: `Ближайший номинал ≥ ${fmt(I)} А из стандартного ряда (не менее ${minBreaker} А для ${g.kind === 'light' ? 'освещения' : 'силовых линий'}); характеристика ${curve}`,
    source: 'ГОСТ IEC 60898-1',
  });

  const rcd = g.devices.some((d) => {
    const r = roomOf(d, rooms);
    return DEVICE_TYPES[d.typeKey].needsRcd || (r != null && ROOM_TYPES[r.type].wet);
  });
  if (rcd) {
    const wet = g.devices.some((d) => {
      const r = roomOf(d, rooms);
      return r != null && ROOM_TYPES[r.type].wet;
    });
    trace.push({ what: 'УЗО', value: '30 мА', how: 'Дифавтомат вместо автомата', source: wet ? SOURCES.rcdBath : SOURCES.rcdSockets });
  }

  // Трасса и длина
  const ids = routeOrder(panel, g.devices.map((d) => ({ id: d.id, pos: d.pos })));
  const ordered = ids.map((id) => g.devices.find((d) => d.id === id)!);
  const route = orthoPath([panel, ...ordered.map((d) => d.pos)]);
  // Участки трассы: до каждой точки (подъём из предыдущей точки, путь по потолку, спуск к точке)
  const k = 1 + settings.lengthReserve;
  const drops = ordered.map((d) => Math.max(settings.ceilingH - DEVICE_TYPES[d.typeKey].mountH, 0));
  let horiz = 0;
  let vert = 0;
  const segM: number[] = ordered.map((d, i) => {
    const prev = i === 0 ? panel : ordered[i - 1].pos;
    const h = manhattan(prev, d.pos);
    const v = (i === 0 ? settings.ceilingH - PANEL_H : drops[i - 1]) + drops[i];
    horiz += h;
    vert += v;
    return ((h + v) / 1000) * k;
  });
  const lengthM = Math.ceil(segM.reduce((s, v) => s + v, 0));
  trace.push({
    what: 'Длина кабеля',
    value: `${lengthM} м`,
    how: `По потолку ортогонально: ${fmt(horiz / 1000)} м по плану + ${fmt(vert / 1000)} м спусков, запас ${Math.round(settings.lengthReserve * 100)} %`,
  });

  // Сечение: по допустимому току, затем при необходимости увеличиваем по ΔU и Iкз
  let sec = pickSection(breakerA, MIN_SECTION[g.kind]);
  trace.push({
    what: 'Сечение по току',
    value: `${sec.s} мм² (Iдоп ${sec.iA} А)`,
    how: `Минимальное сечение ${MIN_SECTION[g.kind]} мм², Iдоп ≥ In = ${breakerA} А`,
    source: CABLE_TABLE_SOURCE,
  });
  const mult = INSTANT_TRIP_MULT[curve];
  const ikRequiredA = mult * breakerA;
  // По каждому участку течёт ток всех точек, стоящих дальше по трассе.
  const downstreamA = ordered.map((_, i) =>
    ordered.slice(i).reduce((s, d) => s + d.powerW / (U * DEVICE_TYPES[d.typeKey].cosPhi), 0),
  );
  const dropPct = (s: number) =>
    segM.reduce((sum, len, i) => sum + voltageDropPct(len, downstreamA[i], cosPhi, s, U), 0);
  let dU = dropPct(sec.s);
  let loop = loopImpedance(settings.zExtOhm, lengthM, sec.s);
  let ik = U / loop;
  while ((dU > settings.dUMaxPct || ik < ikRequiredA) && nextSection(sec.s)) {
    const reason = dU > settings.dUMaxPct ? `ΔU ${fmt(dU, 2)} % > ${settings.dUMaxPct} %` : `Iкз ${fmt(ik, 0)} А < ${ikRequiredA} А`;
    sec = nextSection(sec.s)!;
    trace.push({ what: 'Сечение увеличено', value: `${sec.s} мм²`, how: reason });
    dU = dropPct(sec.s);
    loop = loopImpedance(settings.zExtOhm, lengthM, sec.s);
    ik = U / loop;
  }

  trace.push({
    what: 'Потеря напряжения',
    value: `${fmt(dU, 2)} %`,
    how: `Сумма по участкам: ΔU = 2·l·I·cosφ·ρ / (S·U), на каждом участке ток точек дальше по трассе; ρ = ${RHO_CU} Ом·мм²/м`,
    source: SOURCES.dU,
  });
  trace.push({
    what: 'Ток КЗ в конце линии',
    value: `${fmt(ik, 0)} А`,
    how: `Iкз = U / (Zвнеш + 2·ρ·L/S) = ${U} / (${settings.zExtOhm} + ${fmt((2 * RHO_CU * lengthM) / sec.s, 3)}); нужно ≥ ${mult}·In = ${ikRequiredA} А`,
    source: SOURCES.loop,
  });

  checks.push({ ok: I <= breakerA && breakerA <= sec.iA, text: `Iр ${fmt(I)} ≤ In ${breakerA} ≤ Iдоп ${sec.iA} А` });
  checks.push({ ok: dU <= settings.dUMaxPct, text: `ΔU ${fmt(dU, 2)} % ≤ ${settings.dUMaxPct} %` });
  checks.push({ ok: ik >= ikRequiredA, text: `Iкз ${fmt(ik, 0)} А ≥ ${ikRequiredA} А` });
  if (g.kind === 'socket') {
    checks.push({
      ok: g.devices.length <= settings.socketGroupMaxCount,
      text: `Розеток в группе ${g.devices.length} ≤ ${settings.socketGroupMaxCount}`,
    });
  }

  const { title, roomNames } = groupTitle(g, rooms);
  return {
    key: g.key,
    no,
    title,
    kind: g.kind,
    deviceIds: ordered.map((d) => d.id),
    roomNames,
    powerW: P,
    cosPhi,
    currentA: I,
    phase: 1,
    breakerA,
    curve,
    rcd,
    sectionMm2: sec.s,
    cableMark: `${CABLE_BRAND} 3×${String(sec.s).replace('.', ',')}`,
    iAllowedA: sec.iA,
    lengthM,
    route,
    dUPct: dU,
    loopOhm: loop,
    ikA: ik,
    ikRequiredA,
    checks,
    trace,
  };
}

function assignPhases(groups: GroupCalc[], settings: Settings): [number, number, number] {
  const loads: [number, number, number] = [0, 0, 0];
  if (settings.phases === 1) {
    groups.forEach((g) => {
      g.phase = 1;
      loads[0] += g.powerW;
    });
    return loads;
  }
  [...groups]
    .sort((a, b) => b.powerW - a.powerW)
    .forEach((g) => {
      const i = loads.indexOf(Math.min(...loads));
      g.phase = (i + 1) as 1 | 2 | 3;
      loads[i] += g.powerW;
    });
  return loads;
}

function calcPanel(groups: GroupCalc[], loads: [number, number, number], settings: Settings): PanelCalc {
  const trace: Trace[] = [];
  const checks: PanelCalc['checks'] = [];
  const installed = groups.reduce((s, g) => s + g.powerW, 0);
  const design = installed * settings.kc;
  const apparent = groups.reduce((s, g) => s + g.powerW / g.cosPhi, 0);
  const cos = apparent > 0 ? installed / apparent : 1;
  const current = settings.phases === 1 ? design / (settings.U * cos) : design / (3 * settings.U * cos);
  const maxGroup = Math.max(0, ...groups.map((g) => g.breakerA));
  const inputBreakerA = pickBreaker(current, Math.min(maxGroup + 1, 100));

  trace.push({ what: 'Установленная мощность', value: `${fmt(installed / 1000, 2)} кВт`, how: 'Сумма мощностей всех групп' });
  trace.push({ what: 'Расчётная мощность', value: `${fmt(design / 1000, 2)} кВт`, how: `Рр = Ру·Кс, Кс = ${settings.kc}`, source: SOURCES.kc });
  trace.push({
    what: 'Ток на вводе',
    value: `${fmt(current)} А`,
    how: settings.phases === 1 ? `I = Рр / (U·cosφ), cosφ = ${fmt(cos, 2)}` : `I = Рр / (3·Uф·cosφ), cosφ = ${fmt(cos, 2)}`,
  });
  trace.push({
    what: 'Вводной автомат',
    value: `${settings.phases === 1 ? '1P+N' : '3P+N'} C${inputBreakerA}`,
    how: `Номинал ≥ расчётного тока и больше самого крупного группового (${maxGroup} А) для селективности`,
  });

  checks.push({
    ok: design <= settings.pAllowedW,
    text: `Рр ${fmt(design / 1000, 2)} кВт ≤ разрешённой по ТУ ${fmt(settings.pAllowedW / 1000, 1)} кВт`,
  });
  if (settings.phases === 3) {
    const max = Math.max(...loads);
    const min = Math.min(...loads);
    const imb = max > 0 ? ((max - min) / max) * 100 : 0;
    checks.push({ ok: imb <= 30, text: `Перекос фаз ${fmt(imb, 0)} % ≤ 30 %` });
  }
  return { installedW: installed, designW: design, currentA: current, inputBreakerA, phaseLoadsW: loads, checks, trace };
}

export function computeProject(project: Project): ProjectCalc {
  const drafts = buildGroups(project);
  const groups = drafts.map((g, i) => calcGroup(g, i + 1, project));
  const loads = assignPhases(groups, project.settings);
  return { groups, panel: calcPanel(groups, loads, project.settings) };
}
