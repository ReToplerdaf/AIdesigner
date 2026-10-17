import { useState } from 'react';
import { DEVICE_TYPES, ROOM_TYPES } from '../engine/norms';
import { clonePresets, presetQty, presetsFromProject, STANDARD_PRESETS, type PresetItem, type PresetTable, type QtyRule } from '../engine/presets';
import type { DeviceTypeKey, Project, RoomType } from '../engine/types';
import { download } from './state';

interface Props {
  table: PresetTable;
  setTable: (t: PresetTable) => void;
  project: Project;
  onClose: () => void;
}

const RULES: { key: QtyRule; label: string; title: string }[] = [
  { key: 'fixed', label: 'шт', title: 'Штук на помещение' },
  { key: 'area', label: 'на м²', title: '1 шт. на столько м² площади' },
  { key: 'perimeter', label: 'на м', title: '1 шт. на столько метров периметра' },
];

/** Типы, которые можно выбрать в наборе (проход — не потребитель). */
const TYPES = Object.values(DEVICE_TYPES).filter((t) => t.key !== 'passage');

export function PresetsEditor({ table, setTable, project, onClose }: Props) {
  const firstType = (project.rooms[0]?.type ?? 'living') as RoomType;
  const [type, setType] = useState<RoomType>(firstType);
  const [error, setError] = useState('');
  const items = table[type] ?? [];
  const rooms = project.rooms.filter((r) => r.type === type);

  const setItems = (next: PresetItem[]) => setTable({ ...table, [type]: next });
  const edit = (i: number, patch: Partial<PresetItem>) => setItems(items.map((it, k) => (k === i ? { ...it, ...patch } : it)));

  const fromFile = async (f: File) => {
    setError('');
    try {
      const data = JSON.parse(await f.text());
      // Файл наборов (выгруженный кнопкой ниже) или файл проекта.
      if (data && Array.isArray(data.rooms) && Array.isArray(data.devices)) setTable(presetsFromProject(data as Project, table));
      else if (data && typeof data === 'object' && Object.keys(data).every((k) => k in ROOM_TYPES)) setTable({ ...clonePresets(table), ...data });
      else throw new Error('это не проект и не файл наборов');
    } catch (e) {
      setError(`Не удалось прочитать: ${(e as Error).message}`);
    }
  };

  return (
    <div className="stack">
      <div className="row between">
        <strong>Типовые наборы</strong>
        <button className="btn small" onClick={onClose}>Готово</button>
      </div>
      <p className="muted small">
        Что ставится в помещение каждого типа. Количество — числом, по площади или по периметру; «по углам» — розетки встают у углов комнаты.
      </p>
      <div className="preset-types">
        {(Object.keys(ROOM_TYPES) as RoomType[]).map((t) => {
          const n = project.rooms.filter((r) => r.type === t).length;
          return (
            <button key={t} id={`pt-${t}`} className={`chip${t === type ? ' on' : ''}`} onClick={() => setType(t)}>
              {ROOM_TYPES[t].label}
              {n > 0 && <span className="chip-n">{n}</span>}
            </button>
          );
        })}
      </div>

      <div className="preset-list">
        {items.map((it, i) => (
          <div key={i} className="preset-item">
            <div className="row nowrap">
              <input className="grow" value={it.name} onChange={(e) => edit(i, { name: e.target.value })} title="Наименование" />
              <button className="btn small danger" title="Убрать из набора" onClick={() => setItems(items.filter((_, k) => k !== i))}>✕</button>
            </div>
            <div className="preset-fields">
              <select
                value={it.typeKey}
                onChange={(e) => {
                  const typeKey = e.target.value as DeviceTypeKey;
                  edit(i, { typeKey, powerW: DEVICE_TYPES[typeKey].defaultPowerW });
                }}
              >
                {TYPES.map((t) => (
                  <option key={t.key} value={t.key}>{t.label}</option>
                ))}
              </select>
              <input type="number" min={0} step={it.rule === 'fixed' ? 1 : 0.5} value={it.value} title={RULES.find((r) => r.key === it.rule)!.title} onChange={(e) => edit(i, { value: Math.max(0, +e.target.value || 0) })} />
              <select value={it.rule} onChange={(e) => edit(i, { rule: e.target.value as QtyRule, value: e.target.value === 'fixed' ? 1 : e.target.value === 'area' ? 8 : 4, min: e.target.value === 'fixed' ? undefined : 1 })}>
                {RULES.map((r) => (
                  <option key={r.key} value={r.key} title={r.title}>{r.label}</option>
                ))}
              </select>
              <input type="number" min={0} step={0.1} value={it.powerW / 1000} title="Мощность одной единицы, кВт" onChange={(e) => edit(i, { powerW: Math.round((+e.target.value || 0) * 1000) })} />
              <span className="unit">кВт</span>
            </div>
            <div className="row small">
              {it.rule !== 'fixed' && (
                <label className="muted">
                  не меньше{' '}
                  <input className="tiny" type="number" min={0} value={it.min ?? 0} onChange={(e) => edit(i, { min: Math.max(0, Math.round(+e.target.value || 0)) })} /> шт
                </label>
              )}
              {(it.typeKey === 'socket' || it.typeKey === 'other') && (
                <label className="muted">
                  <input type="checkbox" checked={it.place === 'corners'} onChange={(e) => edit(i, { place: e.target.checked ? 'corners' : undefined })} /> по углам
                </label>
              )}
              {rooms.length > 0 && (
                <span className="muted">
                  на плане: {rooms.map((r) => `${r.name} — ${presetQty(it, r)}`).join(', ')}
                </span>
              )}
            </div>
          </div>
        ))}
        {items.length === 0 && <p className="muted small">Набор пуст: в помещения этого типа ничего не ставится.</p>}
      </div>
      <button className="btn small" onClick={() => setItems([...items, { name: 'Розетка', typeKey: 'socket', powerW: DEVICE_TYPES.socket.defaultPowerW, rule: 'fixed', value: 1 }])}>
        + Позиция
      </button>

      <div className="stack-s preset-actions">
        <div className="row">
          <button className="btn small" title="Наборы по средним количествам точек в помещениях текущего проекта" onClick={() => setTable(presetsFromProject(project, table))} disabled={project.devices.length === 0}>
            Взять из текущего объекта
          </button>
          <label className="btn small" title="Файл проекта (.json) или файл наборов">
            Взять из файла…
            <input id="presets-file" type="file" accept=".json" hidden onChange={(e) => e.target.files?.[0] && fromFile(e.target.files[0])} />
          </label>
        </div>
        <div className="row">
          <button className="btn small" onClick={() => download('Типовые наборы.json', JSON.stringify(table, null, 1), 'application/json')}>
            Выгрузить наборы
          </button>
          <button className="btn small danger" onClick={() => confirm('Вернуть стандартные наборы? Ваши правки пропадут.') && setTable(clonePresets(STANDARD_PRESETS))}>
            Сбросить к стандартным
          </button>
        </div>
        {error && <p className="bad small">{error}</p>}
        <p className="muted small">Наборы сохраняются в этом браузере и применяются ко всем объектам.</p>
      </div>
    </div>
  );
}
