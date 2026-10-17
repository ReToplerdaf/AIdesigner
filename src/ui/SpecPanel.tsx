import { useEffect, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { parseSpecRows, splitText } from '../engine/classify';
import { DEVICE_TYPES } from '../engine/norms';
import { pruneUnusedHoles } from '../engine/calc';
import { autoPlace, roomAt, specRooms, withPassageSpec } from '../engine/placement';
import { generateSpec, type PresetTable } from '../engine/presets';
import { pointOnPerimeter } from '../engine/geometry';
import type { DeviceTypeKey, SpecItem } from '../engine/types';
import { DEMO_SPEC_TEXT } from '../data/demo';
import { DRAG_MIME, fmt, loadPresets, savePresets, type Selection, type Update } from './state';
import { PresetsEditor } from './PresetsEditor';
import type { Project } from '../engine/types';

interface Props {
  project: Project;
  update: Update;
  selection: Selection;
  setSelection: (s: Selection) => void;
}

export function SpecPanel({ project, update, selection, setSelection }: Props) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [presets, setPresetsState] = useState<PresetTable>(loadPresets);
  const [editingPresets, setEditingPresets] = useState(false);
  const setPresets = (t: PresetTable) => {
    setPresetsState(t);
    savePresets(t);
  };

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

  /** Раскладка спецификации по плану: заменяет все точки. */
  const withPlacement = (p: Project): Project => {
    // Если щит стоит вне помещений, ставим его в прихожую (или в первое помещение) у стены.
    let panel = p.panel;
    if (p.rooms.length && !roomAt(panel, p.rooms)) {
      const r = p.rooms.find((x) => x.type === 'hall') ?? p.rooms[0];
      panel = pointOnPerimeter(r.poly, 0.02, 300);
    }
    const all = autoPlace(p.spec, p.rooms, panel, { autoSwitches: p.settings.autoSwitches ?? true });
    const { devices } = pruneUnusedHoles({ ...p, panel, devices: all });
    return { ...p, panel, devices, spec: withPassageSpec(p.spec, devices) };
  };
  const place = () => update(withPlacement);

  const generate = () => {
    if (project.spec.length && !confirm('Заменить текущую спецификацию и точки на плане позициями из типовых наборов?')) return;
    update((p) => withPlacement({ ...p, spec: generateSpec(p.rooms, presets) }));
  };
  const untyped = project.rooms.filter((r) => r.type === 'other').length;

  // Прибор, выбранный на плане: его позиция поднимается наверх списка, внизу плашки — удаление точки.
  const picked = selection?.kind === 'device' ? project.devices.find((d) => d.id === selection.id) : undefined;
  const pickedSpec = picked ? project.spec.find((s) => s.id === picked.specId) : undefined;
  const ordered = pickedSpec ? [pickedSpec, ...project.spec.filter((s) => s !== pickedSpec)] : project.spec;
  const topRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (picked) topRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [picked?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const removePicked = () => {
    if (!picked) return;
    update((p) => ({ ...p, devices: p.devices.filter((d) => d.id !== picked.id) }));
    setSelection(null);
  };
  const pickedFooter = picked && (
    <div className="spec-picked">
      <span className="small">
        Выбрана точка: {project.rooms.find((r) => r.id === picked.roomId)?.name ?? 'вне помещений'}
      </span>
      <button id="remove-point" className="btn small danger" onClick={removePicked}>
        Удалить с плана
      </button>
    </div>
  );

  const unknown = project.spec.filter((s) => s.confidence === 0).length;
  const holes = project.devices.filter((d) => d.typeKey === 'passage').length;
  const total = project.spec.reduce((s, i) => s + (i.typeKey === 'passage' ? holes : i.qty), 0);

  if (editingPresets) {
    return <PresetsEditor table={presets} setTable={setPresets} project={project} onClose={() => setEditingPresets(false)} />;
  }

  return (
    <div className="stack">
      <div className="gen-box">
        <strong>Нет спецификации?</strong>
        <p className="muted small">
          Составим её по помещениям на плане: каждое получит типовой набор своего типа (свет, выключатель, розетки, техника) и сразу разложится.
        </p>
        <div className="row">
          <button id="gen-spec" className="btn primary" onClick={generate} disabled={project.rooms.length === 0}>
            Сгенерировать по помещениям
          </button>
          <button id="edit-presets" className="btn" onClick={() => setEditingPresets(true)}>
            Типовые наборы…
          </button>
        </div>
        {project.rooms.length === 0 && <p className="muted small">Сначала задайте помещения на вкладке «План».</p>}
        {untyped > 0 && (
          <p className="small bad">Помещений с типом «Прочее»: {untyped}. Укажите тип на вкладке «План», иначе они получат общий набор.</p>
        )}
      </div>
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
          <div className="spec-list" ref={topRef}>
            {picked && !pickedSpec && (
              <div className="spec-item sel">
                <div className="spec-name">{picked.label}</div>
                <p className="muted small">
                  {DEVICE_TYPES[picked.typeKey].label}, {fmt(picked.powerW / 1000, 2)} кВт · не из спецификации
                </p>
                {pickedFooter}
              </div>
            )}
            {ordered.map((s) => {
              const rooms = specRooms(s, project.rooms);
              const isHole = s.typeKey === 'passage';
              const placed = isHole
                ? project.devices.filter((d) => d.typeKey === 'passage').length
                : project.devices.filter((d) => d.specId === s.id).length;
              return (
                <div key={s.id} className={`spec-item${s.confidence === 0 ? ' unknown' : ''}${s === pickedSpec ? ' sel' : ''}`}>
                  <div
                    className="spec-name drag"
                    draggable
                    title={`${s.name}. Перетащите на план, чтобы добавить точку`}
                    onDragStart={(e) => {
                      e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ specId: s.id }));
                      e.dataTransfer.effectAllowed = 'copy';
                    }}
                  >
                    <span className="grip">⠿</span> {s.name}
                  </div>
                  <div className="spec-fields">
                    <select id={`t-${s.id}`} value={s.typeKey} onChange={(e) => edit(s.id, { typeKey: e.target.value as DeviceTypeKey, confidence: 1 })}>
                      {Object.values(DEVICE_TYPES).map((t) => (
                        <option key={t.key} value={t.key}>{t.label}</option>
                      ))}
                    </select>
                    <input id={`q-${s.id}`} type="number" min={1} value={isHole ? placed : s.qty} disabled={isHole} title={isHole ? 'Столько отверстий стоит на плане' : 'Количество'} onChange={(e) => edit(s.id, { qty: Math.max(1, +e.target.value || 1) })} />
                    <span className="unit">шт</span>
                    <input id={`p-${s.id}`} type="number" step={0.1} min={0} value={s.powerW / 1000} title="Мощность одной единицы, кВт" onChange={(e) => edit(s.id, { powerW: Math.round((+e.target.value || 0) * 1000) })} />
                    <span className="unit">кВт</span>
                  </div>
                  <div className="spec-room">
                    <select id={`r-${s.id}`} value={rooms[0]?.id ?? ''} onChange={(e) => edit(s.id, { roomHint: project.rooms.find((r) => r.id === e.target.value)?.name ?? '', roomId: e.target.value || undefined })}>
                      <option value="">Помещение: авто</option>
                      {project.rooms.map((r) => (
                        <option key={r.id} value={r.id}>{r.name}</option>
                      ))}
                    </select>
                    <span className="muted small">
                      {isHole ? (
                        'без нагрузки, в расчёт не входит'
                      ) : (
                        <>
                          {fmt((s.powerW * s.qty) / 1000, 2)} кВт · <span className={`placed${placed >= s.qty ? ' full' : ''}`}>на плане {placed} из {s.qty}</span>
                        </>
                      )}
                    </span>
                  </div>
                  {s === pickedSpec && pickedFooter}
                </div>
              );
            })}
          </div>
          <button className="btn primary" onClick={place} disabled={project.rooms.length === 0}>
            Разложить по плану
          </button>
          {project.rooms.length === 0 && <p className="muted small">Сначала задайте помещения на вкладке «План».</p>}
          <p className="muted small">Раскладка заменит все точки на плане. Ручные перемещения будут потеряны. Отдельные точки можно добавить, перетащив позицию за название на план.</p>
        </>
      )}
    </div>
  );
}
