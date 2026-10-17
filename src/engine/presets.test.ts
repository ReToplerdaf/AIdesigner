import { describe, expect, it } from 'vitest';
import { generateSpec, presetQty, presetsFromProject, STANDARD_PRESETS } from './presets';
import { autoPlace, cornerSpots } from './placement';
import { computeProject } from './calc';
import { rect } from './geometry';
import { demoProject, DEMO_ROOMS } from '../data/demo';
import type { Room } from './types';

describe('типовые наборы по помещениям', () => {
  it('считает количество числом, по площади и с минимумом', () => {
    const big: Room = { id: 'a', name: 'Гостиная', type: 'living', poly: rect(0, 0, 6000, 5000) }; // 30 м²
    const small: Room = { id: 'b', name: 'Спальня', type: 'bedroom', poly: rect(0, 0, 3000, 3000) }; // 9 м²
    const light = STANDARD_PRESETS.living.find((i) => i.typeKey === 'light')!;
    expect(presetQty(light, big)).toBe(4);
    expect(presetQty(light, small)).toBe(2);
    expect(presetQty({ ...light, rule: 'perimeter', value: 4, min: 0 }, big)).toBe(6);
    expect(presetQty(STANDARD_PRESETS.living.find((i) => i.typeKey === 'socket')!, big)).toBe(4);
  });

  it('даёт каждому помещению набор его типа с привязкой к помещению', () => {
    const spec = generateSpec(DEMO_ROOMS, STANDARD_PRESETS);
    const kitchen = spec.filter((s) => s.roomId === 'r-kitchen').map((s) => s.typeKey);
    expect(kitchen).toEqual(expect.arrayContaining(['hob', 'hood', 'oven', 'light', 'switch', 'socket']));
    expect(spec.filter((s) => s.roomId === 'r-bath').map((s) => s.typeKey)).toContain('washer');
    expect(spec.every((s) => s.confidence === 1 && s.roomHint)).toBe(true);
  });

  it('раскладка ставит позиции в своё помещение, даже если имена похожи', () => {
    const rooms: Room[] = [
      { id: 's1', name: 'Спальня', type: 'bedroom', poly: rect(0, 0, 3000, 3000) },
      { id: 's2', name: 'Спальня 2', type: 'bedroom', poly: rect(3000, 0, 6000, 3000) },
    ];
    const spec = generateSpec(rooms, STANDARD_PRESETS);
    const devices = autoPlace(spec, rooms, { x: 0, y: 0 }, { passages: false });
    for (const r of rooms) {
      expect(devices.filter((d) => d.roomId === r.id && d.typeKey === 'socket')).toHaveLength(4);
      expect(devices.filter((d) => d.roomId === r.id && d.typeKey === 'light')).toHaveLength(2);
    }
  });

  it('розетки «по углам» встают у четырёх углов комнаты', () => {
    const room: Room = { id: 'r', name: 'Комната', type: 'living', poly: rect(0, 0, 4000, 3000) };
    expect(cornerSpots(room.poly)).toHaveLength(4);
    const spec = generateSpec([room], { ...STANDARD_PRESETS, living: STANDARD_PRESETS.living.filter((i) => i.typeKey === 'socket') });
    const pts = autoPlace(spec, [room], { x: 0, y: 0 }, { passages: false }).map((d) => d.pos);
    const corners = room.poly;
    for (const c of corners) expect(pts.some((p) => Math.hypot(p.x - c.x, p.y - c.y) < 600)).toBe(true);
  });

  it('у Г-образной комнаты внутренний угол не считается', () => {
    const L = [
      { x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 2000 },
      { x: 2000, y: 2000 }, { x: 2000, y: 4000 }, { x: 0, y: 4000 },
    ];
    expect(cornerSpots(L)).toHaveLength(5);
  });

  it('проект из наборов считается без ошибок', () => {
    const p = demoProject();
    const spec = generateSpec(DEMO_ROOMS, STANDARD_PRESETS);
    const devices = autoPlace(spec, DEMO_ROOMS, p.panel);
    const calc = computeProject({ ...p, spec, devices });
    expect(calc.groups.length).toBeGreaterThan(5);
    expect(calc.groups.some((g) => g.title.length > 0)).toBe(true);
  });

  it('берёт наборы из готового объекта по средним количествам', () => {
    const p = demoProject();
    const t = presetsFromProject(p, STANDARD_PRESETS);
    expect(t.kitchen.some((i) => i.typeKey === 'hob' && i.value === 1)).toBe(true);
    expect(t.kitchen[0].typeKey).toBe('light');
    // Типа «балкон» в демо нет — он остаётся стандартным.
    expect(t.balcony).toEqual(STANDARD_PRESETS.balcony);
    // Проходные отверстия в наборы не попадают.
    expect(Object.values(t).flat().some((i) => i.typeKey === 'passage')).toBe(false);
  });
});
