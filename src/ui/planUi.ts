import { useSyncExternalStore } from 'react';
import type { Box } from '../engine/types';

/**
 * Общее состояние панели «План» и редактора плана: какую подпись подсветить, ждём ли обводку подписи на плане,
 * правится ли сейчас граница дома (первый шаг «Анализа»).
 */
export interface PlanUiState {
  highlight: Box | null;
  outlineEdit: boolean;
  pick: { roomId: string; field: 'name' | 'area'; onPick: (box: Box) => void } | null;
}

let state: PlanUiState = { highlight: null, pick: null, outlineEdit: false };
const subs = new Set<() => void>();

export const planUi = {
  get: () => state,
  set(patch: Partial<PlanUiState>) {
    state = { ...state, ...patch };
    subs.forEach((f) => f());
  },
  subscribe(f: () => void) {
    subs.add(f);
    return () => {
      subs.delete(f);
    };
  },
};

export const usePlanUi = () => useSyncExternalStore(planUi.subscribe, planUi.get);
