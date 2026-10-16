import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { area, bbox, centroid, rect } from '../engine/geometry';
import { DEVICE_TYPES } from '../engine/norms';
import { roomAt } from '../engine/placement';
import type { Device, DeviceKind, DeviceTypeKey, Project, ProjectCalc, Pt, Room } from '../engine/types';
import { DRAG_MIME, fmt, groupColor, type DragPayload, type Selection, type Tool, type Update } from './state';

interface Props {
  project: Project;
  calc: ProjectCalc;
  update: Update;
  selection: Selection;
  setSelection: (s: Selection) => void;
  tool: Tool;
  onCalibrate: (a: Pt, b: Pt) => void;
  onRoomDrawn: (poly: Pt[]) => void;
  fitSignal: number;
}

type View = { x: number; y: number; w: number; h: number };

type Drag =
  | { kind: 'device'; id: string; dx: number; dy: number }
  | { kind: 'panel'; dx: number; dy: number }
  | { kind: 'box'; key: string; dx: number; dy: number }
  | { kind: 'pan'; start: Pt; view: View; inv: DOMMatrix }
  | { kind: 'room'; start: Pt }
  | null;

const R = 140;
let dropSeq = 0;

/** Слой плана: всё сразу, только освещение (светильники и выключатели) или только силовая часть. */
type Layer = 'all' | 'light' | 'power';
const LAYERS: { key: Layer; label: string }[] = [
  { key: 'all', label: 'Все' },
  { key: 'light', label: 'Освещение' },
  { key: 'power', label: 'Розетки и линии' },
];
const MUTED = '#c4cad0';
const layerOf = (kind: DeviceKind): Layer => (kind === 'light' ? 'light' : 'power');
const ROOM_FILL: Record<Room['type'], string> = {
  kitchen: '#fff4e6',
  living: '#f1f3f5',
  bedroom: '#f3f0ff',
  bath: '#e7f5ff',
  wc: '#e3fafc',
  hall: '#f8f9fa',
  balcony: '#ebfbee',
  other: '#f8f9fa',
};

function fitView(p: Project): View {
  const pts: Pt[] = [...p.rooms.flatMap((r) => r.poly), ...p.devices.map((d) => d.pos), p.panel];
  if (p.image) {
    pts.push({ x: 0, y: 0 }, { x: p.image.widthPx * p.image.mmPerPx, y: p.image.heightPx * p.image.mmPerPx });
  }
  if (pts.length < 2) return { x: -1000, y: -1000, w: 12000, h: 8000 };
  const b = bbox(pts);
  const pad = 800;
  return { x: b.minX - pad, y: b.minY - pad, w: b.maxX - b.minX + 2 * pad, h: b.maxY - b.minY + 2 * pad };
}

