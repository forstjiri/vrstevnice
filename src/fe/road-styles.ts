import type * as maplibregl from 'maplibre-gl';
import type {
  ExpressionSpecification,
} from '@maplibre/maplibre-gl-style-spec';

/** Values exposed by the OpenMapTiles transportation layer schema. */
const ROAD_CLASSES = [
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary',
  'minor', 'service', 'track', 'path',
] as const;

type TransportationClass = typeof ROAD_CLASSES[number];
type RoadKind = TransportationClass
  | 'cycleway'
  | 'designated-cycle-road'
  | 'paved-track'
  | 'uncertain-track'
  | 'paved-path'
  | 'uncertain-path'
  | 'paved-service'
  | 'unpaved-service';
type ExpressionValue = string | number | ExpressionSpecification;

interface StrokeStyle {
  color: string;
  widthAtZ14: number;
  opacity?: number;
  minZoom?: number;
  dash?: readonly [number, number];
}

interface RoadStyle {
  line: StrokeStyle;
  casing?: StrokeStyle;
  sortKey: number;
  legend?: string;
}

export interface CycleRouteStyle {
  id: string;
  network: string;
  label: string;
  color: string;
  width: number;
}

const road = (color: string, widthAtZ14: number, opacity = 1, minZoom?: number): StrokeStyle => ({
  color,
  widthAtZ14,
  opacity,
  minZoom,
});

const oneOf = (property: string, values: readonly string[]): ExpressionSpecification => [
  'match', ['get', property], [...values], true, false,
];

const dashed = (
  color: string,
  widthAtZ14: number,
  minZoom = 14,
  pattern: readonly [number, number] = [1.5, 3],
): StrokeStyle => ({
  color,
  widthAtZ14,
  minZoom,
  dash: pattern,
});

const paved = ['==', ['get', 'surface'], 'paved'] satisfies ExpressionSpecification;
const uncertain = [
  'any',
  ['==', ['get', 'surface'], 'unpaved'],
  ['!', ['has', 'surface']],
] satisfies ExpressionSpecification;
const track = ['==', ['get', 'class'], 'track'] satisfies ExpressionSpecification;
const path = [
  'all',
  ['==', ['get', 'class'], 'path'],
  oneOf('subclass', ['path', 'footway', 'pedestrian', 'bridleway', 'steps']),
] satisfies ExpressionSpecification;
const service = ['==', ['get', 'class'], 'service'] satisfies ExpressionSpecification;

/** The only classification decision. More specific cases must come first. */
const ROAD_KIND = [
  'case',
  ['all', ['==', ['get', 'class'], 'path'], ['==', ['get', 'subclass'], 'cycleway']], 'cycleway',
  ['all',
    oneOf('class', ['primary', 'secondary', 'tertiary', 'minor']),
    oneOf('bicycle', ['yes', 'designated']),
  ], 'designated-cycle-road',
  ['all', track, paved], 'paved-track',
  ['all', track, uncertain], 'uncertain-track',
  ['all', path, paved], 'paved-path',
  ['all', path, uncertain], 'uncertain-path',
  ['all', service, paved], 'paved-service',
  ['all', service, ['==', ['get', 'surface'], 'unpaved']], 'unpaved-service',
  ['get', 'class'],
] satisfies ExpressionSpecification;

