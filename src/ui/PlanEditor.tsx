import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { area, bbox, centroid, rect } from '../engine/geometry';
import { DEVICE_TYPES } from '../engine/norms';
import { roomAt } from '../engine/placement';
import type { Project, ProjectCalc, Pt, Room } from '../engine/types';
import { fmt, groupColor, type Selection, type Tool, type Update } from './state';

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
  | { kind: 'pan'; start: Pt; view: View; inv: DOMMatrix }
  | { kind: 'room'; start: Pt }
  | null;

const R = 140;
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

  const unit = view.w / 1000; // примерно мм на пиксель при ширине окна ~1000 px
  const cursor = tool === 'select' ? (drag?.kind === 'pan' ? 'grabbing' : 'grab') : 'crosshair';

  return (
    <div className="plan">
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

        {calc.groups.map((g) => (
          <polyline
            key={g.key}
            points={g.route.map((p) => `${p.x},${p.y}`).join(' ')}
            fill="none"
            stroke={groupColor(g.no)}
            strokeWidth={g.key === selectedGroupKey ? 3 : 1.5}
            strokeDasharray={g.key === selectedGroupKey ? undefined : '6 4'}
            opacity={selectedGroupKey && g.key !== selectedGroupKey ? 0.2 : 0.85}
            vectorEffect="non-scaling-stroke"
            style={{ pointerEvents: 'none' }}
          />
        ))}

        {project.devices.map((d) => {
          const info = DEVICE_TYPES[d.typeKey];
          const no = groupOf.get(d.id) ?? 0;
          const color = no ? groupColor(no) : '#868e96';
          const sel = selection?.kind === 'device' && selection.id === d.id;
          const dim = selectedGroupKey && calc.groups.find((g) => g.key === selectedGroupKey)?.deviceIds.includes(d.id) === false;
          const shape =
            info.kind === 'light' ? (
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
              opacity={dim ? 0.3 : 1}
            >
              {sel && <circle r={R * 1.7} fill="none" stroke="var(--accent)" strokeWidth={2} vectorEffect="non-scaling-stroke" />}
              {failedGroups.has(no) && <circle r={R * 1.35} fill="none" stroke="var(--bad)" strokeWidth={1.5} strokeDasharray="3 2" vectorEffect="non-scaling-stroke" />}
              {shape}
              <text className="glyph" fontSize={info.glyph.length > 1 ? R * 0.85 : R * 1.05} fill={color} y={info.kind === 'socket' ? R * 0.05 : 0}>
                {info.glyph}
              </text>
              {no > 0 && (
                <text className="gno" x={R * 1.25} y={-R * 0.9} fontSize={R * 0.9} fill={color}>
                  {no}
                </text>
              )}
              <title>{`${d.label}, ${fmt(d.powerW / 1000, 2)} кВт${no ? `, гр. ${no}` : ''}`}</title>
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
      <div className="plan-hint">
        {tool === 'select' && 'Перетаскивайте точки и щит. Колесо — масштаб, перетаскивание фона — сдвиг.'}
        {tool === 'calibrate' && (calPts.length === 0 ? 'Кликните первую точку известного размера' : 'Кликните вторую точку')}
        {tool === 'room' && 'Растяните прямоугольник помещения'}
      </div>
    </div>
  );
}