export function PlanEditor(props: Props) {
  const { project, calc, update, selection, setSelection, tool } = props;
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState<View>(() => fitView(project));
  const [drag, setDrag] = useState<Drag>(null);
  const [preview, setPreview] = useState<Pt[] | null>(null);
  const [calPts, setCalPts] = useState<Pt[]>([]);
  const [dropping, setDropping] = useState(false);
  const [layer, setLayer] = useState<Layer>(() => {
    try {
      return (localStorage.getItem('aid-layer') as Layer) || 'all';
    } catch {
      return 'all';
    }
  });
  const chooseLayer = (l: Layer) => {
    setLayer(l);
    try {
      localStorage.setItem('aid-layer', l);
    } catch {
      /* без сохранения */
    }
  };
  /** Объект чужого слоя рисуется серым, под активным, и не реагирует на мышь. */
  const muted = (kind: DeviceKind) => layer !== 'all' && layerOf(kind) !== layer;
  const byLayer = <T,>(items: T[], kindOf: (t: T) => DeviceKind) => [
    ...items.filter((t) => muted(kindOf(t))),
    ...items.filter((t) => !muted(kindOf(t))),
  ];

  useEffect(() => setView(fitView(project)), [props.fitSignal]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setCalPts([]), [tool]);

  const toSvg = useCallback((clientX: number, clientY: number, inv?: DOMMatrix): Pt => {
    const svg = svgRef.current!;
    const m = inv ?? svg.getScreenCTM()!.inverse();
    const p = new DOMPoint(clientX, clientY).matrixTransform(m);
    return { x: p.x, y: p.y };
  }, []);

  // Колесо мыши: масштаб вокруг курсора. Слушатель не пассивный, чтобы не прокручивалась страница.
  useEffect(() => {
    const svg = svgRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = toSvg(e.clientX, e.clientY);
      const f = Math.exp(e.deltaY * 0.0015);
      setView((v) => ({ x: p.x - (p.x - v.x) * f, y: p.y - (p.y - v.y) * f, w: v.w * f, h: v.h * f }));
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [toSvg]);

  const groupOf = useMemo(() => {
    const m = new Map<string, number>();
    calc.groups.forEach((g) => g.deviceIds.forEach((id) => m.set(id, g.no)));
    return m;
  }, [calc]);
  const failedGroups = useMemo(
    () => new Set(calc.groups.filter((g) => g.checks.some((c) => !c.ok)).map((g) => g.no)),
    [calc],
  );
  const selectedGroupKey =
    selection?.kind === 'group'
      ? selection.key
      : selection?.kind === 'device'
        ? calc.groups.find((g) => g.deviceIds.includes(selection.id))?.key
        : undefined;

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    const svg = svgRef.current!;
    svg.setPointerCapture(e.pointerId);
    const p = toSvg(e.clientX, e.clientY);
    if (tool === 'room' && e.button === 0) {
      setDrag({ kind: 'room', start: p });
      return;
    }
    if (tool === 'calibrate' && e.button === 0) {
      const next = [...calPts, p];
      if (next.length === 2) {
        props.onCalibrate(next[0], next[1]);
        setCalPts([]);
      } else setCalPts(next);
      return;
    }
    setDrag({ kind: 'pan', start: p, view, inv: svg.getScreenCTM()!.inverse() });
    if (e.button === 0) setSelection(null);
  };

  const startDevice = (e: React.PointerEvent, id: string, pos: Pt) => {
    if (tool !== 'select' || e.button !== 0) return;
    e.stopPropagation();
    svgRef.current!.setPointerCapture(e.pointerId);
    const p = toSvg(e.clientX, e.clientY);
    setDrag({ kind: 'device', id, dx: pos.x - p.x, dy: pos.y - p.y });
    setSelection({ kind: 'device', id });
  };

  const startBox = (e: React.PointerEvent, key: string, pos: Pt, groupKey: string) => {
    if (tool !== 'select' || e.button !== 0) return;
    e.stopPropagation();
    svgRef.current!.setPointerCapture(e.pointerId);
    const p = toSvg(e.clientX, e.clientY);
    setDrag({ kind: 'box', key, dx: pos.x - p.x, dy: pos.y - p.y });
    setSelection({ kind: 'group', key: groupKey });
  };

  const startPanel = (e: React.PointerEvent) => {
    if (tool !== 'select' || e.button !== 0) return;
    e.stopPropagation();
    svgRef.current!.setPointerCapture(e.pointerId);
    const p = toSvg(e.clientX, e.clientY);
    setDrag({ kind: 'panel', dx: project.panel.x - p.x, dy: project.panel.y - p.y });
    setSelection({ kind: 'panel' });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    if (drag.kind === 'pan') {
      const p = toSvg(e.clientX, e.clientY, drag.inv);
      setView({ ...drag.view, x: drag.view.x - (p.x - drag.start.x), y: drag.view.y - (p.y - drag.start.y) });
      return;
    }
    const p = toSvg(e.clientX, e.clientY);
    if (drag.kind === 'device') {
      const pos = { x: Math.round(p.x + drag.dx), y: Math.round(p.y + drag.dy) };
      update((pr) => ({ ...pr, devices: pr.devices.map((d) => (d.id === drag.id ? { ...d, pos } : d)) }));
    } else if (drag.kind === 'box') {
      const pos = { x: Math.round(p.x + drag.dx), y: Math.round(p.y + drag.dy) };
      update((pr) => ({ ...pr, boxPos: { ...pr.boxPos, [drag.key]: pos } }));
    } else if (drag.kind === 'panel') {
      update((pr) => ({ ...pr, panel: { x: Math.round(p.x + drag.dx), y: Math.round(p.y + drag.dy) } }));
    } else if (drag.kind === 'room') {
      setPreview(rect(drag.start.x, drag.start.y, p.x, p.y));
    }
  };

  const onPointerUp = () => {
    if (drag?.kind === 'device') {
      update((pr) => ({
        ...pr,
        devices: pr.devices.map((d) => (d.id === drag.id ? { ...d, roomId: roomAt(d.pos, pr.rooms) } : d)),
      }));
    }
    if (drag?.kind === 'room' && preview) {
      const b = bbox(preview);
      if (b.maxX - b.minX > 300 && b.maxY - b.minY > 300) props.onRoomDrawn(preview.map((q) => ({ x: Math.round(q.x), y: Math.round(q.y) })));
    }
    setPreview(null);
    setDrag(null);
  };

  const removeDevice = (id: string) => {
    update((pr) => ({ ...pr, devices: pr.devices.filter((d) => d.id !== id) }));
    setSelection(null);
  };

  const canDrop = (e: React.DragEvent) => e.dataTransfer.types.includes(DRAG_MIME);
  const onDrop = (e: React.DragEvent) => {
    setDropping(false);
    if (!canDrop(e)) return;
    e.preventDefault();
    let data: DragPayload;
    try {
      data = JSON.parse(e.dataTransfer.getData(DRAG_MIME));
    } catch {
      return;
    }
    const p = toSvg(e.clientX, e.clientY);
    const pos = { x: Math.round(p.x), y: Math.round(p.y) };
    const id = `d${Date.now().toString(36)}m${(dropSeq++).toString(36)}`;
    update((pr) => {
      let dev: Device;
      if ('specId' in data) {
        const item = pr.spec.find((x) => x.id === data.specId);
        if (!item) return pr;
        dev = { id, specId: item.id, typeKey: item.typeKey, label: item.name, powerW: item.powerW, roomId: roomAt(pos, pr.rooms), pos };
      } else {
        const t = DEVICE_TYPES[data.typeKey as DeviceTypeKey];
        if (!t) return pr;
        dev = { id, specId: 'manual', typeKey: t.key, label: t.label, powerW: t.defaultPowerW, roomId: roomAt(pos, pr.rooms), pos };
      }
      return { ...pr, devices: [...pr.devices, dev] };
    });
    setSelection({ kind: 'device', id });
  };

  const unit = view.w / 1000; // примерно мм на пиксель при ширине окна ~1000 px
  const cursor = tool === 'select' ? (drag?.kind === 'pan' ? 'grabbing' : 'grab') : 'crosshair';

  return (
    <div
      className={`plan${dropping ? ' dropping' : ''}`}
      onDragOver={(e) => {
        if (!canDrop(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        if (!dropping) setDropping(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false);
      }}
      onDrop={onDrop}
    >
      <svg
        ref={svgRef}
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        style={{ cursor }}
      >
        <defs>
          <pattern id="grid" width="1000" height="1000" patternUnits="userSpaceOnUse">
            <path d="M1000 0H0V1000" fill="none" stroke="var(--grid)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          </pattern>
        </defs>
        <rect x={view.x} y={view.y} width={view.w} height={view.h} fill="url(#grid)" />

        {project.image && (
          <image
            href={project.image.dataUrl}
            x={0}
            y={0}
            width={project.image.widthPx * project.image.mmPerPx}
            height={project.image.heightPx * project.image.mmPerPx}
            opacity={0.55}
            style={{ pointerEvents: 'none' }}
          />
        )}

        {project.rooms.map((r) => {
          const c = centroid(r.poly);
          const sel = selection?.kind === 'room' && selection.id === r.id;
          return (
            <g key={r.id}>
              <polygon
                points={r.poly.map((p) => `${p.x},${p.y}`).join(' ')}
                fill={project.image ? 'transparent' : ROOM_FILL[r.type]}
                stroke={sel ? 'var(--accent)' : 'var(--wall)'}
                strokeWidth={sel ? 3 : project.image ? 1.5 : 4}
                vectorEffect="non-scaling-stroke"
                onPointerDown={(e) => {
                  if (tool === 'select' && e.button === 0) setTimeout(() => setSelection({ kind: 'room', id: r.id }));
                }}
              />
              <text x={c.x} y={c.y} className="room-label" fontSize={Math.max(160, unit * 13)}>
                {r.name}
              </text>
              <text x={c.x} y={c.y + Math.max(200, unit * 16)} className="room-area" fontSize={Math.max(120, unit * 11)}>
                {fmt(area(r.poly) / 1e6)} м²
              </text>
            </g>
          );
        })}

        {byLayer(calc.groups, (g) => g.kind).map((g) =>
          g.paths.map((path, i) => (
            <polyline
              key={`${g.key}-${i}`}
              points={path.map((p) => `${p.x},${p.y}`).join(' ')}
              fill="none"
              stroke={muted(g.kind) ? MUTED : groupColor(g.no)}
              strokeWidth={g.key === selectedGroupKey ? 3 : 1.5}
              strokeDasharray={g.key === selectedGroupKey ? undefined : '6 4'}
              opacity={muted(g.kind) ? 0.6 : selectedGroupKey && g.key !== selectedGroupKey ? 0.2 : 0.85}
              vectorEffect="non-scaling-stroke"
              style={{ pointerEvents: 'none' }}
            />
          )),
        )}

        {byLayer(calc.groups, (g) => g.kind).map((g) => {
          const off = muted(g.kind);
          const c = off ? MUTED : groupColor(g.no);
          return g.boxes.map((b) => (
            <g
              key={b.key}
              transform={`translate(${b.pos.x} ${b.pos.y})`}
              className="device"
              opacity={off ? 0.6 : selectedGroupKey && g.key !== selectedGroupKey ? 0.3 : 1}
              style={off ? { pointerEvents: 'none' } : undefined}
              onPointerDown={(e) => startBox(e, b.key, b.pos, g.key)}
            >
              <rect x={-90} y={-90} width={180} height={180} fill="var(--surface)" stroke={c} strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
              <line x1={-90} y1={-90} x2={90} y2={90} stroke={c} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
              <title>{`Распределительная коробка, гр. ${g.no}, ${b.outlets} отв. Перетащите, чтобы перенести`}</title>
            </g>
          ));
        })}

        {byLayer(project.devices, (d) => DEVICE_TYPES[d.typeKey].kind).map((d) => {
          const info = DEVICE_TYPES[d.typeKey];
          const off = muted(info.kind);
          const no = groupOf.get(d.id) ?? 0;
          const color = off ? MUTED : no ? groupColor(no) : '#868e96';
          const sel = selection?.kind === 'device' && selection.id === d.id;
          const dim = selectedGroupKey && calc.groups.find((g) => g.key === selectedGroupKey)?.deviceIds.includes(d.id) === false;
          const shape =
            d.typeKey === 'switch' ? (
              <g>
                <circle r={R * 0.75} fill="var(--surface)" stroke={color} strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
                <line x1={R * 0.5} y1={-R * 0.5} x2={R * 1.3} y2={-R * 1.3} stroke={color} strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
              </g>
            ) : info.kind === 'light' ? (
              <circle r={R} fill="var(--surface)" stroke={color} strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
            ) : info.kind === 'socket' ? (
              <path d={`M${-R} ${R * 0.6} A${R} ${R} 0 0 1 ${R} ${R * 0.6} Z`} transform={`translate(0 ${-R * 0.3})`} fill="var(--surface)" stroke={color} strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
            ) : (
              <rect x={-R * 1.15} y={-R * 0.8} width={R * 2.3} height={R * 1.6} fill="var(--surface)" stroke={color} strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
            );
          return (
            <g
              key={d.id}
              transform={`translate(${d.pos.x} ${d.pos.y})`}
              onPointerDown={(e) => startDevice(e, d.id, d.pos)}
              className="device"
              opacity={off ? 0.6 : dim ? 0.3 : 1}
              style={off ? { pointerEvents: 'none' } : undefined}
            >
              {sel && <circle r={R * 1.7} fill="none" stroke="var(--accent)" strokeWidth={2} vectorEffect="non-scaling-stroke" />}
              {!off && failedGroups.has(no) && <circle r={R * 1.35} fill="none" stroke="var(--bad)" strokeWidth={1.5} strokeDasharray="3 2" vectorEffect="non-scaling-stroke" />}
              {shape}
              <text className="glyph" fontSize={d.typeKey === 'switch' ? R * 0.6 : info.glyph.length > 1 ? R * 0.85 : R * 1.05} fill={color} y={info.kind === 'socket' ? R * 0.05 : 0}>
                {info.glyph}
              </text>
              {no > 0 && (
                <text className="gno" x={R * 1.25} y={-R * 0.9} fontSize={R * 0.9} fill={color}>
                  {no}
                </text>
              )}
              <title>{`${d.label}, ${fmt(d.powerW / 1000, 2)} кВт${no ? `, гр. ${no}` : ''}`}</title>
              {sel && !off && (
                <g
                  className="del-handle"
                  transform={`translate(${R * 1.2 + unit * 9} ${R * 0.6 + unit * 9})`}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    removeDevice(d.id);
                  }}
                >
                  <circle r={unit * 9} fill="var(--ink-2)" />
                  <path d={`M${-unit * 3.5} ${-unit * 3.5}L${unit * 3.5} ${unit * 3.5}M${unit * 3.5} ${-unit * 3.5}L${-unit * 3.5} ${unit * 3.5}`} stroke="#fff" strokeWidth={2} vectorEffect="non-scaling-stroke" />
                  <title>Удалить с плана (Delete)</title>
                </g>
              )}
            </g>
          );
        })}

        <g transform={`translate(${project.panel.x} ${project.panel.y})`} onPointerDown={startPanel} className="device">
          <rect
            x={-280}
            y={-170}
            width={560}
            height={340}
            fill="var(--ink)"
            stroke={selection?.kind === 'panel' ? 'var(--accent)' : 'none'}
            strokeWidth={3}
            vectorEffect="non-scaling-stroke"
          />
          <text className="glyph" fontSize={200} fill="var(--surface)">
            ЩК
          </text>
          <title>Щит квартирный — перетащите, чтобы перенести</title>
        </g>

        {preview && (
          <polygon
            points={preview.map((p) => `${p.x},${p.y}`).join(' ')}
            fill="var(--accent-soft)"
            stroke="var(--accent)"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />
        )}
        {calPts.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={unit * 5} fill="var(--accent)" />
        ))}
      </svg>
      <div className="seg plan-layers">
        {LAYERS.map((l) => (
          <button key={l.key} id={`layer-${l.key}`} className={layer === l.key ? 'on' : ''} onClick={() => chooseLayer(l.key)}>
            {l.label}
          </button>
        ))}
      </div>
      <div className="plan-hint">
        {tool === 'select' && 'Тащите точки по плану или приборы из списка слева. × или Delete удаляет. Колесо — масштаб.'}
        {tool === 'calibrate' && (calPts.length === 0 ? 'Кликните первую точку известного размера' : 'Кликните вторую точку')}
        {tool === 'room' && 'Растяните прямоугольник помещения'}
      </div>
    </div>
  );
}
