import { useState } from 'react';
import { area } from '../engine/geometry';
import { detectRooms, newRooms, type DetectStage } from '../engine/roomDetect';
import { DEVICE_TYPES, ROOM_TYPES } from '../engine/norms';
import { roomTypeFromText } from '../engine/classify';
import type { Project, RoomType } from '../engine/types';
import { loadOpenCV, rasterOf } from './opencv';
import { DRAG_MIME, fmt, type Selection, type Tool, type Update } from './state';

type Status = { kind: 'busy' | 'done' | 'error'; pct: number; text: string };

const TOOL_NAMES: Record<Tool, string> = {
  select: 'выбор',
  calibrate: 'масштаб',
  room: 'помещение',
  poly: 'многоугольник',
  stretch: 'растянуть',
};

const STAGES: Record<DetectStage, [number, string]> = {
  walls: [80, 'Ищу стены…'],
  gaps: [88, 'Закрываю проёмы дверей и окон…'],
  rooms: [94, 'Ищу помещения…'],
};

/** Даёт браузеру перерисовать строку состояния перед тяжёлым шагом. */
const frame = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));

interface Props {
  project: Project;
  update: Update;
  tool: Tool;
  setTool: (t: Tool) => void;
  selection: Selection;
  setSelection: (s: Selection) => void;
  pendingCalibration: number | null;
  applyCalibration: (realMm: number) => void;
  cancelCalibration: () => void;
}

