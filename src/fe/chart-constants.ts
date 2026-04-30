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
  MOTORWAY: 'dálnice',
  TRUNK: 'silnice pro motorová vozidla',
  PRIMARY: 'silnice I. třídy',
  SECONDARY: 'silnice II. třídy',
  TERTIARY: 'silnice III. třídy',
  RESIDENTIAL: 'městská komunikace',
  UNCLASSIFIED: 'nezatříděná',
  SERVICE: 'přístupová cesta',
  TRACK: 'polní cesta',
  OTHER: 'jiná',
}
