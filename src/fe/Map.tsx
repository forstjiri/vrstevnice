import {
  onMount, onCleanup, createEffect, createSignal, Show, untrack,
} from 'solid-js';
import { Portal } from 'solid-js/web';
import * as maplibregl from 'maplibre-gl';
import type { Feature, FeatureCollection, LineString } from 'geojson';
import type {
  RoadRatingAggregate,
  JsonValue,
  OSMRoadWay,
} from '@vrstevnice/shared';
import {
  connectedRoadWayGroup,
  haversineMeters,
  computeGeometryDistances,
  findPositionAtDistance,
  parseLocalDateTime,
  formatLocalDateTime,
} from '@vrstevnice/shared';
import mlcontour from 'maplibre-contour';
import SunCalc from 'suncalc';
import { Badge } from '@kobalte/core/badge';
import { ToggleButton } from '@kobalte/core/toggle-button';
import {
  planner, addStop, updateStop, setStops, loading, regenerateRoute,
} from './appStore';
import { mapCamera, setMapCamera } from './cameraStore';
import { hoveredPoint } from './hoverStore';
import {
  rideAnimation,
  updateRideAnimation,
  cameraTarget,
} from './rideAnimationStore';
import {
  createStopMarker, createPoiMarker, stopColor, buildContextMenu,
} from './map-markers';
import {
  mapControls,
  mapControlActions,
  effectiveSunDateTime,
  shadowRouteActive,
} from './mapControlsStore';
import {
  buildMapLegend,
  buildRoadLayers,
  CYCLE_ROUTE_STYLES,
  HIKING_TRAIL_COLORS,
  hideBaseRoadLayers,
  type HikingTrailColor,
} from './road-styles';
import forestNoise1 from './assets/forest-noise-1.svg?url';
import forestNoise2 from './assets/forest-noise-2.svg?url';
import forestNoise3 from './assets/forest-noise-3.svg?url';
import forestNoise4 from './assets/forest-noise-4.svg?url';
import RoadRatingModal from './RoadRatingModal';
import {
  fetchRoadRatingByWayId,
  fetchRoadRatingRoads,
  fetchRoadRatings,
  openRoadRatingModal,
  roadRatingMode,
  setRoadRatingMode,
  roadRatingRevision,
} from './roadRatingsStore';

const maplibreWorkerUrl = new URL('maplibre-gl/dist/maplibre-gl-worker.mjs', import.meta.url);
maplibregl.setWorkerUrl(maplibreWorkerUrl.href);

// Tileserver paths are proxied by Vite in dev and served through Caddy in prod.
const TILESERVER_URL = '';

// ── Contour line setup (module-level, before any Map instance) ──
// Relative URL — works in dev (Vite proxy origin) and prod (same-origin via BE)
const demSource = new mlcontour.DemSource({
  url: '/api/terrain/{z}/{x}/{y}',
  encoding: 'terrarium',
  maxzoom: 14,
  worker: false,
});
demSource.setupMaplibre(maplibregl);

const contourTileUrl = demSource.contourProtocolUrl({
  thresholds: {
    8: [50, 200],
    10: [20, 100],
    12: [10, 50],
    14: [5, 20],
  },
  elevationKey: 'ele',
  levelKey: 'level',
  contourLayer: 'contours',
});

const ROAD_RATING_SUBTYPE_ICONS: Record<keyof RoadRatingAggregate['counts']['subtypes'], string> = {
  nice: '✨', safe: '🛡️', fast: '⚡', dangerous: '⚠️', unpassable: '🚫', bad_terrain: '🌧️',
};

/**
 * Find bearing at a given distance along route geometry.
 * Uses the segment the point is on to determine direction.
 */
/**
 * Upsert a GeoJSON source + layer on the map. If source exists, update data only.
 */
function upsertGeoJSON(
  map: maplibregl.Map,
  sourceId: string,
  data: Feature,
  layerSpec:
    | Omit<maplibregl.LineLayerSpecification, 'source'>
    | Omit<maplibregl.CircleLayerSpecification, 'source'>,
): void {
  if (map.getSource(sourceId)) {
    (map.getSource(sourceId) as maplibregl.GeoJSONSource).setData(data);
  } else {
    map.addSource(sourceId, { type: 'geojson', data });
    map.addLayer({ ...layerSpec, source: sourceId });
  }
}

type PaintUpdate = readonly [
  keyof maplibregl.AllPaintProperties,
  maplibregl.AllPaintProperties[keyof maplibregl.AllPaintProperties],
];

function setPaintProperties(
  map: maplibregl.Map,
  layerId: string,
  properties: readonly PaintUpdate[],
): void {
  properties.forEach(([name, value]) => {
    try {
      map.setPaintProperty(
        layerId,
        name,
        value,
      );
    } catch {}
  });
}

/**
 * Remove a MapLibre source and its layer. No-op if source doesn't exist.
 */
