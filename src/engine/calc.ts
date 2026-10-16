// Расчётный движок: группы, токи, автоматы, сечения, потери напряжения, петля «фаза–нуль».
// Чистые функции без побочных эффектов: на вход проект, на выход полный расчёт с обоснованиями.

import { centroid, manhattan } from './geometry';
import { nearestWallPoint } from './wall';
import { findPassages, passRoute, pathVia, polyLen, WALL_PENALTY, type Passage } from './passages';
import { roomAt } from './placement';
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
  JunctionBox,
  PanelCalc,
  PassageCalc,
  Project,
  ProjectCalc,
  Pt,
  Room,
  Settings,
  Trace,
} from './types';

/** Высота установки щита, мм. */
const PANEL_H = 1600;
/** Коробка ставится у стены, на этом расстоянии от неё, мм. */
const BOX_INSET = 120;

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

/**
 * Коробка у стены со стороны, откуда приходит магистраль. Если так она встаёт вплотную к щиту
 * (помещение со щитом), сдвигаем её к стене, ближайшей к точкам этого помещения.
 */
function autoBoxPos(poly: Pt[], from: Pt, devs: Device[], panel: Pt): Pt {
  const p = nearestWallPoint(poly, from, BOX_INSET);
  if (manhattan(p, panel) >= 700) return p;
  const c = {
    x: devs.reduce((s, d) => s + d.pos.x, 0) / devs.length,
    y: devs.reduce((s, d) => s + d.pos.y, 0) / devs.length,
  };
  return nearestWallPoint(poly, c, BOX_INSET);
}

/** Ток потребителя, А. */
const deviceA = (d: Device, U: number) => d.powerW / (U * DEVICE_TYPES[d.typeKey].cosPhi);

/** Ветка сети: участок кабеля, точки, которые он питает, и предыдущий участок по пути от щита. */
interface Seg {
  lenM: number;
  feeds: Device[];
  parent: number;
}

/**
 * Сеть группы. Отдельная линия — один кабель от щита до потребителя.
 * Остальные группы: магистраль щит → коробка помещения → следующая коробка …,
 * от каждой коробки — ответвления к точкам этого помещения.
 */