const ROAD_STYLES: Record<RoadKind, RoadStyle> = {
  cycleway: {
    line: road('#e94db5', 2),
    casing: road('#b83380', 3.5),
    sortKey: 100,
    legend: 'Cyklostezka',
  },
  'designated-cycle-road': {
    line: dashed('#e94db5', 1.8, 10, [3, 2]),
    sortKey: 90,
    legend: 'Silnice vhodná pro cyklisty',
  },
  'paved-track': {
    line: road('#9da3a8', 2.1, 1, 12),
    casing: road('#8f6a46', 4.1, 0.85, 12),
    sortKey: 80,
    legend: 'Zpevněná lesní / polní cesta',
  },
  'uncertain-track': {
    line: dashed('#b88655', 1.2),
    casing: road('#f0e2cf', 3.2, 0.9, 14),
    sortKey: 70,
    legend: 'Nezpevněná lesní / polní cesta',
  },
  'paved-path': {
    line: road('#d4d8dc', 1.8, 1, 12),
    sortKey: 75,
    legend: 'Zpevněná pěšina',
  },
  'uncertain-path': {
    line: dashed('#d0a477', 0.8),
    casing: road('#f0e2cf', 2.8, 0.85, 14),
    sortKey: 70,
    legend: 'Nejistá pěšina',
  },
  'paved-service': {
    line: road('#c7cdd1', 1.5, 1, 12), sortKey: 60, legend: 'Zpevněná obslužná cesta',
  },
  'unpaved-service': {
    line: dashed('#c49a70', 1),
    casing: road('#f0e2cf', 3, 0.85, 14),
    sortKey: 60,
    legend: 'Nezpevněná obslužná cesta',
  },
  motorway: { line: road('#ffffff', 8, 0.28), sortKey: 10 },
  trunk: { line: road('#f7f7f7', 10, 0.35), sortKey: 10 },
  primary: { line: road('#f4f4f2', 15, 0.4), sortKey: 20 },
  secondary: {
    line: road('#d2d2d2', 10, 0.8), sortKey: 30, legend: 'Silnice II. třídy',
  },
  tertiary: {
    line: road('#d9d9d6', 2.5, 0.8), sortKey: 40, legend: 'Silnice III. třídy',
  },
  minor: { line: road('#f5f5f2', 1.8, 0.9), sortKey: 50 },
  service: { line: road('#f2f1ed', 2, 0.9), sortKey: 60 },
  track: { line: dashed('#c9a77d', 1.2), sortKey: 60 },
  path: { line: dashed('#c9a77d', 0.8), sortKey: 60 },
};

export const CYCLE_ROUTE_STYLES: readonly CycleRouteStyle[] = [
  {
    id: 'cycleroutes-ncn',
    network: 'ncn',
    label: 'Národní cyklotrasa',
    color: '#e53e3e',
    width: 2.5,
  },
  {
    id: 'cycleroutes-rcn',
    network: 'rcn',
    label: 'Regionální cyklotrasa',
    color: '#2b6cb0',
    width: 2,
  },
  {
    id: 'cycleroutes-lcn',
    network: 'lcn',
    label: 'Lokální cyklotrasa',
    color: '#38a169',
    width: 1.5,
  },
  {
    id: 'cycleroutes-other',
    network: 'other',
    label: 'Ostatní cyklotrasa',
    color: '#a0aec0',
    width: 1.2,
  },
];

export interface RoadLegendItem {
  label: string;
  line: StrokeStyle;
  casing?: StrokeStyle;
}

export const ROAD_LEGEND: readonly RoadLegendItem[] = Object.values(ROAD_STYLES)
  .filter((style): style is RoadStyle & { legend: string } => style.legend !== undefined)
  .map((style) => ({ label: style.legend, line: style.line, casing: style.casing }));

export function buildMapLegend(): string {
  const roadItems = ROAD_LEGEND.map(({ label, line, casing }) => {
    const style = [
      `--legend-line:${line.color}`,
      `--legend-width:${Math.max(line.widthAtZ14, 1)}px`,
      `--legend-casing:${casing?.color ?? 'transparent'}`,
      `--legend-casing-width:${casing ? Math.max(casing.widthAtZ14, 2) : 0}px`,
      `--legend-dash:${line.dash ? '1' : '0'}`,
    ].join(';');
    return `
    <div class="map-legend-item">
      <span class="map-legend-swatch" style="${style}"></span>
      <span>${label}</span>
    </div>`;
  }).join('');
  const routeItems = CYCLE_ROUTE_STYLES.map(({ label, color, width }) => {
    const style = `--legend-line:${color};--legend-width:${width}px`;
    return `
    <div class="map-legend-item">
      <span class="map-legend-route" style="${style}"></span>
      <span>${label}</span>
    </div>`;
  }).join('');
  return [
    '<span class="map-legend"><strong>Legenda</strong>',
    roadItems,
    '<span class="map-legend-heading">Cyklotrasy</span>',
    routeItems,
    '</span>',
  ].join('');
}

