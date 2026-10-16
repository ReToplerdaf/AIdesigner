import { area } from '../engine/geometry';
import { DEVICE_TYPES, ROOM_TYPES } from '../engine/norms';
import { roomTypeFromText } from '../engine/classify';
import type { Project, RoomType } from '../engine/types';
import { DRAG_MIME, fmt, type Selection, type Tool, type Update } from './state';

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
        <p className="muted small">PNG или JPG плана. PDF пока сохраните как картинку.</p>
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
        <h3>Инструмент</h3>
        <div className="seg">
          <button className={tool === 'select' ? 'on' : ''} onClick={() => setTool('select')}>Выбор</button>
          <button className={tool === 'calibrate' ? 'on' : ''} onClick={() => setTool('calibrate')}>Масштаб</button>
          <button className={tool === 'room' ? 'on' : ''} onClick={() => setTool('room')}>Помещение</button>
        </div>
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
        {project.rooms.length === 0 && <p className="muted small">Выберите «Помещение» и обведите комнаты на плане.</p>}
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
