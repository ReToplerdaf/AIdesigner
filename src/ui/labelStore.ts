import { useSyncExternalStore } from 'react';
import type { Box } from '../engine/types';

/** Общее состояние списка помещений и плана: какую подпись подсветить и ждём ли обводку подписи на плане. */
export interface LabelState {
  highlight: Box | null;
  pick: { roomId: string; field: 'name' | 'area'; onPick: (box: Box) => void } | null;
}

let state: LabelState = { highlight: null, pick: null };
const subs = new Set<() => void>();

export const labelStore = {
  get: () => state,
  set(patch: Partial<LabelState>) {
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

export const useLabelStore = () => useSyncExternalStore(labelStore.subscribe, labelStore.get);
