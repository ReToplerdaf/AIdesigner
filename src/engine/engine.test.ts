import { describe, expect, it } from 'vitest';
import { classifyName, parsePowerW, parseSpecRows, splitText } from './classify';
import { computeProject, pickBreaker, pickSection, voltageDropPct } from './calc';
import { autoPlace, distribute } from './placement';
import { demoProject, DEMO_ROOMS, DEMO_SPEC_TEXT } from '../data/demo';

describe('классификация спецификации', () => {
  it('распознаёт типы по наименованию', () => {
    expect(classifyName('Варочная панель индукционная').typeKey).toBe('hob');
    expect(classifyName('Розетка двойная с заземлением').typeKey).toBe('socket');
    expect(classifyName('Светильник потолочный LED').typeKey).toBe('light');
    expect(classifyName('СМ Bosch').typeKey).toBe('washer');
    expect(classifyName('Тёплый пол в ванной').typeKey).toBe('floor_heating');
    expect(classifyName('Непонятная штука').confidence).toBe(0);
  });

  it('достаёт мощность из текста', () => {
    expect(parsePowerW('Духовой шкаф 3,5 кВт')).toBe(3500);
    expect(parsePowerW('Светильник 40 Вт')).toBe(40);
    expect(parsePowerW('без мощности')).toBeNull();
  });

  it('разбирает таблицу с заголовком', () => {
    const items = parseSpecRows(splitText(DEMO_SPEC_TEXT));
    expect(items).toHaveLength(12);
    const hob = items.find((i) => i.typeKey === 'hob')!;
    expect(hob.powerW).toBe(7000);
    const apron = items.find((i) => i.name.includes('столешниц'))!;
    expect(apron.roomHint).toBe('Кухня');
    expect(items.find((i) => i.typeKey === 'light')!.powerW).toBe(40);
  });
});

describe('автораскладка', () => {
  it('распределяет по наибольшим остаткам без потерь', () => {
    expect(distribute(10, [1, 1, 1]).reduce((a, b) => a + b, 0)).toBe(10);
    expect(distribute(3, [0, 0])).toEqual([3, 0]);
  });

  it('ставит все позиции и кухонные приборы на кухню', () => {
    const p = demoProject();
    const total = p.spec.reduce((s, i) => s + i.qty, 0);
    expect(p.devices).toHaveLength(total);
    const hob = p.devices.find((d) => d.typeKey === 'hob')!;
    expect(hob.roomId).toBe('r-kitchen');
    const washer = p.devices.find((d) => d.typeKey === 'washer')!;
    expect(washer.roomId).toBe('r-bath');
    expect(p.devices.filter((d) => d.typeKey === 'light' && d.roomId === 'r-wc').length).toBeGreaterThan(0);
  });

  it('без помещений ставит всё возле щита', () => {
    const p = demoProject();
    const devices = autoPlace(p.spec, [], { x: 0, y: 0 });
    expect(devices.every((d) => d.roomId === null)).toBe(true);
    expect(DEMO_ROOMS.length).toBe(6);
  });
});

describe('расчёт', () => {
  it('подбирает автомат и сечение', () => {
    expect(pickBreaker(7.2, 16)).toBe(16);
    expect(pickBreaker(31)).toBe(32);
    expect(pickSection(16, 2.5).s).toBe(2.5);
    expect(pickSection(32, 2.5).s).toBe(4);
    expect(pickSection(10, 1.5).s).toBe(1.5);
  });

  it('считает потерю напряжения', () => {
    // 2·20·16·1·0,0225 / 2,5 / 230 · 100 ≈ 2,5 %
    expect(voltageDropPct(20, 16, 1, 2.5, 230)).toBeCloseTo(2.504, 2);
  });

  it('варочная панель 7 кВт идёт отдельной линией C32 не меньше 4 мм²', () => {
    const calc = computeProject(demoProject());
    const hob = calc.groups.find((g) => g.title === 'Варочная панель')!;
    expect(hob.kind).toBe('dedicated');
    expect(hob.breakerA).toBe(32);
    expect(hob.sectionMm2).toBeGreaterThanOrEqual(4);
  });

  it('все группы проходят проверки, номера идут подряд', () => {
    const calc = computeProject(demoProject());
    expect(calc.groups.length).toBeGreaterThan(5);
    calc.groups.forEach((g, i) => {
      expect(g.no).toBe(i + 1);
      for (const c of g.checks) expect(c.ok, `${g.title}: ${c.text}`).toBe(true);
    });
    expect(calc.groups.filter((g) => g.kind === 'socket').every((g) => g.rcd)).toBe(true);
    expect(calc.groups.filter((g) => g.kind === 'light').every((g) => g.curve === 'B')).toBe(true);
  });

  it('перенос точки дальше от щита удлиняет кабель', () => {
    const p = demoProject();
    const before = computeProject(p);
    const hobId = p.devices.find((d) => d.typeKey === 'hob')!.id;
    const moved = { ...p, devices: p.devices.map((d) => (d.id === hobId ? { ...d, pos: { x: 3400, y: 100 } } : d)) };
    const after = computeProject(moved);
    const len = (c: typeof before) => c.groups.find((g) => g.deviceIds.includes(hobId))!.lengthM;
    expect(len(after)).toBeGreaterThan(len(before));
  });

  it('ручное назначение группы переносит устройство', () => {
    const p = demoProject();
    const sock = p.devices.find((d) => d.typeKey === 'socket' && d.roomId === 'r-living')!;
    const moved = { ...p, devices: p.devices.map((d) => (d.id === sock.id ? { ...d, groupKey: 'manual:1' } : d)) };
    const calc = computeProject(moved);
    const g = calc.groups.find((x) => x.key === 'manual:1')!;
    expect(g.deviceIds).toEqual([sock.id]);
  });

  it('трёхфазный ввод распределяет группы по фазам', () => {
    const p = demoProject();
    p.settings = { ...p.settings, phases: 3, pAllowedW: 15000 };
    const calc = computeProject(p);
    expect(new Set(calc.groups.map((g) => g.phase)).size).toBe(3);
  });
});