export function PlanPanel(props: Props) {
  const { project, update, tool, setTool, selection } = props;
  const [status, setStatus] = useState<Status | null>(null);
  const busy = status?.kind === 'busy';

  const analyze = async () => {
    const image = project.image;
    if (!image) return;
    const step = (pct: number, text: string) => setStatus({ kind: 'busy', pct, text });
    step(2, 'Загружаю библиотеку OpenCV…');
    try {
      const { cv } = await loadOpenCV((f) =>
        f == null ? step(70, 'Запускаю OpenCV…') : step(2 + f * 66, `Загружаю библиотеку OpenCV… ${Math.round(f * 100)}%`),
      );
      step(74, 'Готовлю изображение…');
      await frame();
      const raster = await rasterOf(image);
      const res = await detectRooms(cv, raster, {
        onStage: async (st) => {
          step(...STAGES[st]);
          await frame();
        },
      });
      const fresh = newRooms(res.rooms, project.rooms.map((r) => r.poly));
      const stamp = Date.now().toString(36);
      update((p) => ({
        ...p,
        rooms: [
          ...p.rooms,
          ...fresh.map((r, i) => ({ id: `r${stamp}${i}`, name: `Помещение ${p.rooms.length + i + 1}`, type: 'other' as RoomType, poly: r.poly })),
        ],
      }));
      const skipped = res.rooms.length - fresh.length;
      setStatus({
        kind: 'done',
        pct: 100,
        text:
          res.rooms.length === 0
            ? 'Помещения не найдены. Проверьте масштаб или обведите комнаты вручную.'
            : `Найдено помещений: ${res.rooms.length}, добавлено: ${fresh.length}${skipped ? ` (${skipped} уже были на плане)` : ''}. ` +
              'Задайте названия ниже, контуры правьте инструментом «Растянуть».',
      });
    } catch (e) {
      setStatus({ kind: 'error', pct: 100, text: `Не получилось: ${(e as Error).message}` });
    }
  };

  const onImage = (f: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        // Предварительный масштаб: ширина картинки ≈ 12 м. Точный задаётся калибровкой.
        const mmPerPx = 12000 / img.naturalWidth;
        update((p) => ({
          ...p,
          image: { dataUrl: String(reader.result), widthPx: img.naturalWidth, heightPx: img.naturalHeight, mmPerPx },
        }));
        setTool('calibrate');
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(f);
  };

  const setRoom = (id: string, patch: { name?: string; type?: RoomType }) =>
    update((p) => ({ ...p, rooms: p.rooms.map((r) => (r.id === id ? { ...r, ...patch } : r)) }));

  const removeRoom = (id: string) =>
    update((p) => ({
      ...p,
      rooms: p.rooms.filter((r) => r.id !== id),
      devices: p.devices.map((d) => (d.roomId === id ? { ...d, roomId: null } : d)),
    }));

  return (
    <div className="stack">
      <section className="stack-s">
        <h3>Подложка</h3>
        <p className="muted small">PNG или JPG плана, скан тоже подойдёт. PDF пока сохраните как картинку.</p>
        <div className="row">
          <label className="btn">
            {project.image ? 'Заменить план…' : 'Загрузить план…'}
            <input id="plan-file" type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && onImage(e.target.files[0])} />
          </label>
          {project.image && (
            <button className="btn ghost" onClick={() => update((p) => ({ ...p, image: null }))}>
              Убрать
            </button>
          )}
        </div>
      </section>

      <section className="stack-s">
        <h3>Распознавание помещений</h3>
        <p className="muted small">
          Находит комнаты по стенам на подложке. Сначала задайте масштаб: по нему отличаются стены от линий мебели и проёмы от комнат.
        </p>
        <button id="plan-analyze" className="btn primary small" disabled={!project.image || busy} onClick={analyze}>
          Анализ
        </button>
        {status && (
          <div className={`status-line ${status.kind}`} role="status">
            <div className="bar">
              <span style={{ width: `${status.pct}%` }} />
            </div>
            <span>{status.text}</span>
          </div>
        )}
      </section>

      {(tool !== 'select' || props.pendingCalibration != null) && (
        <section className="stack-s">
          <h3>Инструмент: {TOOL_NAMES[tool]}</h3>
          {tool === 'room' && <p className="muted small">Растяните на плане прямоугольник помещения. Esc — вернуться к выбору.</p>}
          {tool === 'poly' && (
            <p className="muted small">
              Кликайте по углам комнаты. Замкнуть — клик по первой точке, двойной клик или Enter. Backspace — убрать последнюю точку.
              Стороны около 0° и 90° выпрямляются сами, Shift отключает выпрямление.
            </p>
          )}
          {tool === 'stretch' && (
            <p className="muted small">
              Кликните помещение. Угол тяните, чтобы растянуть комнату в две стороны, стену — чтобы сдвинуть её. Двойной клик по углу
              удаляет его, по стене — добавляет угол.
            </p>
          )}
          {tool === 'calibrate' && props.pendingCalibration == null && (
            <p className="muted small">Кликните на плане две точки отрезка, длина которого известна. Esc — отмена.</p>
          )}
          {props.pendingCalibration != null && (
            <form
              className="calib"
              onSubmit={(e) => {
                e.preventDefault();
                const v = +(new FormData(e.currentTarget).get('len') as string);
                if (v > 0) props.applyCalibration(v);
              }}
            >
              <span>Отрезок сейчас {fmt(props.pendingCalibration, 0)} мм. Реальная длина:</span>
              <div className="row">
                <input id="calib-len" name="len" type="number" min={1} autoFocus placeholder="мм" />
                <button className="btn primary" type="submit">Применить</button>
                <button className="btn ghost" type="button" onClick={props.cancelCalibration}>Отмена</button>
              </div>
            </form>
          )}
        </section>
      )}

      <section className="stack-s">
        <h3>Добавить на план</h3>
        <p className="muted small">Перетащите прибор на план. Позиции из спецификации можно тянуть со вкладки «Спецификация».</p>
        <div className="palette">
          {Object.values(DEVICE_TYPES).map((t) => (
            <span
              key={t.key}
              className="chip"
              draggable
              title={`${t.label}, ${fmt(t.defaultPowerW / 1000, 2)} кВт`}
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ typeKey: t.key }));
                e.dataTransfer.effectAllowed = 'copy';
              }}
            >
              <b>{t.glyph}</b> {t.label}
            </span>
          ))}
        </div>
      </section>

      <section className="stack-s">
        <h3>Помещения ({project.rooms.length})</h3>
        {project.rooms.length === 0 && <p className="muted small">Выберите инструмент «Помещение» в левом верхнем углу плана и обведите комнаты.</p>}
        <div className="rooms">
          {project.rooms.map((r) => (
            <div
              key={r.id}
              className={`room-row${selection?.kind === 'room' && selection.id === r.id ? ' sel' : ''}`}
              onClick={() => props.setSelection({ kind: 'room', id: r.id })}
            >
              <input
                id={`rn-${r.id}`}
                value={r.name}
                onChange={(e) => {
                  const t = roomTypeFromText(e.target.value);
                  setRoom(r.id, t ? { name: e.target.value, type: t } : { name: e.target.value });
                }}
              />
              <select id={`rt-${r.id}`} value={r.type} onChange={(e) => setRoom(r.id, { type: e.target.value as RoomType })}>
                {Object.entries(ROOM_TYPES).map(([k, v]) => (
                  <option key={k} value={k}>{v.label}</option>
                ))}
              </select>
              <span className="muted small num">{fmt(area(r.poly) / 1e6)} м²</span>
              <button className="icon" title="Удалить помещение" onClick={(e) => { e.stopPropagation(); removeRoom(r.id); }}>×</button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
