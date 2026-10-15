import { useCallback, useEffect, useMemo, useState } from 'react';
import { computeProject } from './engine/calc';
import { dist } from './engine/geometry';
import type { Project, Pt } from './engine/types';
import { demoProject, DEFAULT_SETTINGS } from './data/demo';
import { PlanEditor } from './ui/PlanEditor';
import { PlanPanel } from './ui/PlanPanel';
import { SpecPanel } from './ui/SpecPanel';
import { SettingsPanel } from './ui/SettingsPanel';
import { CableLog, GroupsTable, Inspector, PanelSummary, SingleLine, toCsv } from './ui/Results';
import { download, loadSaved, save, type Selection, type Tool } from './ui/state';

type LeftTab = 'plan' | 'spec' | 'settings';
type RightTab = 'calc' | 'sld' | 'cables';

function emptyProject(): Project {
  return {
    version: 1,
    name: 'Новый проект',
    rooms: [],
    spec: [],
    devices: [],
    panel: { x: 500, y: 500 },
    settings: { ...DEFAULT_SETTINGS },
    image: null,
  };
}

export default function App() {
  const [project, setProject] = useState<Project>(() => loadSaved() ?? demoProject());
  const [selection, setSelection] = useState<Selection>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [left, setLeft] = useState<LeftTab>('spec');
  const [right, setRight] = useState<RightTab>('calc');
  const [pendingCal, setPendingCal] = useState<{ a: Pt; b: Pt } | null>(null);
  const [fitSignal, setFitSignal] = useState(0);

  const update = useCallback((fn: (p: Project) => Project) => setProject(fn), []);
  const calc = useMemo(() => computeProject(project), [project]);

  useEffect(() => {
    const t = setTimeout(() => save(project), 400);
    return () => clearTimeout(t);
  }, [project]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'Escape') {
        setSelection(null);
        setTool('select');
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selection?.kind === 'device') {
        update((p) => ({ ...p, devices: p.devices.filter((d) => d.id !== selection.id) }));
        setSelection(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selection, update]);

  const reset = (p: Project) => {
    setProject(p);
    setSelection(null);
    setTool('select');
    setFitSignal((n) => n + 1);
  };

  const applyCalibration = (realMm: number) => {
    if (!pendingCal) return;
    const k = realMm / dist(pendingCal.a, pendingCal.b);
    const s = (q: Pt) => ({ x: Math.round(q.x * k), y: Math.round(q.y * k) });
    update((p) => ({
      ...p,
      image: p.image ? { ...p.image, mmPerPx: p.image.mmPerPx * k } : null,
      rooms: p.rooms.map((r) => ({ ...r, poly: r.poly.map(s) })),
      devices: p.devices.map((d) => ({ ...d, pos: s(d.pos) })),
      panel: s(p.panel),
    }));
    setPendingCal(null);
    setTool('room');
    setFitSignal((n) => n + 1);
  };

  const openFile = async (f: File) => {
    try {
      const p = JSON.parse(await f.text()) as Project;
      if (p.version !== 1) throw new Error('неизвестный формат');
      reset({ ...p, settings: { ...DEFAULT_SETTINGS, ...p.settings } });
    } catch (e) {
      alert(`Не удалось открыть проект: ${(e as Error).message}`);
    }
  };

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          AIdesigner <span>ЭОМ · прототип</span>
        </div>
        <input
          id="project-name"
          className="pname"
          value={project.name}
          onChange={(e) => update((p) => ({ ...p, name: e.target.value }))}
        />
        <div className="row">
          <button className="btn ghost" onClick={() => reset(demoProject())}>Демо-квартира</button>
          <button className="btn ghost" onClick={() => reset(emptyProject())}>Новый</button>
          <label className="btn ghost">
            Открыть…
            <input id="open-file" type="file" accept=".json" hidden onChange={(e) => e.target.files?.[0] && openFile(e.target.files[0])} />
          </label>
          <button className="btn ghost" onClick={() => download(`${project.name}.json`, JSON.stringify(project, null, 1), 'application/json')}>
            Сохранить
          </button>
          <button className="btn" onClick={() => download(`${project.name} — группы.csv`, toCsv(calc), 'text/csv;charset=utf-8')}>
            Экспорт CSV
          </button>
        </div>
      </header>

      <aside className="left">
        <nav className="tabs">
          <button className={left === 'plan' ? 'on' : ''} onClick={() => setLeft('plan')}>План</button>
          <button className={left === 'spec' ? 'on' : ''} onClick={() => { setLeft('spec'); setTool('select'); }}>Спецификация</button>
          <button className={left === 'settings' ? 'on' : ''} onClick={() => { setLeft('settings'); setTool('select'); }}>Настройки</button>
        </nav>
        <div className="pane">
          {left === 'plan' && (
            <PlanPanel
              project={project}
              update={update}
              tool={tool}
              setTool={setTool}
              selection={selection}
              setSelection={setSelection}
              pendingCalibration={pendingCal ? dist(pendingCal.a, pendingCal.b) : null}
              applyCalibration={applyCalibration}
              cancelCalibration={() => setPendingCal(null)}
            />
          )}
          {left === 'spec' && <SpecPanel project={project} update={update} />}
          {left === 'settings' && <SettingsPanel project={project} update={update} />}
        </div>
      </aside>

      <main className="center">
        <PanelSummary calc={calc} project={project} onSelect={() => setSelection({ kind: 'panel' })} />
        <PlanEditor
          project={project}
          calc={calc}
          update={update}
          selection={selection}
          setSelection={setSelection}
          tool={tool}
          fitSignal={fitSignal}
          onCalibrate={(a, b) => {
            setPendingCal({ a, b });
            setLeft('plan');
          }}
          onRoomDrawn={(poly) => {
            const id = `r${Date.now().toString(36)}`;
            update((p) => ({ ...p, rooms: [...p.rooms, { id, name: `Помещение ${p.rooms.length + 1}`, type: 'other', poly }] }));
            setSelection({ kind: 'room', id });
            setLeft('plan');
          }}
        />
      </main>

      <aside className="right">
        <nav className="tabs">
          <button className={right === 'calc' ? 'on' : ''} onClick={() => setRight('calc')}>Расчёт</button>
          <button className={right === 'sld' ? 'on' : ''} onClick={() => setRight('sld')}>Однолинейная схема</button>
          <button className={right === 'cables' ? 'on' : ''} onClick={() => setRight('cables')}>Кабельный журнал</button>
        </nav>
        <div className="pane">
          {right === 'calc' && (
            <div className="stack">
              <div className="inspector">
                <Inspector project={project} calc={calc} selection={selection} setSelection={setSelection} update={update} />
              </div>
              <GroupsTable calc={calc} selection={selection} setSelection={setSelection} />
            </div>
          )}
          {right === 'sld' && <SingleLine calc={calc} project={project} />}
          {right === 'cables' && <CableLog calc={calc} rooms={project.rooms} />}
        </div>
      </aside>
    </div>
  );
}
