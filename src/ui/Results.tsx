import { DEVICE_TYPES } from '../engine/norms';
import type { GroupCalc, Project, ProjectCalc, Trace } from '../engine/types';
import { fmt, groupColor, type Selection, type Update } from './state';

const qf = (g: GroupCalc) => `${g.rcd ? 'QFD' : 'QF'}${g.no}`;
const apparatus = (g: GroupCalc) => `${g.curve}${g.breakerA}${g.rcd ? ', 30 мА' : ''}`;

function Checks({ checks }: { checks: { ok: boolean; text: string }[] }) {
  return (
    <ul className="checks">
      {checks.map((c, i) => (
        <li key={i} className={c.ok ? 'ok' : 'bad'}>
          <span aria-hidden>{c.ok ? '✓' : '✕'}</span> {c.text}
        </li>
      ))}
    </ul>
  );
}

function TraceList({ trace }: { trace: Trace[] }) {
  return (
    <dl className="trace">
      {trace.map((t, i) => (
        <div key={i}>
          <dt>{t.what}</dt>
          <dd>
            <strong>{t.value}</strong>
            <span>{t.how}</span>
            {t.source && <em>{t.source}</em>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function PanelSummary({ calc, project, onSelect }: { calc: ProjectCalc; project: Project; onSelect: () => void }) {
  const p = calc.panel;
  const bad = calc.groups.filter((g) => g.checks.some((c) => !c.ok)).length + p.checks.filter((c) => !c.ok).length;
  const rows: [string, string, string, string?][] = [
    ['Ру', `${fmt(p.installedW / 1000, 1)} кВт`, 'Установленная мощность'],
    ['Рр', `${fmt(p.designW / 1000, 1)} кВт`, 'Расчётная мощность с учётом коэффициента спроса'],
    ['Iр', `${fmt(p.currentA, 1)} А`, 'Расчётный ток на вводе'],
    ['Ввод', `C${p.inputBreakerA}${project.settings.phases === 3 ? ' 3P' : ''}`, 'Вводной автомат'],
    ['Групп', String(calc.groups.length), 'Число групп в щите'],
    ['Проверки', bad ? `${bad} ✕` : 'все ✓', 'Проверки по нормам. Нажмите, чтобы открыть расчёт щита', bad ? 'bad' : 'ok'],
  ];
  return (
    <button className="summary" onClick={onSelect} title="Сводка по щиту. Нажмите, чтобы открыть расчёт щита">
      {rows.map(([k, v, hint, cls]) => (
        <div key={k} className={cls} title={hint}>
          <span className="k">{k}</span>
          <span className="v">{v}</span>
        </div>
      ))}
    </button>
  );
}

export function GroupsTable({ calc, selection, setSelection }: { calc: ProjectCalc; selection: Selection; setSelection: (s: Selection) => void }) {
  const selKey = selection?.kind === 'group' ? selection.key : null;
  return (
    <div className="tablewrap">
      <table className="groups">
        <thead>
          <tr>
            <th>Гр.</th>
            <th>Назначение</th>
            <th className="num">P, кВт</th>
            <th className="num">I, А</th>
            <th>Аппарат</th>
            <th>Кабель</th>
            <th className="num">L, м</th>
            <th className="num">ΔU, %</th>
          </tr>
        </thead>
        <tbody>
          {calc.groups.map((g) => {
            const bad = g.checks.some((c) => !c.ok);
            return (
              <tr key={g.key} className={`${selKey === g.key ? 'sel' : ''}${bad ? ' badrow' : ''}`} onClick={() => setSelection({ kind: 'group', key: g.key })}>
                <td>
                  <span className="dot" style={{ background: groupColor(g.no) }} />
                  {g.no}
                </td>
                <td className="title">{g.title}</td>
                <td className="num">{fmt(g.powerW / 1000, 2)}</td>
                <td className="num">{fmt(g.currentA)}</td>
                <td>{apparatus(g)}</td>
                <td>3×{String(g.sectionMm2).replace('.', ',')}</td>
                <td className="num">{g.lengthM}</td>
                <td className={`num${g.dUPct > 0 && bad ? ' bad' : ''}`}>{fmt(g.dUPct, 2)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function Inspector({
  project,
  calc,
  selection,
  setSelection,
  update,
}: {
  project: Project;
  calc: ProjectCalc;
  selection: Selection;
  setSelection: (s: Selection) => void;
  update: Update;
}) {
  if (!selection) {
    return <p className="muted">Выберите точку, группу или щит, чтобы увидеть расчёт и обоснование.</p>;
  }

  if (selection.kind === 'panel') {
    return (
      <div className="stack-s">
        <h3>Щит квартирный ЩК</h3>
        <Checks checks={calc.panel.checks} />
        {project.settings.phases === 3 && (
          <p className="small">
            Нагрузка по фазам: {calc.panel.phaseLoadsW.map((w, i) => `L${i + 1} ${fmt(w / 1000, 2)} кВт`).join(' · ')}
          </p>
        )}
        <TraceList trace={calc.panel.trace} />
      </div>
    );
  }

  if (selection.kind === 'room') {
    const r = project.rooms.find((x) => x.id === selection.id);
    if (!r) return null;
    const devs = project.devices.filter((d) => d.roomId === r.id);
    return (
      <div className="stack-s">
        <h3>{r.name}</h3>
        <p className="small">{devs.length} точек, {fmt(devs.reduce((s, d) => s + d.powerW, 0) / 1000, 2)} кВт</p>
      </div>
    );
  }

  const group =
    selection.kind === 'group'
      ? calc.groups.find((g) => g.key === selection.key)
      : calc.groups.find((g) => g.deviceIds.includes(selection.id));
  const device = selection.kind === 'device' ? project.devices.find((d) => d.id === selection.id) : undefined;

  const setDevice = (patch: Partial<NonNullable<typeof device>>) =>
    device && update((p) => ({ ...p, devices: p.devices.map((d) => (d.id === device.id ? { ...d, ...patch } : d)) }));

  const newGroupKey = () => {
    let n = 1;
    while (calc.groups.some((g) => g.key === `manual:${n}`)) n++;
    return `manual:${n}`;
  };

  return (
    <div className="stack-s">
      {device && (
        <div className="device-card">
          <h3>{device.label}</h3>
          <p className="small muted">{DEVICE_TYPES[device.typeKey].label} · {project.rooms.find((r) => r.id === device.roomId)?.name ?? 'вне помещений'}</p>
          <div className="row">
            <label className="field-inline">
              Мощность
              <input id="dev-power" type="number" step={0.1} min={0} value={device.powerW / 1000} onChange={(e) => setDevice({ powerW: Math.round((+e.target.value || 0) * 1000) })} />
              кВт
            </label>
          </div>
          <label className="field-inline">
            Группа
            <select
              id="dev-group"
              value={device.groupKey ?? ''}
              onChange={(e) => setDevice({ groupKey: e.target.value === 'new' ? newGroupKey() : e.target.value || undefined })}
            >
              <option value="">Автоматически{group && !device.groupKey ? ` (гр. ${group.no})` : ''}</option>
              {calc.groups.map((g) => (
                <option key={g.key} value={g.key}>Гр. {g.no}: {g.title}</option>
              ))}
              <option value="new">Новая группа</option>
            </select>
          </label>
          <button
            className="btn ghost small"
            onClick={() => {
              update((p) => ({ ...p, devices: p.devices.filter((d) => d.id !== device.id) }));
              setSelection(null);
            }}
          >
            Удалить точку
          </button>
        </div>
      )}
      {group && (
        <>
          <h3>
            <span className="dot" style={{ background: groupColor(group.no) }} /> Группа {group.no}: {group.title}
          </h3>
          <p className="small">
            {qf(group)} {apparatus(group)} · {group.cableMark}, {group.lengthM} м · {group.deviceIds.length} точек{group.boxes.length ? ` · ${group.boxes.length} коробок` : ''}
            {project.settings.phases === 3 ? ` · фаза L${group.phase}` : ''}
          </p>
          <Checks checks={group.checks} />
          <TraceList trace={group.trace} />
        </>
      )}
    </div>
  );
}

export function SingleLine({ calc, project }: { calc: ProjectCalc; project: Project }) {
  const gs = calc.groups;
  const colW = 86;
  const left = 150;
  const width = left + gs.length * colW + 20;
  const busY = 70;
  const rows = ['Обозначение', 'Аппарат', 'Кабель', 'Длина, м', 'P, кВт', 'I, А', 'ΔU, %', ...(project.settings.phases === 3 ? ['Фаза'] : []), 'Назначение'];
  const tableY = 250;
  const rowH = 26;
  const height = tableY + rowH * (rows.length - 1) + 110;
  const p = calc.panel;
  const cell = (g: GroupCalc, r: string) => {
    switch (r) {
      case 'Обозначение': return qf(g);
      case 'Аппарат': return apparatus(g);
      case 'Кабель': return `3×${String(g.sectionMm2).replace('.', ',')}`;
      case 'Длина, м': return String(g.lengthM);
      case 'P, кВт': return fmt(g.powerW / 1000, 2);
      case 'I, А': return fmt(g.currentA);
      case 'ΔU, %': return fmt(g.dUPct, 2);
      case 'Фаза': return `L${g.phase}`;
      default: return '';
    }
  };
  return (
    <div className="tablewrap sld">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="sld-svg">
        {/* Ввод */}
        <text x={10} y={22} className="sld-t b">Ввод {project.settings.phases === 3 ? '3P+N' : '1P+N'}, Рр {fmt(p.designW / 1000, 1)} кВт, Iр {fmt(p.currentA)} А</text>
        <line x1={20} y1={busY} x2={60} y2={busY} className="sld-l" />
        <rect x={60} y={busY - 12} width={34} height={24} className="sld-box" />
        <line x1={60} y1={busY - 12} x2={94} y2={busY + 12} className="sld-l" />
        <text x={77} y={busY + 34} className="sld-t c">QF0 C{p.inputBreakerA}</text>
        <line x1={94} y1={busY} x2={width - 20} y2={busY} className="sld-bus" />
        {gs.map((g, i) => {
          const x = left + i * colW + colW / 2;
          return (
            <g key={g.key}>
              <line x1={x} y1={busY} x2={x} y2={busY + 40} className="sld-l" />
              <rect x={x - 12} y={busY + 40} width={24} height={34} className="sld-box" />
              <line x1={x - 12} y1={busY + 40} x2={x + 12} y2={busY + 74} className="sld-l" />
              {g.rcd && <ellipse cx={x} cy={busY + 92} rx={14} ry={8} className="sld-box" />}
              <line x1={x} y1={busY + 74} x2={x} y2={tableY - 26} className="sld-l" style={{ stroke: groupColor(g.no) }} />
              <polygon points={`${x - 6},${tableY - 32} ${x + 6},${tableY - 32} ${x},${tableY - 22}`} fill={groupColor(g.no)} />
            </g>
          );
        })}
        {rows.map((r, ri) => {
          const y = tableY + ri * rowH;
          return (
            <g key={r}>
              <line x1={10} y1={y - 18} x2={width - 10} y2={y - 18} className="sld-grid" />
              <text x={14} y={y} className="sld-t muted">{r}</text>
              {r !== 'Назначение' &&
                gs.map((g, i) => (
                  <text key={g.key} x={left + i * colW + colW / 2} y={y} className="sld-t c">{cell(g, r)}</text>
                ))}
              {r === 'Назначение' &&
                gs.map((g, i) => (
                  <foreignObject key={g.key} x={left + i * colW + 3} y={y - 16} width={colW - 6} height={100}>
                    <div className="sld-purpose">{g.title}</div>
                  </foreignObject>
                ))}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function CableLog({ calc, rooms }: { calc: ProjectCalc; rooms: Project['rooms'] }) {
  const totals = new Map<string, number>();
  calc.groups.forEach((g) => totals.set(g.cableMark, (totals.get(g.cableMark) ?? 0) + g.lengthM));
  return (
    <div className="stack-s">
      <div className="tablewrap">
        <table className="groups">
          <thead>
            <tr>
              <th>Обозн.</th>
              <th>Откуда</th>
              <th>Куда</th>
              <th>Марка</th>
              <th className="num">Длина, м</th>
            </tr>
          </thead>
          <tbody>
            {calc.groups.map((g) => (
              <tr key={g.key}>
                <td>W{g.no}</td>
                <td>ЩК, {qf(g)}</td>
                <td className="title">{g.roomNames.join(', ')}</td>
                <td>{g.cableMark}</td>
                <td className="num">{g.lengthM}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>Распределительные коробки</h3>
      <div className="tablewrap">
        <table className="groups">
          <thead>
            <tr>
              <th>Группа</th>
              <th>Помещение</th>
              <th className="num">Ответвлений</th>
            </tr>
          </thead>
          <tbody>
            {calc.groups.flatMap((g) =>
              g.boxes.map((b) => (
                <tr key={b.key}>
                  <td>{g.no}</td>
                  <td className="title">{rooms.find((r) => r.id === b.roomId)?.name ?? ''}</td>
                  <td className="num">{b.outlets}</td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>
      <p className="small muted">
        Всего коробок: <strong>{calc.groups.reduce((s, g) => s + g.boxes.length, 0)} шт.</strong> Коробку можно перетащить на плане.
      </p>
      <h3>Проходы в стенах</h3>
      <div className="tablewrap">
        <table className="groups">
          <thead>
            <tr>
              <th>Стена</th>
              <th className="num">Кабелей</th>
              <th>Группы</th>
              <th className="num">Гильза, мм</th>
            </tr>
          </thead>
          <tbody>
            {calc.passages.map((w) => (
              <tr key={w.key}>
                <td className="title">{w.rooms.map((id) => rooms.find((r) => r.id === id)?.name ?? id).join(' — ')}</td>
                <td className="num">{w.cables}</td>
                <td>{w.groupNos.join(', ')}</td>
                <td className="num">Ø{w.sleeveMm}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted">
        Одно отверстие на стену между помещениями, через него идут все кабели. Отверстие можно перетащить вдоль стены. Гильза
        ориентировочная: заполнение не более 40 %.
      </p>
      <h3>Итого кабеля</h3>
      <ul className="plain">
        {[...totals].map(([mark, len]) => (
          <li key={mark}>
            {mark}: <strong>{len} м</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function toCsv(calc: ProjectCalc): string {
  const head = ['Группа', 'Обозначение', 'Назначение', 'Помещения', 'P, кВт', 'cosφ', 'I, А', 'Аппарат', 'Кабель', 'Длина, м', 'ΔU, %', 'Iкз, А', 'Фаза'];
  const rows = calc.groups.map((g) => [
    g.no, qf(g), g.title, g.roomNames.join(', '), fmt(g.powerW / 1000, 2), fmt(g.cosPhi, 2), fmt(g.currentA),
    apparatus(g), g.cableMark, g.lengthM, fmt(g.dUPct, 2), fmt(g.ikA, 0), `L${g.phase}`,
  ]);
  return '﻿' + [head, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\n');
}