export function routeGroup(
  g: { key: string; kind: DeviceKind; devices: Device[] },
  project: Project,
  passages: Passage[] = findPassages(project.rooms, project.passPos),
) {
  const { panel, settings, rooms } = project;
  const panelRoom = roomAt(panel, rooms);
  const crossed: string[] = [];
  /** Трасса между точками разных помещений — через общие проходы в стенах. */
  const via = (a: Pt, ra: string | null, b: Pt, rb: string | null) => {
    const route = passRoute(a, ra, b, rb, passages);
    crossed.push(...route.map((p) => p.key));
    const pts = pathVia(a, route, b);
    paths.push(pts);
    return { len: polyLen(pts), route };
  };
  const k = 1 + settings.lengthReserve;
  const drop = (d: Device) => Math.max(settings.ceilingH - DEVICE_TYPES[d.typeKey].mountH, 0);
  const panelRise = Math.max(settings.ceilingH - PANEL_H, 0);
  const segs: Seg[] = [];
  const leafOf = new Map<string, number>();
  const paths: Pt[][] = [];
  const boxes: JunctionBox[] = [];
  const ordered: Device[] = [];
  let horiz = 0;
  let vert = 0;
  const addSeg = (h: number, v: number, feeds: Device[], parent: number) => {
    horiz += h;
    vert += v;
    segs.push({ lenM: ((h + v) / 1000) * k, feeds, parent });
    return segs.length - 1;
  };

  // Без коробок: отдельная линия и точки вне помещений идут от щита напрямую.
  const direct = g.kind === 'dedicated' ? g.devices : g.devices.filter((d) => !rooms.some((r) => r.id === d.roomId));
  for (const d of direct) {
    leafOf.set(d.id, addSeg(via(panel, panelRoom, d.pos, d.roomId).len, panelRise + drop(d), [d], -1));
    ordered.push(d);
  }

  // Коробки: по одной на помещение. Магистраль — дерево от щита: каждое следующее помещение
  // подключается к ближайшей уже поставленной коробке (с учётом штрафа за проход через стену),
  // поэтому трасса не возвращается через уже пройденные помещения.
  const buckets = new Map<string, Device[]>();
  for (const d of g.devices) {
    if (direct.includes(d)) continue;
    buckets.set(d.roomId!, [...(buckets.get(d.roomId!) ?? []), d]);
  }
  type Node = { roomId: string | null; pos: Pt; parent: number; devs: Device[]; key: string };
  const nodes: Node[] = [{ roomId: panelRoom, pos: panel, parent: -1, devs: [], key: '' }];
  const left = [...buckets.keys()];
  while (left.length) {
    let best: { ni: number; roomId: string; entry: Pt; cost: number } | null = null;
    for (let ni = 0; ni < nodes.length; ni++) {
      // От щита уходит один кабель группы: щит может питать только первую коробку.
      if (ni === 0 && nodes.length > 1) continue;
      const n = nodes[ni];
      for (const roomId of left) {
        const room = rooms.find((r) => r.id === roomId)!;
        const target = project.boxPos?.[`${g.key}@${roomId}`] ?? centroid(room.poly);
        const route = passRoute(n.pos, n.roomId, target, roomId, passages);
        const cost = polyLen(pathVia(n.pos, route, target)) + route.length * WALL_PENALTY;
        if (!best || cost < best.cost) best = { ni, roomId, entry: route.at(-1)?.pos ?? n.pos, cost };
      }
    }
    const { ni, roomId, entry } = best!;
    const room = rooms.find((r) => r.id === roomId)!;
    const devs = buckets.get(roomId)!;
    const key = `${g.key}@${roomId}`;
    // Коробку без ручного положения ставим у стены, через которую магистраль входит в помещение.
    const pos = project.boxPos?.[key] ?? autoBoxPos(room.poly, entry, devs, panel);
    nodes.push({ roomId, pos, parent: ni, devs, key });
    left.splice(left.indexOf(roomId), 1);
  }
  // Что питает участок магистрали: точки своего помещения и всех помещений дальше по дереву.
  const sub = nodes.map((n) => [...n.devs]);
  for (let i = nodes.length - 1; i > 0; i--) if (nodes[i].parent > 0) sub[nodes[i].parent].push(...sub[i]);
  const segOf: number[] = [-1];
  for (let i = 1; i < nodes.length; i++) {
    const n = nodes[i];
    const from = nodes[n.parent];
    boxes.push({ key: n.key, groupKey: g.key, roomId: n.roomId!, pos: n.pos, outlets: n.devs.length });
    const trunk = addSeg(via(from.pos, from.roomId, n.pos, n.roomId).len, n.parent === 0 ? panelRise : 0, sub[i], segOf[n.parent]);
    segOf.push(trunk);
    const spokes = routeOrder(n.pos, n.devs.map((d) => ({ id: d.id, pos: d.pos }))).map((id) => n.devs.find((d) => d.id === id)!);
    for (const d of spokes) {
      leafOf.set(d.id, addSeg(manhattan(n.pos, d.pos), drop(d), [d], trunk));
      paths.push(orthoPath([n.pos, d.pos]));
      ordered.push(d);
    }
  }

  const pathM = (leaf: number) => {
    let s = 0;
    for (let i = leaf; i >= 0; i = segs[i].parent) s += segs[i].lenM;
    return s;
  };
  const maxPathM = Math.max(0, ...[...leafOf.values()].map(pathM));
  const lengthM = Math.ceil(segs.reduce((s, x) => s + x.lenM, 0));

  /** Наибольшая потеря напряжения по пути от щита до любой точки группы, %. */
  const dropPct = (s: number, cosPhi: number, U: number) => {
    let worst = 0;
    for (const leaf of leafOf.values()) {
      let sum = 0;
      for (let i = leaf; i >= 0; i = segs[i].parent) {
        const iA = segs[i].feeds.reduce((a, d) => a + deviceA(d, U), 0);
        sum += voltageDropPct(segs[i].lenM, iA, cosPhi, s, U);
      }
      worst = Math.max(worst, sum);
    }
    return worst;
  };

  return { ordered, paths, boxes, crossed, lengthM, maxPathM, horizM: horiz / 1000, vertM: vert / 1000, dropPct };
}

