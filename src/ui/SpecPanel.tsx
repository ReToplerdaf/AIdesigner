import { useState } from 'react';
import * as XLSX from 'xlsx';
import { parseSpecRows, splitText } from '../engine/classify';
import { DEVICE_TYPES } from '../engine/norms';
import { autoPlace, matchRooms, roomAt } from '../engine/placement';
import { pointOnPerimeter } from '../engine/geometry';
import type { DeviceTypeKey, SpecItem } from '../engine/types';
import { DEMO_SPEC_TEXT } from '../data/demo';
import { fmt, type Update } from './state';
import type { Project } from '../engine/types';

export function SpecPanel({ project, update }: { project: Project; update: Update }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');

  const setSpec = (spec: SpecItem[]) => update((p) => ({ ...p, spec }));

  const onFile = async (f: File) => {
    setError('');
    try {
      if (/\.(xlsx|xls|ods)$/i.test(f.name)) {
        const wb = XLSX.read(await f.arrayBuffer());
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json<(string | number)[]>(ws, { header: 1, raw: false });
        setSpec(parseSpecRows(rows));
      } else {
        setSpec(parseSpecRows(splitText(await f.text())));
      }
    } catch (e) {
      setError(`Не удалось прочитать файл: ${(e as Error).message}`);
    }
  };

  const edit = (id: string, patch: Partial<SpecItem>) =>
    update((p) => ({ ...p, spec: p.spec.map((s) => (s.id === id ? { ...s, ...patch } : s)) }));

  const place = () =>
    update((p) => {
      // Если щит стоит вне помещений, ставим его в прихожую (или в первое помещение) у стены.
      let panel = p.panel;
      if (p.rooms.length && !roomAt(panel, p.rooms)) {
        const r = p.rooms.find((x) => x.type === 'hall') ?? p.rooms[0];
        panel = pointOnPerimeter(r.poly, 0.02, 300);
      }
      return { ...p, panel, devices: autoPlace(p.spec, p.rooms, panel, { autoSwitches: p.settings.autoSwitches ?? true }) };
    });

  const unknown = project.spec.filter((s) => s.confidence === 0).length;
  const total = project.spec.reduce((s, i) => s + i.qty, 0);

  return (
    <div className="stack">
      <p className="muted">
        Загрузите Excel или CSV, либо вставьте строки из Excel. Колонки: наименование, количество, мощность, помещение
        (необязательно).
      </p>
      <div className="row">
        <label className="btn">
          Файл…
          <input id="spec-file" type="file" accept=".xlsx,.xls,.ods,.csv,.txt" hidden onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
        </label>
        <button className="btn ghost" onClick={() => setText(DEMO_SPEC_TEXT)}>
          Пример
        </button>
      </div>
      <textarea
        id="spec-text"
        rows={4}
        placeholder={'Розетка двойная\t12\nВарочная панель\t1\t7,0\tКухня'}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {text.trim() && (
        <button className="btn" onClick={() => { setSpec(parseSpecRows(splitText(text))); setText(''); }}>
          Распознать вставленное
        </button>
      )}
      {error && <p className="bad">{error}</p>}

      {project.spec.length > 0 && (
        <>
          <div className="spec-head">
            <strong>{project.spec.length} позиций, {total} шт.</strong>
            {unknown > 0 && <span className="bad"> · не распознано: {unknown}</span>}
          </div>
          <div className="spec-list">
            {project.spec.map((s) => {
              const rooms = matchRooms(s.roomHint, project.rooms);
              return (
                <div key={s.id} className={`spec-item${s.confidence === 0 ? ' unknown' : ''}`}>
                  <div className="spec-name" title={s.name}>{s.name}</div>
                  <div className="spec-fields">
                    <select id={`t-${s.id}`} value={s.typeKey} onChange={(e) => edit(s.id, { typeKey: e.target.value as DeviceTypeKey, confidence: 1 })}>
                      {Object.values(DEVICE_TYPES).map((t) => (
                        <option key={t.key} value={t.key}>{t.label}</option>
                      ))}
                    </select>
                    <input id={`q-${s.id}`} type="number" min={1} value={s.qty} title="Количество" onChange={(e) => edit(s.id, { qty: Math.max(1, +e.target.value || 1) })} />
                    <span className="unit">шт</span>
                    <input id={`p-${s.id}`} type="number" step={0.1} min={0} value={s.powerW / 1000} title="Мощность одной единицы, кВт" onChange={(e) => edit(s.id, { powerW: Math.round((+e.target.value || 0) * 1000) })} />
                    <span className="unit">кВт</span>
                  </div>
                  <div className="spec-room">
                    <select id={`r-${s.id}`} value={rooms[0]?.name ?? ''} onChange={(e) => edit(s.id, { roomHint: e.target.value })}>
                      <option value="">Помещение: авто</option>
                      {project.rooms.map((r) => (
                        <option key={r.id} value={r.name}>{r.name}</option>
                      ))}
                    </select>
                    <span className="muted small">{fmt((s.powerW * s.qty) / 1000, 2)} кВт всего</span>
                  </div>
                </div>
              );
            })}
          </div>
          <button className="btn primary" onClick={place} disabled={project.rooms.length === 0}>
            Разложить по плану
          </button>
          {project.rooms.length === 0 && <p className="muted small">Сначала задайте помещения на вкладке «План».</p>}
          <p className="muted small">Раскладка заменит все точки на плане. Ручные перемещения будут потеряны.</p>
        </>
      )}
    </div>
  );
}
