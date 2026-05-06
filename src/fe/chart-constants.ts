/**
 * Elevation chart display constants.
 */

export const PADDING = { top: 8, right: 12, bottom: 22, left: 42 }
export const TOOLTIP_OFFSET = 12

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
  path: '#4ade80',
  cycleway: '#ec4899',
  steps: '#f97316',
  ferry: '#38bdf8',
  other: '#6b7280',
}

export const DEFAULT_ROAD_CLASS_COLOR = '#6b7280'