function removeMapSource(map: maplibregl.Map, sourceId: string, layerId?: string) {
  if (!map.getSource(sourceId)) return;
  if (layerId && map.getLayer(layerId)) map.removeLayer(layerId);
  map.removeSource(sourceId);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function rgba(r: number, g: number, b: number, a: number): string {
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a.toFixed(3)})`;
}

function hillshadeNightMix(date: Date, sunrise: Date | null, sunset: Date | null): number {
  if (!sunrise || !sunset) return 0.35;

  const hour = 60 * 60 * 1000;
  const t = date.getTime();
  const sunriseStart = sunrise.getTime() - hour;
  const sunriseEnd = sunrise.getTime() + hour;
  const sunsetStart = sunset.getTime() - hour;
  const sunsetEnd = sunset.getTime() + hour;

  if (t < sunriseStart) return 1;
  if (t < sunriseEnd) return 1 - smoothstep(sunriseStart, sunriseEnd, t);
  if (t < sunsetStart) return 0;
  if (t < sunsetEnd) return smoothstep(sunsetStart, sunsetEnd, t);
  return 1;
}

function hillshadeVisibilityFactor(date: Date, sunrise: Date | null, sunset: Date | null): number {
  if (!sunrise || !sunset) return 1;

  const hour = 60 * 60 * 1000;
  const t = date.getTime();
  const sunriseStart = sunrise.getTime() - hour;
  const sunriseEnd = sunrise.getTime() + hour;
  const sunsetStart = sunset.getTime() - hour;
  const sunsetEnd = sunset.getTime() + hour;

  if (t < sunriseStart) return 0;
  if (t < sunriseEnd) return smoothstep(sunriseStart, sunriseEnd, t);
  if (t < sunsetStart) return 1;
  if (t < sunsetEnd) return 1 - smoothstep(sunsetStart, sunsetEnd, t);
  return 0;
}

function getHillshadePaint(
  intensity: number,
  daylightFactor: number,
  azimuth: number,
  altitude: number,
): PaintUpdate[] {
  return [
    ['hillshade-illumination-direction', azimuth],
    ['hillshade-illumination-altitude', clamp(altitude, 5, 70)],
    ['hillshade-illumination-anchor', 'map'],
    ['hillshade-exaggeration', intensity * (0.4 + daylightFactor * 0.6)],
    ['hillshade-shadow-color', rgba(0, 0, 0, 0.35 * daylightFactor + 0.08)],
    ['hillshade-highlight-color', rgba(255, 255, 255, 0.22 * daylightFactor + 0.03)],
    ['hillshade-accent-color', rgba(90, 90, 90, 0.2 * daylightFactor + 0.04)],
  ] satisfies PaintUpdate[];
}

// ── Hiking trails (KČT) + guideposts ──────────────────────────────────────
// Vector tiles are fetched for the visible map area; layers are added once,
// and later toggles only flip layer visibility.

const HIKING_LAYER_IDS = [
  'hiking-routes', 'hiking-guideposts', 'hiking-guideposts-labels',
] as const;
const HIKING_TRAIL_COLOR_MATCH = [
  'match',
  ['get', 'colour'],
  'red', HIKING_TRAIL_COLORS.red,
  'blue', HIKING_TRAIL_COLORS.blue,
  'green', HIKING_TRAIL_COLORS.green,
  'yellow', HIKING_TRAIL_COLORS.yellow,
  '#ff8c00',
] satisfies maplibregl.ExpressionSpecification;

let hikingLayersReady = false;
let hikingPopup: maplibregl.Popup | null = null;
let hikingLoadGeneration = 0;

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function ensureHikingLayers(m: maplibregl.Map): void {
  if (hikingLayersReady) return;

  // KČT trails: SOLID lines (no dasharray) in the marking colour.
  m.addLayer(
    {
      id: 'hiking-routes',
      type: 'line',
      source: 'routes-overlay',
      'source-layer': 'hikingroutes',
      minzoom: 9,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': HIKING_TRAIL_COLOR_MATCH,
        'line-width': [
          'interpolate', ['linear'], ['zoom'],
          10, 1.6,
          13, 2.4,
          16, 4,
        ],
        'line-opacity': 0.9,
      },
    },
    'road_major_label',
  );

  m.addLayer(
    {
      id: 'hiking-guideposts',
      type: 'circle',
      source: 'routes-overlay',
      'source-layer': 'guideposts',
      minzoom: 13,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 3, 16, 5.5],
        'circle-color': '#ffffff',
        'circle-stroke-color': '#4a4a4a',
        'circle-stroke-width': 1.2,
      },
    },
    'road_major_label',
  );

  m.addLayer(
    {
      id: 'hiking-guideposts-labels',
      type: 'symbol',
      source: 'routes-overlay',
      'source-layer': 'guideposts',
      minzoom: 15,
      layout: {
        'text-field': ['coalesce', ['get', 'name'], 'Rozcestník'],
        'text-size': 11,
        'text-offset': [0, 1.1],
        'text-anchor': 'top',
      },
      paint: {
        'text-color': '#333333',
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.5,
      },
    },
    'road_major_label',
  );

  hikingLayersReady = true;
}

function setHikingLayersVisibility(m: maplibregl.Map, visible: boolean): void {
  HIKING_LAYER_IDS.forEach((id) => {
    if (m.getLayer(id)) m.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  });
}

function waitForMapRender(m: maplibregl.Map): Promise<void> {
  return new Promise((resolve) => {
    let timeout: number;
    const onRender = () => {
      window.clearTimeout(timeout);
      resolve();
    };
    timeout = window.setTimeout(() => {
      m.off('render', onRender);
      resolve();
    }, 2000);
    m.once('render', onRender);
    m.triggerRepaint();
  });
}

/**
 * Build a context menu from a declarative items list.
 */
export default function Map() {
  const route = () => planner.route;
  const stops = () => planner.stops;
  let container!: HTMLDivElement;
  let map: maplibregl.Map | undefined;
  const [mapReady, setMapReady] = createSignal(false);
  const [webglFailed, setWebglFailed] = createSignal(false);
  const stopMarkers: maplibregl.Marker[] = [];
  let poiMarkers: maplibregl.Marker[] = [];
  let geometryDistances: number[] | null = null;
  let contextMenu: HTMLDivElement | null = null;
  let duskOverlay: HTMLDivElement | null = null;
  let firstRoute = !route();
  let routeBounds: maplibregl.LngLatBounds | null = null;
  let contoursReady = false;
  let userLocation: [number, number] | null = null;
  const [mapZoom, setMapZoom] = createSignal(7);
  const [hikingLoading, setHikingLoading] = createSignal(false);
  const [inspectMode, setInspectMode] = createSignal(false);
  const [inspectInfo, setInspectInfo] = createSignal<{
    layerId: string;
    sourceLayer?: string;
    lng: string;
    lat: string;
    zoom: string;
    osmId?: { type: 'node' | 'way'; id: number };
    properties: Record<string, JsonValue>;
  } | null>(null);
  let sunDateTime = formatLocalDateTime(new Date());
  const MIN_TERRAIN_ZOOM = 10;
  let destroyed = false;
  let updateHillshadeLightingLocal: (() => void) | null = null;
  const [topRightSlot, setTopRightSlot] = createSignal<HTMLDivElement | null>(null);
  let roadRatingMarkers: maplibregl.Marker[] = [];
  let roadRatingsRequest = 0;
  let roadRatingRoadsRequest = 0;
  let roadRatingRoads: FeatureCollection<LineString, { osm_id: number; name: string | null }> = {
    type: 'FeatureCollection', features: [],
  };
  let roadRatingsTimer: ReturnType<typeof setTimeout> | null = null;
  let roadRatingSelectionRequest = 0;
  let lastRoadRatingHit: maplibregl.GeoJSONFeature | null = null;
  let lastRoadRatingHoverWayId: number | null = null;
  let roadRatingBubbleHoverWayId: number | null = null;
  let lastRoadRatingProcessedPoint: { x: number; y: number } | null = null;

  function pointToSegmentDistance(
    point: { x: number; y: number },
    start: { x: number; y: number },
    end: { x: number; y: number },
  ): number {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y);
    const progress = Math.max(0, Math.min(1, (
      (point.x - start.x) * dx + (point.y - start.y) * dy
    ) / lengthSquared));
    return Math.hypot(point.x - (start.x + progress * dx), point.y - (start.y + progress * dy));
  }

  function roadRatingLineDistance(
    m: maplibregl.Map,
    point: { x: number; y: number },
    coordinates: number[][],
  ): number {
    let closest = Infinity;
    for (let index = 1; index < coordinates.length; index += 1) {
      const start = m.project(coordinates[index - 1] as [number, number]);
      const end = m.project(coordinates[index] as [number, number]);
      closest = Math.min(closest, pointToSegmentDistance(point, start, end));
    }
    return closest;
  }

  function closestRoadRatingLine(
    m: maplibregl.Map,
    point: { x: number; y: number },
    feature: maplibregl.GeoJSONFeature,
  ): number[][] | null {
    if (feature.geometry?.type === 'LineString') {
      return feature.geometry.coordinates;
    }
    if (feature.geometry?.type === 'MultiLineString') {
      return feature.geometry.coordinates.reduce<number[][] | null>((closest, line) => (
        !closest || roadRatingLineDistance(m, point, line)
          < roadRatingLineDistance(m, point, closest)
          ? line
          : closest
      ), null);
    }
    return null;
  }

  function roadRatingFeatureDistance(
    m: maplibregl.Map,
    point: { x: number; y: number },
    feature: maplibregl.GeoJSONFeature,
  ): number {
    const line = closestRoadRatingLine(m, point, feature);
    return line ? roadRatingLineDistance(m, point, line) : Infinity;
  }

  function roadRatingOsmWayId(feature: maplibregl.GeoJSONFeature): number | null {
    const osmId = feature.properties?.osm_id;
    return typeof osmId === 'number' && Number.isSafeInteger(osmId) ? osmId : null;
  }

  function roadRatingFeatureGroup(wayId: number): FeatureCollection<LineString, {
    osm_id: number; name: string | null;
  }> {
    const ways: OSMRoadWay[] = roadRatingRoads.features.map((feature) => ({
      osmId: feature.properties.osm_id,
      name: feature.properties.name,
      coordinates: feature.geometry.coordinates as [number, number][],
    }));
    const groupIds = new Set(
      connectedRoadWayGroup(wayId, ways).map((way) => way.osmId),
    );
    return {
      type: 'FeatureCollection',
      features: roadRatingRoads.features.filter(
        (feature) => groupIds.has(feature.properties.osm_id),
      ),
    };
  }

  function findRoadRatingFeature(
    m: maplibregl.Map,
    point: { x: number; y: number },
  ): maplibregl.GeoJSONFeature | null {
    // Keep a generous target at ordinary zoom levels; detailed roads remain
    // precise enough at z18 while still accepting a small off-centre pointer.
    const hitDistance = m.getZoom() >= 18 ? 12 : 18;
    if (lastRoadRatingHit
      && roadRatingFeatureDistance(m, point, lastRoadRatingHit) <= hitDistance) {
      return lastRoadRatingHit;
    }
    // Candidate retrieval must use a box query, not a point query: point hit-testing
    // only reaches features within their rendered line buffers. The transparent
    // hit layer below supplies a stable, minimum-width buffer for narrow roads.
    const queryBox: [maplibregl.PointLike, maplibregl.PointLike] = [
      { x: point.x - hitDistance, y: point.y - hitDistance } as maplibregl.PointLike,
      { x: point.x + hitDistance, y: point.y + hitDistance } as maplibregl.PointLike,
    ];
    const candidates = m.queryRenderedFeatures(queryBox, {
      layers: ['road-rating-hit-target'],
    }).filter((candidate) => (
      (candidate.geometry?.type === 'LineString'
        || candidate.geometry?.type === 'MultiLineString')
      && roadRatingOsmWayId(candidate) !== null
    ));
    const nearest = candidates.reduce<{
      feature: maplibregl.GeoJSONFeature | null;
      distance: number;
    }>(
      (result, candidate) => {
        const distance = roadRatingFeatureDistance(m, point, candidate);
        return distance < result.distance ? { feature: candidate, distance } : result;
      },
      { feature: null, distance: Infinity },
    );
    lastRoadRatingHit = nearest.distance <= hitDistance ? nearest.feature : null;
    return lastRoadRatingHit;
  }

  function setRoadRatingHover(
    m: maplibregl.Map,
    feature: maplibregl.GeoJSONFeature,
  ) {
    const wayId = roadRatingOsmWayId(feature);
    if (wayId === null) return;
    setRoadRatingHoverWay(m, wayId);
  }

  function setRoadRatingHoverWay(m: maplibregl.Map, wayId: number) {
    if (lastRoadRatingHoverWayId !== wayId) {
      const source = m.getSource('road-rating-hover-geometry') as maplibregl.GeoJSONSource;
      if (source) source.setData(roadRatingFeatureGroup(wayId));
      if (m.getLayer('road_major_label')) {
        // Cycleroutes and hillshade are added later than the hover layers. Keep
        // the selected road above those visual overlays, but below its label.
        if (m.getLayer('road-rating-hover-halo')) {
          m.moveLayer('road-rating-hover-halo', 'road_major_label');
        }
        if (m.getLayer('road-rating-hover')) {
          m.moveLayer('road-rating-hover', 'road_major_label');
        }
      }
      lastRoadRatingHoverWayId = wayId;
    }
  }

  function clearRoadRatingHover(m: maplibregl.Map) {
    const source = m.getSource('road-rating-hover-geometry') as maplibregl.GeoJSONSource;
    if (source) source.setData({ type: 'FeatureCollection', features: [] });
    lastRoadRatingHit = null;
    lastRoadRatingHoverWayId = null;
    lastRoadRatingProcessedPoint = null;
    const canvas = m.getCanvas();
    canvas.style.cursor = '';
  }

  function clearRoadRatingBubbles() {
    roadRatingsRequest += 1;
    if (roadRatingsTimer) {
      clearTimeout(roadRatingsTimer);
      roadRatingsTimer = null;
    }
    roadRatingMarkers.forEach((marker) => marker.remove());
    roadRatingMarkers = [];
  }

  function openAggregateRating(aggregate: RoadRatingAggregate) {
    roadRatingSelectionRequest += 1;
    openRoadRatingModal({
      wayId: aggregate.wayId,
      name: aggregate.name,
      type: aggregate.type,
      counts: aggregate.counts,
      commentsCount: aggregate.commentsCount,
      mine: aggregate.mine,
    });
  }

  function renderRoadRatingBubbles(m: maplibregl.Map, aggregates: RoadRatingAggregate[]) {
    roadRatingMarkers.forEach((marker) => marker.remove());
    roadRatingMarkers = aggregates.map((aggregate) => {
      const element = document.createElement('button');
      element.type = 'button';
      element.className = 'road-rating-bubble';
      element.setAttribute('aria-label', `Hodnocení: ${aggregate.name ?? 'Vybraná cesta'}`);
      const subtypeLine = Object.entries(aggregate.counts.subtypes)
        .filter(([, count]) => count > 0)
        .map(([subtype, count]) => (
          `${ROAD_RATING_SUBTYPE_ICONS[
            subtype as keyof typeof ROAD_RATING_SUBTYPE_ICONS
          ]} ${count}`
        ))
        .join(' · ');
      const countLine = `<span>👍 ${aggregate.counts.prefer} · 👎 ${aggregate.counts.demote}</span>`;
      element.innerHTML = `${countLine}${
        subtypeLine ? `<small>${subtypeLine}</small>` : ''
      }`;
      element.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        openAggregateRating(aggregate);
      });
      element.addEventListener('mouseenter', () => {
        roadRatingBubbleHoverWayId = aggregate.wayId;
        setRoadRatingHoverWay(m, aggregate.wayId);
      });
      element.addEventListener('mouseleave', () => {
        roadRatingBubbleHoverWayId = null;
        clearRoadRatingHover(m);
      });
      return new maplibregl.Marker({ element, anchor: 'bottom' })
        .setLngLat([aggregate.lng, aggregate.lat])
        .addTo(m);
    });
  }

  function loadRoadRatingBubbles(m: maplibregl.Map) {
    if (!roadRatingMode() || m.getZoom() < 12 || destroyed) {
      clearRoadRatingBubbles();
      return;
    }
    roadRatingsRequest += 1;
    const request = roadRatingsRequest;
    const bounds = m.getBounds();
    fetchRoadRatings({
      minLng: bounds.getWest(),
      minLat: bounds.getSouth(),
      maxLng: bounds.getEast(),
      maxLat: bounds.getNorth(),
    }).then((aggregates) => {
      if (destroyed || request !== roadRatingsRequest || !roadRatingMode()
        || m.getZoom() < 12) return;
      renderRoadRatingBubbles(m, aggregates);
    }).catch(() => {
      if (request === roadRatingsRequest) clearRoadRatingBubbles();
    });
  }

  function loadRoadRatingRoads(m: maplibregl.Map) {
    if (!roadRatingMode() || m.getZoom() < 11 || destroyed) return;
    roadRatingRoadsRequest += 1;
    const request = roadRatingRoadsRequest;
    const bounds = m.getBounds();
    fetchRoadRatingRoads({
      minLng: bounds.getWest(),
      minLat: bounds.getSouth(),
      maxLng: bounds.getEast(),
      maxLat: bounds.getNorth(),
    }).then((roads) => {
      if (destroyed || request !== roadRatingRoadsRequest || !roadRatingMode()) return;
      const source = m.getSource('road-rating-roads') as maplibregl.GeoJSONSource;
      if (source) source.setData(roads);
      roadRatingRoads = roads;
    }).catch(() => {
      // An empty source is safer than stale geometry after a failed viewport request.
      if (destroyed || request !== roadRatingRoadsRequest) return;
      const source = m.getSource('road-rating-roads') as maplibregl.GeoJSONSource;
      if (source) source.setData({ type: 'FeatureCollection', features: [] });
      roadRatingRoads = { type: 'FeatureCollection', features: [] };
    });
  }

  function debounceRoadRatingBubbles(m: maplibregl.Map) {
    if (roadRatingsTimer) clearTimeout(roadRatingsTimer);
    roadRatingsTimer = setTimeout(() => {
      roadRatingsTimer = null;
      loadRoadRatingRoads(m);
      loadRoadRatingBubbles(m);
    }, 180);
  }

  function syncDynamicLayers(m: maplibregl.Map) {
    try {
      // Style may still be loading right after the map 'load' event — retry
      // once idle instead of silently dropping the sync (e.g. persisted
      // terrainOn after page reload would never activate 3D).
      if (!m.isStyleLoaded()) {
        m.once('idle', () => {
          if (map === m) syncDynamicLayers(m);
        });
        return;
      }
      const terrainVisible = mapControls.terrainOn && m.getZoom() >= MIN_TERRAIN_ZOOM;
      if (terrainVisible) {
        m.setTerrain({
          source: 'terrain-dem',
          exaggeration: mapControls.terrainExaggeration,
        });
        // Allow tilting again (MapLibre default max pitch is 60)
        if (m.getMaxPitch() === 0) m.setMaxPitch(60);
      } else {
        m.setTerrain(null);
        // Disable tilting while 3D terrain is off — map stays top-down
        m.setMaxPitch(0);
        if (m.getPitch() > 0) m.easeTo({ pitch: 0, duration: 150 });
      }

      if (m.getLayer('hillshade')) {
        m.setLayoutProperty(
          'hillshade',
          'visibility',
          mapControls.hillshadeOn && terrainVisible ? 'visible' : 'none',
        );
      }

      const contoursVisible = mapControls.contoursOn && contoursReady;
      if (m.getLayer('contour-lines')) {
        m.setLayoutProperty('contour-lines', 'visibility', contoursVisible ? 'visible' : 'none');
      }
      if (m.getLayer('contour-labels')) {
        m.setLayoutProperty('contour-labels', 'visibility', contoursVisible ? 'visible' : 'none');
      }
    } catch {}
  }

  function refreshHillshade() {
    if (!map || !updateHillshadeLightingLocal) return;
    const run = () => {
      if (!map || !updateHillshadeLightingLocal) return;
      updateHillshadeLightingLocal();
    };

    if (map.isStyleLoaded()) {
      requestAnimationFrame(() => requestAnimationFrame(run));
    } else {
      map.once('idle', run);
    }
  }

  function removeContextMenu() {
    contextMenu?.remove();
    contextMenu = null;
  }

  function showContextMenu(
    m: maplibregl.Map,
    lngLat: maplibregl.LngLat,
    point: { x: number; y: number },
  ) {
    removeContextMenu();
    contextMenu = buildContextMenu([
      {
        label: 'Přidat zastávku',
        action: () => {
          const fallback = `${lngLat.lat.toFixed(5)}, ${lngLat.lng.toFixed(5)}`;
          addStop({ lat: lngLat.lat, lng: lngLat.lng, name: fallback });
          fetch(`/api/geocode?q=${encodeURIComponent(`${lngLat.lat},${lngLat.lng}`)}`)
            .then((response) => response.json() as Promise<{ name?: string }[]>)
            .then((results) => {
              const name = results[0]?.name;
              if (name) {
                setStops(planner.stops.map((stop) => (
                  stop.lat === lngLat.lat && stop.lng === lngLat.lng
                    ? { ...stop, name: `${fallback} - ${name}` }
                    : stop
                )));
              }
            })
            .catch(() => {});
        },
      },
      {
        label: 'Otevřít na Mapy.cz',
        action: () => window.open(
          `https://en.mapy.cz/turisticka?x=${lngLat.lng.toFixed(6)}&y=${lngLat.lat.toFixed(6)}`
          + '&z=16',
          '_blank',
        ),
      },
      {
        label: 'OpenStreetMap',
        action: () => window.open(
          [
            `https://www.openstreetmap.org/?mlat=${lngLat.lat.toFixed(6)}`,
            `&mlon=${lngLat.lng.toFixed(6)}#map=16/${lngLat.lat.toFixed(6)}/`,
            lngLat.lng.toFixed(6),
          ].join(''),
          '_blank',
        ),
      },
      {
        label: 'Google Maps',
        action: () => window.open(
          `https://www.google.com/maps/@${lngLat.lat.toFixed(7)},${lngLat.lng.toFixed(7)},16z`,
          '_blank',
        ),
      },
    ]);
    const mapContainer = m.getContainer();
    const menuW = 180;
    const menuH = contextMenu.offsetHeight || 80;
    const containerRect = mapContainer.getBoundingClientRect();
    let left = Math.min(point.x, containerRect.width - menuW - 8);
    let top = Math.min(point.y, containerRect.height - menuH - 8);
    left = Math.max(8, left);
    top = Math.max(8, top);
    contextMenu.style.left = `${left}px`;
    contextMenu.style.top = `${top}px`;
    mapContainer.appendChild(contextMenu);
  }

  const LONG_PRESS_MS = 500;
  const LONG_PRESS_MOVE_THRESHOLD = 10;
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let longPressStart: { x: number; y: number } | null = null;
  let longPressFired = false;

  function clearLongPress() {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    longPressStart = null;
  }

  function handleTouchStart(e: TouchEvent) {
    if (e.touches.length !== 1) {
      clearLongPress();
      return;
    }
    const t = e.touches[0];
    longPressStart = { x: t.clientX, y: t.clientY };
    longPressFired = false;
    longPressTimer = setTimeout(() => {
      if (!longPressStart) return;
      if (roadRatingMode()) return;
      longPressFired = true;
      const m = map;
      if (!m) return;
      const containerRect = m.getContainer().getBoundingClientRect();
      const point = {
        x: longPressStart.x - containerRect.left,
        y: longPressStart.y - containerRect.top,
      };
      const lngLat = m.unproject(new maplibregl.Point(point.x, point.y));
      showContextMenu(m, lngLat, point);
    }, LONG_PRESS_MS);
  }

  function handleTouchMove(e: TouchEvent) {
    if (!longPressStart || longPressFired) return;
    const t = e.touches[0];
    const dx = Math.abs(t.clientX - longPressStart.x);
    const dy = Math.abs(t.clientY - longPressStart.y);
    if (dx > LONG_PRESS_MOVE_THRESHOLD || dy > LONG_PRESS_MOVE_THRESHOLD) {
      clearLongPress();
    }
  }

  function handleTouchEnd(_e: TouchEvent) {
    clearLongPress();
  }

  onMount(() => {
    try {
      const savedCamera = mapCamera();
      // A stale persisted world-level zoom should not override the initial Czech view.
      const cameraToRestore = savedCamera && savedCamera.zoom >= 3 ? savedCamera : null;
      if (savedCamera && !cameraToRestore) setMapCamera(null);
      map = new maplibregl.Map({
        container,
        style: `${TILESERVER_URL}/styles/basic/style.json?v=2`,
        center: cameraToRestore
          ? [cameraToRestore.lon, cameraToRestore.lat]
          : [15.47, 49.82], // [lng, lat]
        zoom: cameraToRestore?.zoom ?? 7,
        bearing: cameraToRestore?.bearing ?? 0,
        pitch: cameraToRestore?.pitch ?? 0,
        attributionControl: {
          compact: true,
          customAttribution: buildMapLegend(),
        },
      });
    } catch {
      setWebglFailed(true);
      return;
    }

    // TypeScript: map is guaranteed defined after successful construction
    const m = map;
    // Expose the instance before style loading so production failures are diagnosable.
    window.__map = m;

    // WebGL runtime errors (context loss, GPU reset). Tile/source errors also
    // fire 'error' — filter to fatal GPU failures only.
    m.on('error', (e) => {
      const err = (e as { error?: Error }).error;
      const msg = err instanceof Error ? err.message : String(err ?? '');
      if (/webgl|gpu|context.*lost|failed.*render/i.test(msg)) {
        setWebglFailed(true);
      }
    });

    const topRightCorner = m.getContainer().querySelector('.maplibregl-ctrl-top-right');
    if (topRightCorner instanceof HTMLDivElement) {
      const slot = document.createElement('div');
      slot.className = 'map-top-right-slot';
      topRightCorner.prepend(slot);
      setTopRightSlot(slot);
    }

    m.addControl(new maplibregl.NavigationControl());

    const geoLog = (message: string, details?: Record<string, JsonValue | undefined>) => {
      console.info('[vrstevnice/geolocation]', message, details ?? '');
    };
    geoLog('control initialized', {
      secureContext: window.isSecureContext,
      apiAvailable: Boolean(navigator.geolocation),
      userAgent: navigator.userAgent,
    });

    const renderUserLocation = (recenter: boolean) => {
      if (!userLocation) {
        return;
      }

      const source = m.getSource('user-location');
      if (source && 'setData' in source) {
        (source as maplibregl.GeoJSONSource).setData({
          type: 'Feature',
          properties: {},
          geometry: { type: 'Point', coordinates: userLocation },
        });
        geoLog('blue dot updated', { coordinates: userLocation, recenter });
      }
      if (recenter) {
        m.flyTo({
          center: userLocation,
          zoom: Math.max(m.getZoom(), 14),
          duration: 800,
          essential: true,
        });
        geoLog('map recenter requested', {
          center: userLocation,
          zoom: Math.max(m.getZoom(), 14),
        });
      }
    };

    const updateUserLocation = (event: GeolocationPosition) => {
      userLocation = [event.coords.longitude, event.coords.latitude];
      geoLog('position received', {
        coordinates: userLocation,
        accuracy: event.coords.accuracy,
        timestamp: event.timestamp,
      });
      renderUserLocation(true);
    };
    const handleLocationError = (error: GeolocationPositionError) => {
      console.warn('[vrstevnice/geolocation] position failed', {
        code: error.code,
        message: error.message,
      });
    };
    const requestPosition = (highAccuracy: boolean) => {
      navigator.geolocation.getCurrentPosition(
        updateUserLocation,
        (error) => {
          if (highAccuracy && error.code === 2) {
            geoLog('retrying with low accuracy after provider failure');
            requestPosition(false);
          } else {
            handleLocationError(error);
          }
        },
        {
          enableHighAccuracy: highAccuracy,
          maximumAge: highAccuracy ? 10_000 : 60_000,
          timeout: highAccuracy ? 15_000 : 20_000,
        },
      );
    };
    const requestUserLocation = () => {
      geoLog('request started');
      if (!navigator.geolocation) {
        console.warn('[vrstevnice/geolocation] request skipped: API unavailable');
        return;
      }
      navigator.permissions?.query({ name: 'geolocation' }).then((permission) => {
        geoLog('permission state', { state: permission.state });
      }).catch((error) => {
        console.warn('[vrstevnice/geolocation] permission query failed', error);
      });
      requestPosition(true);
    };
    const locationControl: maplibregl.IControl = {
      onAdd: () => {
        const group = document.createElement('div');
        group.className = 'maplibregl-ctrl maplibregl-ctrl-group maplibregl-ctrl-geolocate';
        const button = document.createElement('button');
        button.className = 'maplibregl-ctrl-geolocate';
        button.type = 'button';
        button.title = 'Najít moji polohu';
        button.setAttribute('aria-label', 'Najít moji polohu');
        button.addEventListener('click', requestUserLocation);
        const icon = document.createElement('span');
        icon.className = 'maplibregl-ctrl-icon';
        icon.setAttribute('aria-hidden', 'true');
        button.appendChild(icon);
        group.appendChild(button);
        return group;
      },
      onRemove: () => {},
    };
    m.addControl(locationControl);

    m.on('load', () => {
      // @ts-ignore debug
      window.__map = m;

      m.addSource('routes-overlay', {
        type: 'vector',
        tiles: ['/data/routes-overlay/{z}/{x}/{y}.pbf'],
        minzoom: 9,
        maxzoom: 14,
      });

      // Guidepost popup: name + coloured chips of trails passing through.
      m.on('click', 'hiking-guideposts', (e) => {
        const feature = e.features?.[0];
        if (!feature) return;
        const props = feature.properties as {
          name?: string | null;
          ele?: string | null;
          colours?: string | string[];
        };
        let rawColours: string[] = [];
        if (Array.isArray(props.colours)) rawColours = props.colours;
        else if (typeof props.colours === 'string') {
          try {
            const parsedColours = JSON.parse(props.colours) as string[];
            if (Array.isArray(parsedColours)) rawColours = parsedColours;
          } catch {
            // Ignore malformed feature properties; the popup still shows its name.
          }
        }
        const chips = rawColours
          .filter((colour): colour is HikingTrailColor => colour in HIKING_TRAIL_COLORS)
          .map((colour) => (
            '<span class="guidepost-chip"'
            + ` style="background:${HIKING_TRAIL_COLORS[colour]}"`
            + ` title="${colour}"></span>`
          ))
          .join('');
        const title = props.name ? escapeHtml(props.name) : 'Rozcestník';
        const ele = props.ele ? ` · ${escapeHtml(props.ele)} m n. m.` : '';
        const empty = '<span class="guidepost-chips-empty">bez značení</span>';
        hikingPopup?.remove();
        hikingPopup = new maplibregl.Popup({ closeButton: false, offset: 12 })
          .setLngLat((feature.geometry as GeoJSON.Point).coordinates as [number, number])
          .setHTML(
            `<div class="guidepost-popup"><strong>${title}</strong>${ele}`
            + `<div class="guidepost-chips">${chips || empty}</div></div>`,
          )
          .addTo(m);
      });
      m.on('mouseenter', 'hiking-guideposts', () => {
        m.getCanvas().style.cursor = 'pointer';
      });
      m.on('mouseleave', 'hiking-guideposts', () => {
        m.getCanvas().style.cursor = '';
      });

      m.addSource('user-location', {
        type: 'geojson',
        data: {
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'Point',
            coordinates: userLocation ?? [15.47, 49.82],
          },
        },
      });
      m.addLayer({
        id: 'user-location-circle',
        type: 'circle',
        source: 'user-location',
        filter: ['!=', ['get', 'hidden'], true],
        paint: {
          'circle-radius': 6,
          'circle-color': '#2563eb',
          'circle-opacity': 0.95,
          'circle-stroke-color': '#fff',
          'circle-stroke-width': 2,
        },
      });

      // Darken forests and overlay four static textures without generating pixels on startup.
      if (m.getLayer('landcover_wood')) {
        m.setPaintProperty('landcover_wood', 'fill-color', '#98aa70');
        const textures = [
          { id: 'forest-noise-1', url: forestNoise1, translate: [0, 0] as [number, number] },
          { id: 'forest-noise-2', url: forestNoise2, translate: [17, -11] as [number, number] },
          { id: 'forest-noise-3', url: forestNoise3, translate: [-23, 19] as [number, number] },
          { id: 'forest-noise-4', url: forestNoise4, translate: [31, 7] as [number, number] },
        ];
        Promise.all(textures.map((texture) => new Promise<HTMLImageElement>((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = () => reject(new Error(`Could not load ${texture.id}`));
          image.src = texture.url;
        }))).then((images) => {
          if (destroyed) return;
          textures.forEach((texture, index) => {
            if (!m.hasImage(texture.id)) m.addImage(texture.id, images[index], { pixelRatio: 1 });
            m.addLayer(
              {
                id: texture.id,
                type: 'fill',
                source: 'openmaptiles',
                'source-layer': 'landcover',
                filter: ['==', ['get', 'class'], 'wood'],
                paint: {
                  'fill-pattern': texture.id,
                  'fill-opacity': 0.16,
                  'fill-translate': texture.translate,
                },
              },
              'water',
            );
          });
        }).catch(() => {});
      }
      geoLog('map loaded', {
        styleLoaded: Boolean(m.isStyleLoaded()),
      });
      if (userLocation) {
        renderUserLocation(false);
      } else {
        (m.getSource('user-location') as maplibregl.GeoJSONSource).setData({
          type: 'Feature',
          properties: { hidden: true },
          geometry: { type: 'Point', coordinates: [0, 0] },
        });
      }
      // @ts-ignore debug — used by Stops panel "Přehled trasy" button
      window.__fitRouteOverview = () => {
        if (routeBounds) m.fitBounds(routeBounds, { padding: 50 });
      };

      // ── Cycling-oriented road rendering ──
      try {
        hideBaseRoadLayers(m);
        if (m.getLayer('poi_label')) m.setLayoutProperty('poi_label', 'visibility', 'none');
        buildRoadLayers().forEach((layer) => {
          m.addLayer(layer, 'bridge_minor case');
        });
        // MapLibre's rendered-feature queries respect the line's rendered width.
        // The source contains one exact original OSM way per feature, independent
        // of the display-oriented OpenMapTiles transportation layer.
        m.addSource('road-rating-roads', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });
        m.addLayer({
          id: 'road-rating-hit-target',
          type: 'line',
          source: 'road-rating-roads',
          layout: {
            'line-cap': 'round',
            'line-join': 'round',
            visibility: 'none',
          },
          paint: {
            // The target must remain rendered for queryRenderedFeatures, but
            // must not tint the terrain underneath it.
            'line-color': 'rgba(0, 0, 0, 0)',
            'line-width': ['interpolate', ['linear'], ['zoom'], 10, 36, 18, 24],
          },
        }, 'road_major_label');
        m.addSource('road-rating-hover-geometry', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });
        m.addLayer({
          id: 'road-rating-hover-halo',
          type: 'line',
          source: 'road-rating-hover-geometry',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': '#2563eb',
            'line-width': ['interpolate', ['linear'], ['zoom'], 10, 9, 14, 13, 18, 18],
            'line-opacity': 0.35,
          },
        }, 'road_major_label');
        m.addLayer({
          id: 'road-rating-hover',
          type: 'line',
          source: 'road-rating-hover-geometry',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': '#93c5fd',
            'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3, 14, 5, 18, 8],
            'line-opacity': 1,
          },
        }, 'road_major_label');
        m.addLayer({
          id: 'cycling-poi-label',
          type: 'symbol',
          source: 'openmaptiles',
          'source-layer': 'poi',
          minzoom: 14,
          filter: [
            'all',
            ['==', '$type', 'Point'],
            ['any',
              ['in', 'class',
                'cafe', 'restaurant', 'fast_food', 'bar', 'beer', 'ice_cream',
                'grocery', 'fuel', 'campsite', 'lodging', 'hospital', 'attraction',
                'castle', 'park',
              ],
              ['all', ['==', 'class', 'shop'], ['in', 'subclass', 'bicycle', 'bicycle_repair']],
              ['in', 'subclass', 'drinking_water', 'toilets', 'viewpoint'],
            ],
          ],
          layout: {
            'text-field': ['coalesce', ['get', 'name:latin'], ['get', 'name']],
            'text-font': ['Noto Sans Regular'],
            'text-size': ['interpolate', ['linear'], ['zoom'], 14, 10, 17, 12],
            'text-anchor': 'top',
            'text-offset': [0, 0.5],
            'text-max-width': 8,
            'symbol-sort-key': ['get', 'rank'],
          },
          paint: {
            'text-color': '#53656d',
            'text-halo-color': 'rgba(255, 255, 255, 0.9)',
            'text-halo-width': 1,
            'text-halo-blur': 0.5,
          },
        });
      } catch {}

      // ── Terrain DEM sources ──
      // MapLibre 6+ recommends separate raster-dem sources for terrain vs hillshade
      // to improve rendering quality (avoids the "same source" runtime warning).
      try {
        m.addSource('terrain-dem', {
          type: 'raster-dem',
          tiles: ['/api/terrain/{z}/{x}/{y}'],
          encoding: 'terrarium',
          tileSize: 256,
          maxzoom: 14,
        });
        m.addSource('hillshade-dem', {
          type: 'raster-dem',
          tiles: ['/api/terrain/{z}/{x}/{y}'],
          encoding: 'terrarium',
          tileSize: 256,
          maxzoom: 14,
        });
        m.addLayer(
          {
            id: 'hillshade',
            type: 'hillshade',
            source: 'hillshade-dem',
            layout: {
              visibility: mapControls.hillshadeOn ? 'visible' : 'none',
            },
            paint: {
              'hillshade-method': 'basic',
              'hillshade-shadow-color': 'rgba(0, 0, 0, 0.35)',
              'hillshade-highlight-color': 'rgba(255, 255, 255, 0.22)',
              'hillshade-accent-color': 'rgba(90, 90, 90, 0.2)',
              'hillshade-exaggeration': mapControls.hillshadeIntensity,
              'hillshade-illumination-direction': 315,
              'hillshade-illumination-altitude': 45,
            },
          },
          'road_major_label',
        );

        const updateHillshadeLighting = () => {
          try {
            if (destroyed || !m.getLayer('hillshade') || !m.isStyleLoaded()) return;
            if (!mapControls.hillshadeOn) {
              if (duskOverlay) {
                duskOverlay.style.opacity = '0';
                duskOverlay.style.background = 'transparent';
              }
              return;
            }
            const dt = parseLocalDateTime(sunDateTime) ?? new Date();
            const center = m.getCenter();
            const pos = SunCalc.getPosition(dt, center.lat, center.lng);
            const azimuth = ((pos.azimuth * 180) / Math.PI + 180 + 360) % 360;
            const altitude = (pos.altitude * 180) / Math.PI;
            const times = SunCalc.getTimes(dt, center.lat, center.lng);
            const sunrise = times.sunrise ?? null;
            const sunset = times.sunset ?? null;
            const daylightFactor = hillshadeVisibilityFactor(dt, sunrise, sunset);
            const nightMix = hillshadeNightMix(dt, sunrise, sunset);
            const { hillshadeIntensity } = mapControls;
            const ambientTintFactor = clamp(
              (1 - daylightFactor) * (0.08 + nightMix * 0.22),
              0,
              0.28,
            );

            if (duskOverlay) {
              const overlay = duskOverlay;
              overlay.style.opacity = String(ambientTintFactor);
              overlay.style.background = ambientTintFactor > 0
                ? `linear-gradient(180deg, rgba(10, 20, 64, ${0.1 + nightMix * 0.18}), `
                  + `rgba(2, 8, 28, ${0.08 + nightMix * 0.18}))`
                : 'transparent';
            }

            setPaintProperties(
              m,
              'hillshade',
              getHillshadePaint(hillshadeIntensity, daylightFactor, azimuth, altitude),
            );
          } catch {}
        };

        updateHillshadeLightingLocal = updateHillshadeLighting;

        syncDynamicLayers(m);
        refreshHillshade();
      } catch {}

      // ── Contour lines ──
      // Keep contours and elevation labels below water, buildings and roads.
      try {
        m.addSource('contours', {
          type: 'vector',
          tiles: [contourTileUrl],
          maxzoom: 15,
        });
        m.addLayer(
          {
            id: 'contour-lines',
            type: 'line',
            source: 'contours',
            'source-layer': 'contours',
            paint: {
              'line-color': '#8B7355',
              'line-opacity': 0.5,
              'line-width': ['match', ['get', 'level'], 1, 1, 0.4],
            },
          },
          'water',
        );
        m.addLayer(
          {
            id: 'contour-labels',
            type: 'symbol',
            source: 'contours',
            'source-layer': 'contours',
            filter: ['>', ['get', 'level'], 0],
            layout: {
              'symbol-placement': 'line',
              'text-size': 10,
              'text-field': ['concat', ['number-format', ['get', 'ele'], {}], ' m'],
              'text-max-angle': 25,
            },
            paint: {
              'text-color': '#6B5B3D',
              'text-halo-color': 'rgba(255,255,255,0.8)',
              'text-halo-width': 1,
            },
          },
          'water',
        );
        contoursReady = true;
        syncDynamicLayers(m);
      } catch {}

      // ── Water body names from local vector tiles ──
      m.addLayer({
        id: 'water-body-label',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'water_name',
        minzoom: 8,
        filter: ['==', '$type', 'Point'],
        layout: {
          'text-field': ['coalesce', ['get', 'name:cs'], ['get', 'name'], ['get', 'name:latin']],
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 8, 11, 16, 14],
          'text-max-width': 8,
        },
        paint: {
          'text-color': '#356b8c',
          'text-halo-color': 'rgba(255,255,255,0.85)',
          'text-halo-width': 1,
        },
      }, 'road_major_label');

      // ── Transit: railway lines (visible from z10) ──
      try {
        m.addLayer(
          {
            id: 'cycle-railway',
            type: 'line',
            source: 'openmaptiles',
            'source-layer': 'transportation',
            minzoom: 10,
            filter: ['==', ['get', 'class'], 'rail'],
            paint: {
              'line-color': '#555',
              'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2, 14, 4, 18, 5.5],
              'line-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0.3, 12, 0.6, 14, 1],
              'line-dasharray': [1, 1.5],
            },
          },
          'road_major_label',
        );

        m.addLayer(
          {
            id: 'cycle-railway-transit',
            type: 'line',
            source: 'openmaptiles',
            'source-layer': 'transportation',
            minzoom: 11,
            filter: [
              'all',
              ['==', ['get', 'class'], 'transit'],
              ['!=', ['get', 'brunnel'], 'tunnel'],
            ],
            paint: {
              'line-color': '#777',
              'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1.5, 14, 3, 18, 4.5],
              'line-opacity': ['interpolate', ['linear'], ['zoom'], 11, 0.3, 13, 0.6, 15, 1],
              'line-dasharray': [1, 1.5],
            },
          },
          'road_major_label',
        );

        // ── Train stations ──
        m.addLayer(
          {
            id: 'cycle-train-station',
            type: 'circle',
            source: 'openmaptiles',
            'source-layer': 'poi',
            minzoom: 11,
            filter: ['==', ['get', 'class'], 'railway'],
            paint: {
              'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 4, 14, 6, 18, 8],
              'circle-color': '#d64045',
              'circle-stroke-color': '#fff',
              'circle-stroke-width': 1.5,
            },
          },
          'road_major_label',
        );

        m.addLayer(
          {
            id: 'cycle-train-station-label',
            type: 'symbol',
            source: 'openmaptiles',
            'source-layer': 'poi',
            minzoom: 12,
            filter: ['all', ['==', ['get', 'class'], 'railway'], ['has', 'name:latin']],
            layout: {
              'text-field': '{name:latin}',
              'text-font': ['Noto Sans Regular'],
              'text-size': 10,
              'text-anchor': 'top',
              'text-offset': [0, 0.8],
              'text-max-width': 8,
            },
            paint: {
              'text-color': '#c0392b',
              'text-halo-color': 'rgba(255,255,255,0.9)',
              'text-halo-width': 1.5,
            },
          },
          'road_major_label',
        );

        // ── Bus stops ──
        m.addLayer(
          {
            id: 'cycle-bus-stop',
            type: 'circle',
            source: 'openmaptiles',
            'source-layer': 'poi',
            minzoom: 14,
            filter: ['==', ['get', 'class'], 'bus'],
            paint: {
              'circle-radius': 3,
              'circle-color': '#5b9bd5',
              'circle-stroke-color': '#fff',
              'circle-stroke-width': 1,
              'circle-opacity': 0.75,
            },
          },
          'road_major_label',
        );
      } catch {}

      CYCLE_ROUTE_STYLES.forEach((layer) => {
        const filter = layer.network === 'other'
          ? [
            'all',
            ['!=', ['get', 'network'], 'ncn'],
            ['!=', ['get', 'network'], 'rcn'],
            ['!=', ['get', 'network'], 'lcn'],
          ]
          : ['==', ['get', 'network'], layer.network];
        m.addLayer(
          {
            id: layer.id,
            type: 'line',
            source: 'routes-overlay',
            'source-layer': 'cycleroutes',
            minzoom: 10,
            filter: filter as maplibregl.FilterSpecification,
            paint: {
              'line-color': layer.color,
              'line-width': layer.width,
              'line-dasharray': [3, 2],
              'line-opacity': 0.7,
            },
          },
          'road_major_label',
        );
      });

      // Effects gated by mapReady may add layers from sources created above.
      // Mark the map ready only after all load-time sources and layers exist.
      setMapReady(true);
    });

    // Context menu handling
    m.on('contextmenu', (e) => {
      e.preventDefault();
      if (longPressFired) return;
      if (roadRatingMode()) return;
      showContextMenu(m, e.lngLat, e.point);
    });
    m.on('mousemove', (e) => {
      if (!roadRatingMode()) return;
      // A marker sits above the map canvas. While hovering its bubble, keep
      // the bubble's road selected instead of letting the canvas hit-test
      // replace it with the road underneath the marker.
      if (roadRatingBubbleHoverWayId !== null) return;
      const point = { x: e.point.x, y: e.point.y };
      if (lastRoadRatingProcessedPoint
        && Math.hypot(
          point.x - lastRoadRatingProcessedPoint.x,
          point.y - lastRoadRatingProcessedPoint.y,
        ) < 3) return;
      lastRoadRatingProcessedPoint = point;
      const feature = findRoadRatingFeature(m, point);
      const wayId = feature ? roadRatingOsmWayId(feature) : null;
      if (feature && wayId !== null) {
        setRoadRatingHover(m, feature);
        m.getCanvas().style.cursor = 'pointer';
      } else {
        clearRoadRatingHover(m);
      }
    });
    m.on('click', (e) => {
      if (roadRatingMode()) {
        roadRatingSelectionRequest += 1;
        const selectionRequest = roadRatingSelectionRequest;
        const feature = findRoadRatingFeature(m, { x: e.point.x, y: e.point.y });
        const wayId = feature ? roadRatingOsmWayId(feature) : null;
        if (feature && wayId !== null) {
          const properties = feature.properties ?? {};
          let name: string | null = null;
          if (typeof properties['name:cs'] === 'string') {
            name = properties['name:cs'];
          } else if (typeof properties.name === 'string') {
            name = properties.name;
          }
          removeContextMenu();
          const selection = {
            wayId,
            name,
          };
          fetchRoadRatingByWayId(wayId).then((aggregate) => {
            if (destroyed || selectionRequest !== roadRatingSelectionRequest
              || !roadRatingMode()) return;
            openRoadRatingModal({
              ...selection,
              type: aggregate?.type ?? null,
              counts: aggregate?.counts ?? {
                total: 0,
                prefer: 0,
                demote: 0,
                subtypes: {
                  nice: 0, safe: 0, fast: 0, dangerous: 0, unpassable: 0, bad_terrain: 0,
                },
              },
              commentsCount: aggregate?.commentsCount ?? 0,
              mine: aggregate?.mine ?? null,
            });
          }).catch(() => {
            if (destroyed || selectionRequest !== roadRatingSelectionRequest
              || !roadRatingMode()) return;
            openRoadRatingModal({
              ...selection,
              type: null,
              counts: {
                total: 0,
                prefer: 0,
                demote: 0,
                subtypes: {
                  nice: 0, safe: 0, fast: 0, dangerous: 0, unpassable: 0, bad_terrain: 0,
                },
              },
              commentsCount: 0,
              mine: null,
            });
          });
        }
        return;
      }
      if (untrack(inspectMode)) {
        // Pass a plain object — MapLibre's Point instance from the event
        // (worker shared-chunk class) can take an empty code path in
        // queryRenderedFeatures, while a plain {x, y} object works.
        const queryPoint = { x: e.point.x, y: e.point.y } as maplibregl.PointLike;
        const features = m.queryRenderedFeatures(queryPoint);
        if (features.length > 0) {
          const f = features[0];
          const p = (f.properties ?? {}) as Record<string, JsonValue>;
          // Pick relevant OSM tags for display
          const propsToShow: Record<string, JsonValue> = {};
          const relevant = [
            'class',
            'subclass',
            'surface',
            'smoothness',
            'tracktype',
            'highway',
            'bicycle',
            'foot',
            'horse',
            'bridge',
            'tunnel',
            'oneway',
            'lit',
            'width',
            'osm_id',
          ];
          relevant.forEach((k) => {
            if (k in p) propsToShow[k] = p[k];
          });
          // Show any remaining props except internal names
          const skip = new Set([
            ...relevant,
            'name',
            'name:cs',
            'name:en',
            'name:de',
            '$type',
            'layer',
          ]);
          Object.entries(p).forEach(([k, v]) => {
            if (!skip.has(k)) propsToShow[k] = v;
          });
          // Vector tile feature id — real OSM id for simple geometries.
          // Multi-geometries are merged by planetiler → synthetic ids, skip those.
          // The topmost feature may be an app layer (route, markers) without ids —
          // scan all queried features for the first one with a usable OSM id.
          const simpleGeom = (t: string | undefined) => t === 'Point'
            || t === 'LineString' || t === 'Polygon';
          const idFeature = features.find((feat) => typeof feat.id === 'number'
            && simpleGeom(feat.geometry?.type));
          let osmId: { type: 'node' | 'way'; id: number } | undefined;
          if (idFeature && typeof idFeature.id === 'number') {
            osmId = {
              type: idFeature.geometry?.type === 'Point' ? 'node' : 'way',
              id: idFeature.id,
            };
          }
          setInspectInfo({
            layerId: String(f.layer?.id ?? 'unknown'),
            sourceLayer: typeof f.sourceLayer === 'string' ? f.sourceLayer : undefined,
            lng: e.lngLat.lng.toFixed(6),
            lat: e.lngLat.lat.toFixed(6),
            zoom: m.getZoom().toFixed(1),
            osmId,
            properties: propsToShow,
          });
        } else {
          setInspectInfo({
            layerId: '(none)',
            lng: e.lngLat.lng.toFixed(6),
            lat: e.lngLat.lat.toFixed(6),
            zoom: m.getZoom().toFixed(1),
            properties: {},
          });
        }
        return;
      }
      removeContextMenu();
    });

    // Track map center
    const updateCenter = () => {
      try {
        if (destroyed) return;
        const c = m.getCenter();
        setMapCamera({
          lat: c.lat,
          lon: c.lng,
          zoom: m.getZoom(),
          bearing: m.getBearing(),
          pitch: m.getPitch(),
        });
      } catch {}
    };
    const updateZoom = () => {
      try {
        if (!destroyed) setMapZoom(m.getZoom());
      } catch {}
    };
    const refreshRoadRatingsOnMove = () => debounceRoadRatingBubbles(m);
    m.on('moveend', updateCenter);
    m.on('moveend', refreshRoadRatingsOnMove);
    m.on('zoom', updateZoom);
    updateCenter();
    updateZoom();

    // Global escape key handler for context menu
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        removeContextMenu();
        setInspectMode(false);
        setInspectInfo(null);
      }
    };
    document.addEventListener('keydown', handleKey);

    const mapCanvas = m.getCanvas();
    mapCanvas.addEventListener('touchstart', handleTouchStart, {
      passive: true,
    });
    mapCanvas.addEventListener('touchmove', handleTouchMove, { passive: true });
    mapCanvas.addEventListener('touchend', handleTouchEnd);
    mapCanvas.addEventListener('touchcancel', handleTouchEnd);
    const suppressNativeContextMenu = (e: Event) => {
      e.preventDefault();
    };
    mapCanvas.addEventListener('contextmenu', suppressNativeContextMenu);

    onCleanup(() => {
      destroyed = true;
      updateHillshadeLightingLocal = null;
      if (window.__fitRouteOverview) delete window.__fitRouteOverview;
      document.removeEventListener('keydown', handleKey);
      mapCanvas.removeEventListener('touchstart', handleTouchStart);
      mapCanvas.removeEventListener('touchmove', handleTouchMove);
      mapCanvas.removeEventListener('touchend', handleTouchEnd);
      mapCanvas.removeEventListener('touchcancel', handleTouchEnd);
      mapCanvas.removeEventListener('contextmenu', suppressNativeContextMenu);
      clearLongPress();
      removeContextMenu();
      clearRoadRatingBubbles();
      clearRoadRatingHover(m);
      roadRatingSelectionRequest += 1;
      m.off('moveend', updateCenter);
      m.off('moveend', refreshRoadRatingsOnMove);
      m.off('zoom', updateZoom);
      m.remove();
    });
  });

  createEffect(() => {
    if (!map) return;
    const m = map;
    const current = stops();
    const total = current.length;

    // Diff markers: reuse by index, add new, remove excess
    while (stopMarkers.length > total) {
      stopMarkers.pop()!.remove();
    }

    for (let i = 0; i < total; i += 1) {
      const s = current[i];
      if (i < stopMarkers.length) stopMarkers[i].remove();
      const marker = createStopMarker({
        color: stopColor(i, total),
        index: i,
        name: s.name,
        lat: s.lat,
        lng: s.lng,
        map: m,
        onDragEnd: (lat, lng) => {
          updateStop(i, lat, lng);
          const fallback = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
          fetch(`/api/geocode?q=${encodeURIComponent(`${lat},${lng}`)}`)
            .then((response) => response.json() as Promise<{ name?: string }[]>)
            .then((geocodeResults) => {
              const name = geocodeResults[0]?.name;
              if (name) {
                setStops(planner.stops.map((stop, index) => (
                  index === i
                    ? {
                      ...stop, lat, lng, name: `${fallback} - ${name}`,
                    }
                    : stop
                )));
              }
            })
            .catch(() => {});
        },
      });
      if (i < stopMarkers.length) stopMarkers[i] = marker;
      else stopMarkers.push(marker);
    }
  });

  createEffect(() => {
    if (!map) return;
    const m = map;
    const r = route();

    // Always compute geometry distances (needed by highlight effect regardless of mapReady)
    if (r?.geometry.length) {
      geometryDistances = computeGeometryDistances(r.geometry);
    } else {
      geometryDistances = null;
    }

    if (!mapReady()) return;
    if (!r?.geometry.length) {
      removeMapSource(m, 'route', 'route-line');
      return;
    }

    // Convert [lat, lng] to [lng, lat] for GeoJSON
    const coords: [number, number][] = r.geometry.map(
      ([lat, lng]) => [lng, lat] as [number, number],
    );

    const geojson = {
      type: 'Feature' as const,
      properties: {},
      geometry: {
        type: 'LineString' as const,
        coordinates: coords,
      },
    };

    upsertGeoJSON(m, 'route', geojson, {
      id: 'route-line',
      type: 'line',
      paint: {
        'line-color': '#9900ff',
        'line-width': 4,
      },
    });

    // Fit bounds — only on first route computation
    const bounds = coords.reduce(
      (b, c) => b.extend(c),
      new maplibregl.LngLatBounds(coords[0], coords[0]),
    );
    routeBounds = bounds;
    if (firstRoute) {
      firstRoute = false;
      m.fitBounds(bounds, { padding: 50 });
    }
  });

  createEffect(() => {
    if (!map) return;
    const m = map;
    // Clean up existing POI markers
    poiMarkers.forEach((marker) => marker.remove());
    poiMarkers = [];

    const r = route();
    if (!r?.allPOILocations?.length) return;

    r.allPOILocations.forEach((poi) => {
      const marker = createPoiMarker({
        name: poi.name,
        type: poi.type,
        lat: poi.lat,
        lng: poi.lng,
        map: m,
        onAddStop: () => {
          const routeGeo = route()?.geometry;
          if (!routeGeo || routeGeo.length === 0 || stops().length < 2) {
            addStop({ lat: poi.lat, lng: poi.lng, name: poi.name });
            return;
          }
          // Find closest geometry index for POI
          let poiClosest = 0;
          let poiMin = Infinity;
          for (let i = 0; i < routeGeo.length; i += 1) {
            const d = haversineMeters(poi.lat, poi.lng, routeGeo[i][0], routeGeo[i][1]);
            if (d < poiMin) {
              poiMin = d;
              poiClosest = i;
            }
          }
          // Find closest geometry index for each interior stop
          const currentStops = stops();
          let insertIdx = currentStops.length - 1;
          for (let si = 1; si < currentStops.length - 1; si += 1) {
            let sClosest = 0;
            let sMin = Infinity;
            for (let i = 0; i < routeGeo.length; i += 1) {
              const d = haversineMeters(
                currentStops[si].lat,
                currentStops[si].lng,
                routeGeo[i][0],
                routeGeo[i][1],
              );
              if (d < sMin) {
                sMin = d;
                sClosest = i;
              }
            }
            if (sClosest < poiClosest) insertIdx = si + 1;
            else break;
          }
          const prev = planner.stops;
          const next = [...prev];
          next.splice(insertIdx, 0, {
            lat: poi.lat,
            lng: poi.lng,
            name: poi.name,
          });
          setStops(next);
        },
      });
      poiMarkers.push(marker);
    });
  });

  createEffect(() => {
    if (!map) return;
    const m = map;
    const point = hoveredPoint();
    if (!mapReady()) return;
    if (!point || !geometryDistances || !route()?.geometry.length) {
      removeMapSource(m, 'highlight', 'highlight-circle');
      return;
    }

    const pos = findPositionAtDistance(route()!.geometry, geometryDistances, point.distance);
    if (!pos) {
      removeMapSource(m, 'highlight', 'highlight-circle');
      return;
    }

    const pointGeoJSON = {
      type: 'Feature' as const,
      properties: {},
      geometry: {
        type: 'Point' as const,
        coordinates: [pos[1], pos[0]] as [number, number], // [lng, lat]
      },
    };

    upsertGeoJSON(m, 'highlight', pointGeoJSON, {
      id: 'highlight-circle',
      type: 'circle',
      paint: {
        'circle-radius': 7,
        'circle-color': '#f59e0b',
        'circle-stroke-color': '#fff',
        'circle-stroke-width': 2,
      },
    });
  });

  // ── Ride animation: shadow time sync ──
  // Direct update bypassing refreshHillshade's rAF/idle gate (too slow for animation)
  createEffect(() => {
    if (!map) return;
    const anim = rideAnimation();
    if (!anim.playing || !anim.currentDateTime) return;

    sunDateTime = anim.currentDateTime;
    // Call hillshade update directly — no rAF/idle delay
    try {
      if (!destroyed && map.isStyleLoaded() && updateHillshadeLightingLocal) {
        syncDynamicLayers(map);
        updateHillshadeLightingLocal();
      }
    } catch {}
  });

  // ── Ride animation: smooth camera tracking via rAF ──
  let cameraRafId = 0;
  let smoothCenter: { lng: number; lat: number } | null = null;
  let smoothBearing = 0;
  // Lerp factor per frame (0.12 = smooth but responsive inertia)
  const CAM_LERP = 0.06;
  const BEARING_LERP = 0.03; // slower bearing turn for inertia

  function cameraLoop() {
    if (!map || !cameraTarget.active) {
      smoothCenter = null;
      cameraRafId = 0;
      return;
    }

    const m = map;
    const target = cameraTarget;

    // Initialize smooth position on first frame
    if (!smoothCenter) {
      const c = m.getCenter();
      smoothCenter = { lng: c.lng, lat: c.lat };
      smoothBearing = m.getBearing();
    }

    // Lerp toward target
    const dx = target.lng - smoothCenter.lng;
    const dy = target.lat - smoothCenter.lat;

    // Shortest-path bearing interpolation
    let dBearing = target.bearing - smoothBearing;
    if (dBearing > 180) dBearing -= 360;
    if (dBearing < -180) dBearing += 360;

    // Only move if delta is significant (avoid micro-jitter)
    if (Math.abs(dx) > 0.000001 || Math.abs(dy) > 0.000001) {
      smoothCenter.lng += dx * CAM_LERP;
      smoothCenter.lat += dy * CAM_LERP;
    }
    if (Math.abs(dBearing) > 0.01) {
      smoothBearing += dBearing * BEARING_LERP;
      smoothBearing = ((smoothBearing % 360) + 360) % 360;
    }

    try {
      m.jumpTo({
        center: [smoothCenter.lng, smoothCenter.lat],
        zoom: 14,
        bearing: smoothBearing,
        pitch: 60,
      });
    } catch {}

    cameraRafId = requestAnimationFrame(cameraLoop);
  }

  // Watch for animation start/stop to manage camera rAF loop
  createEffect(() => {
    const anim = rideAnimation();
    if (!anim.playing) {
      // Stop camera loop
      if (cameraRafId) {
        cancelAnimationFrame(cameraRafId);
        cameraRafId = 0;
      }
      // Restore zoom
      if (cameraTarget.preZoom !== null && map) {
        try {
          map.setZoom(cameraTarget.preZoom);
        } catch {}
        cameraTarget.preZoom = null;
      }
      cameraTarget.active = false;
      return;
    }

    // Start camera loop if not running
    if (!cameraRafId) {
      if (map && cameraTarget.preZoom === null) {
        cameraTarget.preZoom = map.getZoom();
      }
      cameraRafId = requestAnimationFrame(cameraLoop);
    }
  });

  onCleanup(() => {
    if (cameraRafId) cancelAnimationFrame(cameraRafId);
  });

  // Reset animation state when route changes
  createEffect(() => {
    const r = route();
    if (!r) {
      updateRideAnimation({
        playing: false,
        currentDistance: 0,
        elapsedMs: 0,
        currentDateTime: null,
      });
    }
  });

  onCleanup(() => {
    topRightSlot()?.remove();
    setTopRightSlot(null);
    hikingPopup?.remove();
    hikingPopup = null;
    hikingLoadGeneration += 1;
    setHikingLoading(false);
    hikingLayersReady = false;
    map?.remove();
  });

  // ── Map controls wiring (store → MapLibre mutable state) ──

  function maybeRegenerate() {
    if (!route() || loading()) return;
    setTimeout(() => {
      if (!route() || loading() || !shadowRouteActive()) return;
      regenerateRoute().catch(() => {});
    }, 0);
  }

  createEffect(() => {
    if (!mapReady() || !map) return;
    const {
      terrainOn, hillshadeOn, contoursOn, terrainExaggeration,
    } = mapControls;
    if (!terrainOn && !hillshadeOn && !contoursOn && terrainExaggeration === -1) return;
    syncDynamicLayers(map);
  });

  createEffect(() => {
    if (!mapReady()) return;
    const { hillshadeIntensity } = mapControls;
    if (hillshadeIntensity < 0) return;
    if (mapControls.hillshadeOn) refreshHillshade();
  });

  createEffect(() => {
    if (!mapReady()) return;
    sunDateTime = effectiveSunDateTime();
    refreshHillshade();
  });

  createEffect(() => {
    const on = mapControls.hikingTrailsOn;
    const m = map;
    if (!m || !mapReady()) return;
    hikingLoadGeneration += 1;
    const generation = hikingLoadGeneration;
    if (!on) {
      setHikingLoading(false);
      hikingPopup?.remove();
      hikingPopup = null;
      setHikingLayersVisibility(m, false);
      return;
    }
    setHikingLoading(true);
    ensureHikingLayers(m);
    setHikingLayersVisibility(m, true);
    waitForMapRender(m).finally(() => {
      if (generation === hikingLoadGeneration) setHikingLoading(false);
    });
  });

  createEffect(() => {
    const enabled = roadRatingMode();
    roadRatingRevision();
    const zoom = mapZoom();
    if (!map || !mapReady()) return;
    if (map.getLayer('road-rating-hit-target')) {
      map.setLayoutProperty(
        'road-rating-hit-target',
        'visibility',
        enabled ? 'visible' : 'none',
      );
    }
    if (!enabled || zoom < 12) {
      clearRoadRatingBubbles();
      clearRoadRatingHover(map);
      roadRatingSelectionRequest += 1;
      roadRatingRoadsRequest += 1;
      const source = map.getSource('road-rating-roads') as maplibregl.GeoJSONSource;
      if (source) source.setData({ type: 'FeatureCollection', features: [] });
      roadRatingRoads = { type: 'FeatureCollection', features: [] };
      return;
    }
    loadRoadRatingRoads(map);
    loadRoadRatingBubbles(map);
  });

  return (
    <div class="map-wrapper">
      <div class="map-container">
        <div ref={container} class="map-host" />
        <div
          ref={(el) => {
            duskOverlay = el;
          }}
          class="map-dusk-overlay"
          aria-hidden="true"
        />
        <Show when={topRightSlot()}>
          {(slot) => (
            <Portal mount={slot()}>
              <div class="map-top-right-ui">
                <Show when={import.meta.env.DEV}>
                  <div class="map-top-right-row">
                    <Badge class="badge" textValue={`Zoom ${mapZoom().toFixed(1)}`}>
                      z {mapZoom().toFixed(1)}
                    </Badge>
                    <ToggleButton
                      class="btn-toggle"
                      pressed={inspectMode()}
                      onChange={(pressed) => {
                        setInspectMode(pressed);
                        setInspectInfo(null);
                      }}
                    >
                      ⌖ Inspect
                    </ToggleButton>
                  </div>
                </Show>
                {inspectMode()
                  && inspectInfo()
                  && (() => {
                    const info = inspectInfo()!;
                    const props = info.properties;
                    return (
                      <div class="map-inspect-panel">
                        <div class="map-inspect-header">
                          <span class="map-inspect-title">{info.layerId}</span>
                          {info.sourceLayer && (
                            <span class="map-inspect-subtitle">{info.sourceLayer}</span>
                          )}
                          <span class="map-inspect-zoom">z{info.zoom}</span>
                        </div>
                        <div class="map-inspect-gps">
                          📍 {info.lat}, {info.lng}
                        </div>
                        {info.osmId && (
                          <a
                            class="map-inspect-osm-link"
                            href={`https://www.openstreetmap.org/${info.osmId.type}`
                              + `/${info.osmId.id}`
                              + `#map=19/${info.lat}/${info.lng}&layers=CNDG`}
                            target="_blank"
                            rel="noopener"
                          >🌐 {info.osmId.type}/{info.osmId.id} na OSM</a>
                        )}
                        <a
                          class="map-inspect-osm-link map-inspect-osm-dim"
                          href={`https://www.openstreetmap.org/#map=19/${info.lat}/${info.lng}`
                            + '&layers=CNDG'}
                          target="_blank"
                          rel="noopener"
                        >🗺️ souřadnice v OSM</a>
                        {Object.keys(props).length > 0 && (
                          <pre class="map-inspect-pre">{JSON.stringify(props, null, 2)}</pre>
                        )}
                      </div>
                    );
                  })()}

                {/* Quick toggle icons */}
                <Show when={!webglFailed()}>
                  <div class="map-toolbar-toggles">
                    <Show when={mapZoom() >= MIN_TERRAIN_ZOOM}>
                      <ToggleButton
                        class="btn-toggle btn-toggle-icon"
                        pressed={mapControls.terrainOn}
                        onChange={(p) => mapControlActions.setTerrainOn(p)}
                        title="3D terén"
                      >
                        🏔️
                      </ToggleButton>
                    </Show>
                    <ToggleButton
                      class="btn-toggle btn-toggle-icon"
                      pressed={mapControls.contoursOn}
                      onChange={(p) => mapControlActions.setContoursOn(p)}
                      title="Vrstevnice"
                    >
                        📐
                      </ToggleButton>
                    <Show when={mapControls.terrainOn}>
                      <ToggleButton
                        class="btn-toggle btn-toggle-icon"
                        pressed={mapControls.hillshadeOn}
                        onChange={(p) => {
                          mapControlActions.setHillshadeOn(p);
                          maybeRegenerate();
                        }}
                        title="Stínování podle denní doby"
                      >
                        🌗
                      </ToggleButton>
                    </Show>
                    <ToggleButton
                      class="btn-toggle btn-toggle-icon"
                      pressed={mapControls.hikingTrailsOn}
                      onChange={(p) => mapControlActions.setHikingTrailsOn(p)}
                      title={hikingLoading() ? 'Načítám turistické trasy…' : 'Turistické trasy ČR'}
                      aria-label="Turistické trasy ČR"
                      aria-busy={hikingLoading()}
                    >
                      <Show when={hikingLoading()} fallback="🥾">
                        <span class="hiking-trail-spinner" aria-hidden="true" />
                      </Show>
                    </ToggleButton>
                    <ToggleButton
                        class="btn-toggle btn-toggle-icon"
                        pressed={roadRatingMode()}
                        onChange={setRoadRatingMode}
                        title="Hodnocení cest"
                    >
                      👍👎
                    </ToggleButton>

                  </div>
                </Show>
              </div>
            </Portal>
          )}
        </Show>
      </div>
      <RoadRatingModal />
    </div>
  );
}
