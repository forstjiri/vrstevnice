import { createMemo, createRoot } from 'solid-js';
import { formatLocalDate, parseLocalDateTime } from '@vrstevnice/shared';
import { rideAnimation } from './rideAnimationStore';
import { persistedStore } from './persist';

const now = new Date();

export const DEFAULT_TERRAIN_EXAGGERATION = 2.2;

const ctx = createRoot(() => {
  // ── State (persisted to localStorage) ──
  const [mapControls, setMapControls] = persistedStore(
    {
      terrainOn: false,
      hillshadeOn: false,
      contoursOn: true,
      shadowRouteOn: false,
      hillshadeIntensity: 0.8,
      terrainExaggeration: DEFAULT_TERRAIN_EXAGGERATION,
      sunDate: formatLocalDate(now),
      sunMinutes: now.getHours() * 60 + now.getMinutes(),
    },
    { name: 'vrstevnice.map-controls' },
  );

  // ── Derived: ride animation time ──
  const animatedSunDateTime = createMemo(() => {
    if (!mapControls.hillshadeOn) return null;
    const anim = rideAnimation();
    if (!anim.playing || !anim.baseDateTime) return null;
    const base = parseLocalDateTime(anim.baseDateTime);
    if (!base) return null;
    return new Date(base.getTime() + anim.elapsedMs);
  });

  const effectiveSunDate = createMemo(() => {
    const animated = animatedSunDateTime();
    return animated ? formatLocalDate(animated) : mapControls.sunDate;
  });

  const effectiveSunMinutes = createMemo(() => {
    const animated = animatedSunDateTime();
    return animated ? animated.getHours() * 60 + animated.getMinutes() : mapControls.sunMinutes;
  });

  const effectiveSunDateTime = createMemo(
    () => composeLocalDateTime(effectiveSunDate(), effectiveSunMinutes()),
  );

  return {
    mapControls,
    setMapControls,
    effectiveSunDate,
    effectiveSunMinutes,
    effectiveSunDateTime,
  };
});

export const { mapControls, setMapControls } = ctx;
export const { effectiveSunDate, effectiveSunMinutes, effectiveSunDateTime } = ctx;

// ── Actions (enforce invariants) ──

export const mapControlActions = {
  setTerrainOn(value: boolean) {
    setMapControls('terrainOn', value);
    if (!value) {
      setMapControls('hillshadeOn', false);
      setMapControls('shadowRouteOn', false);
    }
  },
  setHillshadeOn(value: boolean) {
    setMapControls('hillshadeOn', value);
    if (!value) setMapControls('shadowRouteOn', false);
  },
  setContoursOn(value: boolean) {
    setMapControls('contoursOn', value);
  },
  setShadowRouteOn(value: boolean) {
    setMapControls('shadowRouteOn', value);
  },
  setTerrainExaggeration(value: number) {
    setMapControls('terrainExaggeration', value);
  },
  setHillshadeIntensity(value: number) {
    setMapControls('hillshadeIntensity', value);
  },
  setSunDate(value: string) {
    setMapControls('sunDate', value);
  },
  setSunMinutes(value: number) {
    setMapControls('sunMinutes', value);
  },
};

// ── Selectors ──

/** Hillshade is active when terrain + hillshade are both on */
export const hillshadeActive = (): boolean => mapControls.terrainOn && mapControls.hillshadeOn;

/** Shadow route is active when hillshade + shadow route toggle are on */
export const shadowRouteActive = (): boolean => hillshadeActive() && mapControls.shadowRouteOn;

// ── Helpers ──

export function formatMinutes(totalMinutes: number): string {
  const minutes = ((Math.round(totalMinutes) % 1440) + 1440) % 1440;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(hours)}:${pad(mins)}`;
}

export function composeLocalDateTime(date: string, totalMinutes: number): string {
  const minutes = ((Math.round(totalMinutes) % 1440) + 1440) % 1440;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date}T${pad(hours)}:${pad(mins)}`;
}
