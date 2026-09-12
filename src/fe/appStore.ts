import { createRoot, createSignal } from 'solid-js';
import type { Stop, RouteResponse } from '@vrstevnice/shared';
import { persistedStore, persistedSignal } from './persist';

declare global {
  interface Window {
    __planner: typeof planner;
  }
}

// Persisted planner state — stores route too, but the serializer drops it when
// inputs have changed since the last successful route calculation.
let inputsDirty = false;

const ctx = createRoot(() => {
  const [planner, setPlanner] = persistedStore(
    {
      stops: [] as Stop[],
      elevation: 0.4,
      roadAvoid: 0.9,
      cycleway: 0.9,
      showPOI: false,
      useRoadRatings: false,
      route: null as RouteResponse | null,
    },
    {
      name: 'vrstevnice.planner',
      serialize: (v) => JSON.stringify(inputsDirty ? { ...v, route: null } : v),
    },
  );

  // Transient UI state
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [sheetOpen, setSheetOpen] = createSignal(false);
  const [activeTab, setActiveTab] = persistedSignal<'planner' | 'terrain' | 'chart'>(
    'planner',
    { name: 'vrstevnice.active-tab' },
  );

  // Route regeneration function (registered by Stops component on mount)
  const [regenerateFn, setRegenerateFn] = createSignal<() => Promise<void>>(async () => {});

  return {
    planner,
    setPlanner,
    loading,
    setLoading,
    error,
    setError,
    sheetOpen,
    setSheetOpen,
    activeTab,
    setActiveTab,
    regenerateFn,
    setRegenerateFn,
  };
});

export const {
  planner, setPlanner,
  loading, setLoading,
  error, setError,
  sheetOpen, setSheetOpen,
  activeTab, setActiveTab,
  setRegenerateFn,
} = ctx;

export function regenerateRoute() {
  return ctx.regenerateFn()();
}

// ── Planner actions — mark route stale on input changes ──

function markStale() {
  inputsDirty = true;
}

export function addStop(stop: Stop) {
  markStale();
  setPlanner('stops', (prev) => [...prev, stop]);
}

export function setStops(stops: Stop[]) {
  markStale();
  setPlanner('stops', stops);
}

export function updateStop(index: number, lat: number, lng: number) {
  markStale();
  setPlanner('stops', (prev) => {
    if (index < 0 || index >= prev.length) return prev;
    const next = [...prev];
    next[index] = { ...next[index], lat, lng };
    return next;
  });
}

export function removeStop(index: number) {
  markStale();
  setPlanner('stops', (prev) => prev.filter((_, i) => i !== index));
}

export function reorderStop(from: number, to: number) {
  markStale();
  setPlanner('stops', (prev) => {
    if (from === to || from < 0 || to < 0 || from >= prev.length || to >= prev.length) {
      return prev;
    }
    const next = [...prev];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    return next;
  });
}

export function moveStop(index: number, dir: -1 | 1) {
  markStale();
  setPlanner('stops', (prev) => {
    const next = [...prev];
    const target = index + dir;
    if (target < 0 || target >= next.length) return prev;
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  });
}

export function setElevation(v: number) {
  markStale();
  setPlanner('elevation', v);
}
export function setRoadAvoid(v: number) {
  markStale();
  setPlanner('roadAvoid', v);
}
export function setCycleway(v: number) {
  markStale();
  setPlanner('cycleway', v);
}
export function setShowPOI(v: boolean) {
  markStale();
  setPlanner('showPOI', v);
}

export function setUseRoadRatings(v: boolean) {
  if (planner.useRoadRatings === v) return;
  const shouldRegenerate = planner.route !== null && !ctx.loading();
  markStale();
  setPlanner('useRoadRatings', v);
  if (shouldRegenerate) regenerateRoute().catch(() => {});
}

// ── Route actions ──

export function setRoute(route: RouteResponse | null) {
  if (route) inputsDirty = false;
  setPlanner('route', route);
}

export function clearRoute() {
  inputsDirty = false;
  setPlanner('route', null);
}

if (typeof window !== 'undefined') window.__planner = planner;
