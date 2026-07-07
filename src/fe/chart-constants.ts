/**
 * Elevation chart display constants and utility functions.
 */

import type { ElevationPoint } from '@vrstevnice/shared'

export const PADDING = { top: 8, right: 12, bottom: 22, left: 42 }
export const TOOLTIP_OFFSET = 12

/**
 * Binary search for the segment containing a given distance.
 * Returns segment index, or -1 if no segment matches.
 * O(log n) per lookup instead of O(n) linear scan.
 */
export function binarySearchSegment(
  segStarts: number[],
  segEnds: number[],
  dist: number,
): number {
  let lo = 0
  let hi = segStarts.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (dist < segStarts[mid]) { hi = mid - 1; continue }
    if (dist > segEnds[mid]) { lo = mid + 1; continue }
    return mid
  }
  return -1
}

/**
 * Sample a value per elevation-profile point by looking up the containing
 * segment (indexed into `geomDists`) and applying `extract` to it. Points
 * outside any segment get `fallback`. Used for surface/road-class coloring.
 */
export function sampleSegmentByDistance<S extends { from: number; to: number }, T>(
  profile: ElevationPoint[],
  geomDists: number[],
  segments: S[],
  extract: (seg: S) => T,
  fallback: T,
): T[] {
  if (segments.length === 0) return profile.map(() => fallback)
  const starts = segments.map(s => geomDists[s.from] ?? -Infinity)
  const ends = segments.map(s => geomDists[s.to] ?? Infinity)
  return profile.map(p => {
    const idx = binarySearchSegment(starts, ends, p.distance)
    return idx >= 0 ? extract(segments[idx]) : fallback
  })
}

/**
 * Interpolate a value at each elevation-profile point from a list of
 * (distance, value) samples via segment lookup. Used for shadow/sun exposure.
 */
export function sampleValueByDistance<T>(
  profile: ElevationPoint[],
  samples: { distance: number }[],
  values: T[],
  fallback: T,
): T[] {
  if (samples.length === 0) return profile.map(() => fallback)
  const starts = samples.map(s => s.distance)
  const ends = [...starts.slice(1), Infinity]
  return profile.map(p => {
    const idx = binarySearchSegment(starts, ends, p.distance)
    return idx >= 0 ? values[idx] : fallback
  })
}

/**
 * Convert hex color to rgba string.
 */
export function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export const SURFACE_COLORS: Record<string, string> = {
  asphalt: '#9ca3af',
  concrete: '#d1d5db',
  paving_stones: '#c4cace',
  cobblestone: '#92400e',
  gravel: '#c4a35a',
  fine_gravel: '#d4b96a',
  compacted: '#b8a070',
  cycleway: '#ec4899',
  track: '#22c55e',
  trail: '#22c55e',
  ground: '#65a30d',
  dirt: '#a16207',
  unpaved: '#d6d3d1',
  paved: '#9ca3af',
  grass: '#4ade80',
  sand: '#fbbf24',
}

export const DEFAULT_SURFACE_COLOR = '#94a3b8'

export const SURFACE_LABELS: Record<string, string> = {
  asphalt: 'asfalt',
  concrete: 'beton',
  paving_stones: 'dlažba',
  cobblestone: 'kočičí hlavy',
  gravel: 'štěrk',
  fine_gravel: 'jemný štěrk',
  compacted: 'zhutněný',
  cycleway: 'cyklostezka',
  track: 'polní cesta',
  trail: 'pěšina',
  ground: 'zem',
  dirt: 'hlína',
  unpaved: 'nezpevněno',
  paved: 'zpevněno',
  grass: 'tráva',
  sand: 'písek',
}

export const ROAD_CLASS_LABELS: Record<string, string> = {
  motorway: 'dálnice',
  trunk: 'silnice pro motorová vozidla',
  primary: 'silnice I. třídy',
  secondary: 'silnice II. třídy',
  tertiary: 'silnice III. třídy',
  residential: 'městská komunikace',
  living_street: 'obytná zóna',
  unclassified: 'nezatříděná',
  service: 'přístupová cesta',
  track: 'polní cesta',
  path: 'pěšina',
  cycleway: 'cyklostezka',
  steps: 'schody',
  ferry: 'přívoz',
  other: 'jiná',
}

export const ROAD_CLASS_COLORS: Record<string, string> = {
  motorway: '#dc2626',
  trunk: '#ea580c',
  primary: '#f59e0b',
  secondary: '#eab308',
  tertiary: '#22c55e',
  residential: '#3b82f6',
  living_street: '#60a5fa',
  unclassified: '#94a3b8',
  service: '#a78bfa',
  track: '#65a30d',
  path: '#92400e',
  cycleway: '#ec4899',
  steps: '#f97316',
  ferry: '#38bdf8',
  other: '#6b7280',
}

export const DEFAULT_ROAD_CLASS_COLOR = '#6b7280'

/**
 * Line dash pattern per road class. null = solid line.
 */
export const ROAD_CLASS_DASH: Record<string, number[] | undefined> = {
  path: [4, 3],
  cycleway: [6, 3],
  track: undefined,
  // All others default to solid
}