function calcGroup(g: DraftGroup, no: number, project: Project, passages: Passage[]): GroupCalc {
  const { settings, rooms } = project;
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

  // Трасса: щит → распределительные коробки (по одной на помещение) → ответвления к точкам
  const net = routeGroup(g, project, passages);
  const { ordered, lengthM } = net;
  trace.push({
    what: 'Длина кабеля',
    value: `${lengthM} м`,
    how:
      `По потолку ортогонально: ${fmt(net.horizM)} м по плану + ${fmt(net.vertM)} м спусков, запас ${Math.round(settings.lengthReserve * 100)} %` +
      (net.boxes.length ? `; ${net.boxes.length} распред. коробок, до самой дальней точки ${fmt(net.maxPathM)} м` : '') +
      (net.crossed.length ? `; ${net.crossed.length} проход(а) через стены по общим отверстиям` : ''),
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
  const dropPct = (s: number) => net.dropPct(s, cosPhi, U);
  const loopLen = net.maxPathM;
  let dU = dropPct(sec.s);
  let loop = loopImpedance(settings.zExtOhm, loopLen, sec.s);
  let ik = U / loop;
  while ((dU > settings.dUMaxPct || ik < ikRequiredA) && nextSection(sec.s)) {
    const reason = dU > settings.dUMaxPct ? `ΔU ${fmt(dU, 2)} % > ${settings.dUMaxPct} %` : `Iкз ${fmt(ik, 0)} А < ${ikRequiredA} А`;
    sec = nextSection(sec.s)!;
    trace.push({ what: 'Сечение увеличено', value: `${sec.s} мм²`, how: reason });
    dU = dropPct(sec.s);
    loop = loopImpedance(settings.zExtOhm, loopLen, sec.s);
    ik = U / loop;
  }

  trace.push({
    what: 'Потеря напряжения',
    value: `${fmt(dU, 2)} %`,
    how: `До самой нагруженной точки, сумма по участкам: ΔU = 2·l·I·cosφ·ρ / (S·U), на участке течёт ток всех точек за ним; ρ = ${RHO_CU} Ом·мм²/м`,
    source: SOURCES.dU,
  });
  trace.push({
    what: 'Ток КЗ в конце линии',
    value: `${fmt(ik, 0)} А`,
    how: `Iкз = U / (Zвнеш + 2·ρ·L/S) = ${U} / (${settings.zExtOhm} + ${fmt((2 * RHO_CU * loopLen) / sec.s, 3)}), L = ${fmt(loopLen)} м до дальней точки; нужно ≥ ${mult}·In = ${ikRequiredA} А`,
    source: SOURCES.loop,
  });

  checks.push({ ok: I <= breakerA && breakerA <= sec.iA, text: `Iр ${fmt(I)} ≤ In ${breakerA} ≤ Iдоп ${sec.iA} А` });
  checks.push({ ok: dU <= settings.dUMaxPct, text: `ΔU ${fmt(dU, 2)} % ≤ ${settings.dUMaxPct} %` });
  checks.push({ ok: ik >= ikRequiredA, text: `Iкз ${fmt(ik, 0)} А ≥ ${ikRequiredA} А` });
  if (g.kind === 'socket') {
    const n = g.devices.filter((d) => DEVICE_TYPES[d.typeKey].kind === 'socket').length;
    checks.push({
      ok: n <= settings.socketGroupMaxCount,
      text: `Розеток в группе ${n} ≤ ${settings.socketGroupMaxCount}`,
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
    paths: net.paths,
    boxes: net.boxes,
    passages: net.crossed,
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
  const walls = findPassages(project.rooms, project.passPos);
  const groups = drafts.map((g, i) => calcGroup(g, i + 1, project, walls));
  const loads = assignPhases(groups, project.settings);
  return { groups, panel: calcPanel(groups, loads, project.settings), passages: calcPassages(walls, groups) };
}

/** Ориентировочный наружный диаметр кабеля ВВГнг(А)-LS 3×S, мм. */
const CABLE_OD: Record<number, number> = { 1.5: 9.4, 2.5: 10.4, 4: 12.1, 6: 13.3, 10: 16.4, 16: 18.6 };
/** Гильзы (трубы) для прохода через стену, наружный диаметр, мм. */
const SLEEVES = [16, 20, 25, 32, 40, 50, 63, 75, 90, 110];

/**
 * Используемые проходы: сколько кабелей идёт через отверстие и какая нужна гильза.
 * Гильза подбирается с заполнением сечения кабелями не более 40 %.
 */
export function calcPassages(walls: Passage[], groups: GroupCalc[]): PassageCalc[] {
  const out: PassageCalc[] = [];
  for (const w of walls) {
    const users = groups.flatMap((g) => g.passages.filter((k) => k === w.key).map(() => g));
    if (!users.length) continue;
    const sumD2 = users.reduce((s, g) => s + (CABLE_OD[g.sectionMm2] ?? 20) ** 2, 0);
    const inner = Math.sqrt(sumD2 / 0.4);
    const sleeve = SLEEVES.find((d) => d * 0.8 >= inner) ?? SLEEVES[SLEEVES.length - 1];
    out.push({
      key: w.key,
      rooms: w.rooms,
      pos: w.pos,
      a: w.a,
      b: w.b,
      vertical: w.vertical,
      cables: users.length,
      groupNos: [...new Set(users.map((g) => g.no))],
      sleeveMm: sleeve,
    });
  }
  return out;
}
