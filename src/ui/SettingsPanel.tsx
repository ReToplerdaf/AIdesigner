import type { Project, Settings } from '../engine/types';
import type { Update } from './state';

type Field = { key: keyof Settings; label: string; step?: number; scale?: number; unit: string; hint?: string };

const FIELDS: Field[] = [
  { key: 'pAllowedW', label: 'Мощность по ТУ', scale: 1000, step: 0.5, unit: 'кВт' },
  { key: 'kc', label: 'Коэффициент спроса Кс', step: 0.05, unit: '', hint: 'В рабочей версии — по СП 256' },
  { key: 'zExtOhm', label: 'Zпетли до щита', step: 0.05, unit: 'Ом' },
  { key: 'dUMaxPct', label: 'Допустимая ΔU в группе', step: 0.5, unit: '%' },
  { key: 'ceilingH', label: 'Высота потолка', step: 50, unit: 'мм' },
  { key: 'lengthReserve', label: 'Запас длины кабеля', scale: 0.01, step: 5, unit: '%' },
  { key: 'dedicatedFromW', label: 'Отдельная линия от', scale: 1000, step: 0.1, unit: 'кВт' },
  { key: 'socketGroupMaxW', label: 'Предел розеточной группы', scale: 1000, step: 0.1, unit: 'кВт' },
  { key: 'socketGroupMaxCount', label: 'Розеток в группе, не более', step: 1, unit: 'шт' },
  { key: 'lightGroupMaxW', label: 'Предел группы освещения', scale: 1000, step: 0.1, unit: 'кВт' },
];

export function SettingsPanel({ project, update }: { project: Project; update: Update }) {
  const s = project.settings;
  const set = (patch: Partial<Settings>) => update((p) => ({ ...p, settings: { ...p.settings, ...patch } }));
  return (
    <div className="stack">
      <div className="seg">
        <button className={s.phases === 1 ? 'on' : ''} onClick={() => set({ phases: 1 })}>1 фаза, 230 В</button>
        <button className={s.phases === 3 ? 'on' : ''} onClick={() => set({ phases: 3 })}>3 фазы, 400 В</button>
      </div>
      <div className="fields">
        {FIELDS.map((f) => {
          const k = f.scale ?? 1;
          return (
            <label key={f.key} className="field">
              <span>{f.label}{f.hint && <small className="muted"> · {f.hint}</small>}</span>
              <span className="row">
                <input
                  id={`set-${f.key}`}
                  type="number"
                  step={f.step}
                  value={+((s[f.key] as number) / k).toFixed(4)}
                  onChange={(e) => set({ [f.key]: (+e.target.value || 0) * k } as Partial<Settings>)}
                />
                <span className="unit">{f.unit}</span>
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
