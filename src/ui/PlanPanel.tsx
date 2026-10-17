import { useEffect, useState } from 'react';
import { area } from '../engine/geometry';
import { detectOutline, detectRooms, fitToAreas, newRooms, type DetectStage } from '../engine/roomDetect';
import { rect } from '../engine/geometry';
import { readLabel, unionBox } from '../engine/roomLabels';
import { DEVICE_TYPES, ROOM_TYPES } from '../engine/norms';
import { roomTypeFromText } from '../engine/classify';
import type { Box, Project, Room, RoomType } from '../engine/types';
import { loadOpenCV, rasterOf } from './opencv';
import { loadOcr, ocrBox } from './ocr';
import { planUi, usePlanUi } from './planUi';
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

const WAND = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <path d="M4 20L15 9M13 7l4 4M18 2v3M21.5 5.5h-3M19.5 3.5l-1.5 1.5M9 3v2M8 4h2M20 13v2M19 14h2" />
  </svg>
);

const bboxOf = (poly: { x: number; y: number }[]): Box => unionBox(poly.map((p) => ({ x: p.x, y: p.y, w: 0, h: 0 })));

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

  const ui = usePlanUi();
  const step = (pct: number, text: string) => setStatus({ kind: 'busy', pct, text });

  /** OpenCV и пиксели подложки: общая подготовка обоих шагов анализа. */
  const prepare = async (image: NonNullable<Project['image']>) => {
    step(2, 'Загружаю библиотеку OpenCV…');
    const { cv } = await loadOpenCV((f) =>
      f == null ? step(70, 'Запускаю OpenCV…') : step(2 + f * 66, `Загружаю библиотеку OpenCV… ${Math.round(f * 100)}%`),
    );
    step(74, 'Готовлю изображение…');
    await frame();
    return { cv, raster: await rasterOf(image) };
  };

  /**
   * Шаг 1 из 2: граница дома. Найденная (или прежняя, если уже правили) граница показывается на плане,
   * пользователь двигает её углы и стены и подтверждает.
   */
  const findOutline = async (fresh: boolean) => {
    const image = project.image;
    if (!image) return;
    try {
      let outline = fresh ? undefined : project.outline;
      if (!outline) {
        const { cv, raster } = await prepare(image);
        step(85, 'Ищу границу дома…');
        await frame();
        outline = (await detectOutline(cv, raster)) ?? undefined;
      }
      // Не нашлась — предлагаем рамку по краю картинки, её легко подтянуть к стенам.
      const W = image.widthPx * image.mmPerPx;
      const H = image.heightPx * image.mmPerPx;
      const found = !!outline;
      const o = outline ?? rect(W * 0.05, H * 0.05, W * 0.95, H * 0.95).map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
      update((p) => ({ ...p, outline: o }));
      setTool('select');
      props.setSelection(null);
      planUi.set({ outlineEdit: true });
      setStatus({
        kind: 'done',
        pct: 100,
        text: found
          ? 'Шаг 1 из 2. Синяя линия — граница дома. Проверьте её: углы и стены можно тянуть, двойной клик по стене добавляет угол, «×» у выбранного угла убирает его.'
          : 'Шаг 1 из 2. Границу дома найти не удалось, поставил рамку по краю плана. Подтяните её углы и стены к наружным стенам.',
      });
    } catch (e) {
      setStatus({ kind: 'error', pct: 100, text: `Не получилось: ${(e as Error).message}` });
    }
  };

  const cancelOutline = () => {
    planUi.set({ outlineEdit: false });
    setStatus(null);
  };

  /** Шаг 2 из 2: помещения внутри подтверждённой границы и их подписи. */
  const analyze = async () => {
    const image = project.image;
    if (!image) return;
    planUi.set({ outlineEdit: false });
    try {
      const { cv, raster } = await prepare(image);
      const res = await detectRooms(cv, raster, {
        boundary: project.outline,
        onStage: async (st) => {
          step(...STAGES[st]);
          await frame();
        },
      });
      const fresh = newRooms(res.rooms, project.rooms.map((r) => r.poly));
      const stamp = Date.now().toString(36);
      const made: Room[] = fresh.map((r, i) => ({ id: `r${stamp}${i}`, name: '', type: 'other', poly: r.poly }));

      // Подписи: каждая комната читается отдельно, внутри своего контура, — так не мешают соседи и стены.
      let ocrNote = '';
      if (made.length) {
        try {
          const worker = await loadOcr((f) => step(95 + f * 2, `Загружаю распознавание текста… ${Math.round(f * 100)}%`));
          for (let i = 0; i < made.length; i++) {
            step(97 + (3 * i) / made.length, `Читаю подписи… ${i + 1} из ${made.length}`);
            const r = made[i];
            const l = readLabel(await ocrBox(worker, image, bboxOf(r.poly), 11, r.poly));
            if (l.name) Object.assign(r, { name: l.name.text, type: l.name.type, nameSrc: l.name.box });
            if (l.area) Object.assign(r, { planAreaM2: l.area.m2, areaSrc: l.area.box });
          }
        } catch (e) {
          ocrNote = ` Подписи прочитать не удалось: ${(e as Error).message}.`;
        }
      }
      // Площадь с подписи — проверка: где контур с ней расходится, план распознаётся заново с другой очисткой линий
      // и проёмов, и берётся вариант, площадь которого ближе к подписи.
      let fitted = 0;
      const targets = made
        .map((r, i) => ({ r, i }))
        .filter(({ r }) => r.planAreaM2 && r.areaSrc && Math.abs(area(r.poly) / 1e6 - r.planAreaM2) / r.planAreaM2 > 0.02);
      if (targets.length) {
        const others = [
          ...fresh.map((f) => f.inside),
          ...project.rooms.map((r) => bboxOf(r.poly)).map((b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 })),
        ];
        const res2 = await fitToAreas(
          cv,
          raster,
          { boundary: project.outline },
          targets.map(({ r }) => ({ inside: { x: r.areaSrc!.x + r.areaSrc!.w / 2, y: r.areaSrc!.y + r.areaSrc!.h / 2 }, m2: r.planAreaM2!, poly: r.poly })),
          others,
          0.02,
          async (v, n) => {
            step(99, `Сверяю площади с подписями… вариант ${v + 1} из ${n}`);
            await frame();
          },
        );
        res2.forEach((poly, k) => {
          if (!poly) return;
          // Соседние комнаты новый контур не захватывает: такие варианты fitToAreas отбрасывает.
          targets[k].r.poly = poly;
          fitted++;
        });
      }
      const named = made.filter((r) => r.name).length;
      update((p) => ({
        ...p,
        rooms: [...p.rooms, ...made.map((r, i) => (r.name ? r : { ...r, name: `Помещение ${p.rooms.length + i + 1}` }))],
      }));
      const skipped = res.rooms.length - fresh.length;
      setStatus({
        kind: 'done',
        pct: 100,
        text:
          res.rooms.length === 0
            ? 'Помещения не найдены. Проверьте масштаб или обведите комнаты вручную.'
            : `Найдено помещений: ${res.rooms.length}, добавлено: ${fresh.length}${skipped ? ` (${skipped} уже были на плане)` : ''}. ` +
              `Названия прочитаны у ${named} из ${fresh.length}.${fitted ? ` По площади с подписи уточнено контуров: ${fitted}.` : ''}${ocrNote} Проверьте их ниже, контуры правьте инструментом «Растянуть».`,
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

  const setRoom = (id: string, patch: Partial<Omit<Room, 'id' | 'poly'>>) =>
    update((p) => ({ ...p, rooms: p.rooms.map((r) => (r.id === id ? { ...r, ...patch } : r)) }));

  const [pickStatus, setPickStatus] = useState<Status | null>(null);
  const pickBusy = pickStatus?.kind === 'busy';

  /** Палочка: обвести на плане подпись — распознаётся только она. */
  const startPick = (room: Room, field: 'name' | 'area') => {
    const image = project.image;
    if (!image) return;
    setPickStatus({ kind: 'busy', pct: 0, text: `Обведите на плане ${field === 'name' ? 'название' : 'площадь'} помещения «${room.name}». Esc — отмена.` });
    planUi.set({
      highlight: null,
      pick: {
        roomId: room.id,
        field,
        onPick: async (box) => {
          planUi.set({ pick: null, highlight: box });
          setPickStatus({ kind: 'busy', pct: 10, text: 'Загружаю распознавание текста…' });
          try {
            const worker = await loadOcr((f) => setPickStatus({ kind: 'busy', pct: 10 + f * 70, text: `Загружаю распознавание текста… ${Math.round(f * 100)}%` }));
            setPickStatus({ kind: 'busy', pct: 85, text: 'Читаю подпись…' });
            const words = await ocrBox(worker, image, box, 6);
            // Подпись обведена вручную — верим и неуверенно прочитанному.
            const l = readLabel(words, 0);
            if (field === 'name') {
              // Обвели именно подпись, поэтому берём весь текст, даже если слова нет в словаре.
              const raw = words.filter((w) => /[а-яё]/i.test(w.text)).map((w) => w.text.trim()).join(' ');
              const name = l.name?.text ?? raw;
              if (!name) throw new Error('текст не найден');
              setRoom(room.id, { name, nameSrc: box, ...(l.name && l.name.type !== 'other' ? { type: l.name.type } : {}) });
              setPickStatus({ kind: 'done', pct: 100, text: `Название: «${name}».` });
            } else {
              if (!l.area) throw new Error(`площадь не найдена${words.length ? ` (прочитано: «${words.map((w) => w.text).join(' ')}»)` : ''}`);
              setRoom(room.id, { planAreaM2: l.area.m2, areaSrc: box });
              setPickStatus({ kind: 'done', pct: 100, text: `Площадь по плану: ${fmt(l.area.m2)} м².` });
            }
          } catch (e) {
            setPickStatus({ kind: 'error', pct: 100, text: `Не удалось прочитать: ${(e as Error).message}. Обведите подпись плотнее.` });
          }
        },
      },
    });
  };

  // Палочку отменили (Esc на плане) — убираем и подсказку.
  useEffect(
    () =>
      planUi.subscribe(() => {
        if (!planUi.get().pick) setPickStatus((st) => (st?.kind === 'busy' && st.pct === 0 ? null : st));
      }),
    [],
  );

  const focusSrc = (room: Room, src: Box | undefined) => {
    props.setSelection({ kind: 'room', id: room.id });
    planUi.set({ highlight: src ?? null });
  };

  const removeAll = () => {
    if (!confirm(`Удалить все помещения (${project.rooms.length})? Приборы останутся на плане.`)) return;
    update((p) => ({ ...p, rooms: [], devices: p.devices.map((d) => ({ ...d, roomId: null })) }));
    props.setSelection(null);
  };

  // Выбранное помещение (кликом на плане) прокручивается в списке.
  useEffect(() => {
    if (selection?.kind !== 'room') return;
    document.getElementById(`room-${selection.id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selection]);

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
        {!ui.outlineEdit ? (
          <button id="plan-analyze" className="btn primary small" disabled={!project.image || busy} onClick={() => findOutline(false)}>
            Анализ
          </button>
        ) : (
          <div className="row">
            <button id="outline-ok" className="btn primary small" onClick={analyze}>
              Граница верна, искать помещения
            </button>
            <button className="btn ghost small" onClick={() => findOutline(true)}>
              Найти заново
            </button>
            <button className="btn ghost small" onClick={cancelOutline}>
              Отмена
            </button>
          </div>
        )}
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
              Кликните помещение. Угол тяните, чтобы растянуть комнату в две стороны, стену — чтобы сдвинуть её. Двойной клик по стене
              добавляет угол. Чтобы убрать угол, нажмите на него и затем на красный «×» рядом (или Delete, или правый клик).
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
        <div className="row between">
          <h3>Помещения ({project.rooms.length})</h3>
          {project.rooms.length > 0 && (
            <button id="rooms-clear" className="btn ghost small" onClick={removeAll}>
              Удалить все
            </button>
          )}
        </div>
        {project.rooms.length === 0 && <p className="muted small">Выберите инструмент «Помещение» в левом верхнем углу плана и обведите комнаты.</p>}
        {pickStatus && (
          <div className={`status-line ${pickStatus.kind}${pickStatus.pct === 0 ? ' hint' : ''}`} role="status">
            <div className="bar">
              <span style={{ width: `${pickStatus.pct}%` }} />
            </div>
            <span>{pickStatus.text}</span>
          </div>
        )}
        <div className="rooms">
          {project.rooms.map((r) => {
            const calcM2 = area(r.poly) / 1e6;
            const off = r.planAreaM2 ? Math.abs(calcM2 - r.planAreaM2) / r.planAreaM2 : 0;
            return (
              <div
                key={r.id}
                id={`room-${r.id}`}
                className={`room-row${selection?.kind === 'room' && selection.id === r.id ? ' sel' : ''}`}
                onClick={() => props.setSelection({ kind: 'room', id: r.id })}
              >
                <input
                  id={`rn-${r.id}`}
                  value={r.name}
                  onFocus={() => focusSrc(r, r.nameSrc)}
                  onBlur={() => planUi.set({ highlight: null })}
                  onChange={(e) => {
                    const t = roomTypeFromText(e.target.value);
                    setRoom(r.id, t ? { name: e.target.value, type: t } : { name: e.target.value });
                  }}
                />
                <button
                  className="icon wand"
                  title="Прочитать название с плана: нажмите и обведите подпись"
                  disabled={!project.image || pickBusy}
                  onClick={(e) => { e.stopPropagation(); startPick(r, 'name'); }}
                >
                  {WAND}
                </button>
                <select id={`rt-${r.id}`} value={r.type} onChange={(e) => setRoom(r.id, { type: e.target.value as RoomType })}>
                  {Object.entries(ROOM_TYPES).map(([k, v]) => (
                    <option key={k} value={k}>{v.label}</option>
                  ))}
                </select>
                <button className="icon" title="Удалить помещение" onClick={(e) => { e.stopPropagation(); removeRoom(r.id); }}>×</button>
                <div className="room-sub muted small">
                  <span className="num">{fmt(calcM2)} м² по контуру</span>
                  <span>·</span>
                  <label
                    className={off > 0.05 ? 'warn' : undefined}
                    title={off > 0.05 ? `Отличается от площади по контуру на ${Math.round(off * 100)}%: проверьте масштаб или контур` : 'Площадь, подписанная на плане'}
                  >
                    по плану
                    <input
                      id={`ra-${r.id}`}
                      type="number"
                      min={0}
                      step={0.1}
                      value={r.planAreaM2 ?? ''}
                      onFocus={() => focusSrc(r, r.areaSrc)}
                      onBlur={() => planUi.set({ highlight: null })}
                      onChange={(e) => setRoom(r.id, { planAreaM2: e.target.value === '' ? undefined : +e.target.value })}
                    />
                    м²
                  </label>
                  <button
                    className="icon wand"
                    title="Прочитать площадь с плана: нажмите и обведите подпись"
                    disabled={!project.image || pickBusy}
                    onClick={(e) => { e.stopPropagation(); startPick(r, 'area'); }}
                  >
                    {WAND}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