const BASE_ROAD_LAYERS = [
  'road_cycleway-case', 'road_cycleway', 'road_cycleway-combined',
  'road_path', 'road_minor', 'road_trunk_primary',
  'road_secondary_tertiary', 'road_major_motorway',
] as const;

function zoomWidth(select: (style: RoadStyle) => StrokeStyle | undefined): ExpressionSpecification {
  const widthAt = (scale: number) => styleMatch(
    (style) => (select(style)?.widthAtZ14 ?? 0) * scale,
    0,
  );
  return [
    'interpolate', ['exponential', 1.4], ['zoom'],
    10, widthAt(0.25),
    12, widthAt(0.5),
    14, widthAt(1),
    16, widthAt(1.7),
    18, widthAt(2.8),
    20, widthAt(4.5),
  ];
}

function zoomOpacity(
  select: (style: RoadStyle) => StrokeStyle | undefined,
): ExpressionSpecification {
  const opacityAt = (zoom: number) => styleMatch((style) => {
    const stroke = select(style);
    return stroke && (stroke.minZoom === undefined || stroke.minZoom <= zoom)
      ? stroke.opacity ?? 1
      : 0;
  }, 0);
  return [
    'interpolate', ['linear'], ['zoom'],
    10, opacityAt(10), 12, opacityAt(12), 14, opacityAt(14), 16, opacityAt(16),
  ];
}

function dash(style: StrokeStyle): ExpressionSpecification {
  return ['literal', style.dash ?? [1, 0]];
}

function styleMatch(
  select: (style: RoadStyle) => ExpressionValue,
  fallback: ExpressionValue,
): ExpressionSpecification {
  const entries = (Object.keys(ROAD_STYLES) as RoadKind[])
    .map((kind): [RoadKind, ExpressionValue] => [kind, select(ROAD_STYLES[kind])]);
  const [first, ...rest] = entries;
  if (!first) throw new Error('ROAD_STYLES must not be empty');
  return [
    'match', ROAD_KIND, first[0], first[1], ...rest.flat(), fallback,
  ] as ExpressionSpecification;
}

export function hideBaseRoadLayers(map: maplibregl.Map): void {
  BASE_ROAD_LAYERS.forEach((id) => {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
  });
}

export function buildRoadLayers(): maplibregl.LineLayerSpecification[] {
  const filter = [
    'all', ['==', '$type', 'LineString'], ['in', 'class', ...ROAD_CLASSES],
  ] as maplibregl.FilterSpecification;
  const line = (select: (style: StrokeStyle) => ExpressionValue, fallback: ExpressionValue) => (
    styleMatch((style) => select(style.line), fallback)
  );
  const casing = (
    select: (style: StrokeStyle | undefined) => ExpressionValue,
    fallback: ExpressionValue,
  ) => (
    styleMatch((style) => select(style.casing), fallback)
  );

  const lineColor = line((style) => style.color, 'rgba(0, 0, 0, 0)');
  const lineWidth = zoomWidth((style) => style.line);
  const lineOpacity = zoomOpacity((style) => style.line);
  const lineDash = line(dash, ['literal', [1, 0]]);
  const casingColor = casing(
    (style) => style?.color ?? 'rgba(0, 0, 0, 0)',
    'rgba(0, 0, 0, 0)',
  );
  const casingWidth = zoomWidth((style) => style.casing);
  const casingOpacity = zoomOpacity((style) => style.casing);

  const shared = {
    type: 'line' as const,
    source: 'openmaptiles',
    'source-layer': 'transportation',
    minzoom: 5,
    filter,
    layout: { 'line-cap': 'round' as const, 'line-join': 'round' as const },
  };

  return [
    {
      ...shared,
      id: 'cycling-road-casing',
      paint: {
        'line-color': casingColor,
        'line-width': casingWidth,
        'line-opacity': casingOpacity,
      },
    },
    {
      ...shared,
      id: 'cycling-road-line',
      layout: {
        ...shared.layout,
        'line-sort-key': styleMatch((style) => style.sortKey, 0),
      },
      paint: {
        'line-color': lineColor,
        'line-width': lineWidth,
        'line-opacity': lineOpacity,
        'line-dasharray': lineDash,
      },
    },
  ];
}
