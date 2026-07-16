import { onMount, onCleanup, createEffect, createSignal, Show } from 'solid-js'
import { Portal } from 'solid-js/web'
import * as maplibregl from 'maplibre-gl'
import mlcontour from 'maplibre-contour'
import SunCalc from 'suncalc'

maplibregl.setWorkerUrl(
  new URL('maplibre-gl/dist/maplibre-gl-worker.mjs', import.meta.url).href,
)
import { haversineMeters, computeGeometryDistances, findPositionAtDistance, computeBearing, parseLocalDateTime, formatLocalDateTime } from '@vrstevnice/shared'
import { useApp } from './App'
import { hoveredPoint } from './hoverStore'
import { rideAnimation, updateRideAnimation, cameraTarget, setCameraTarget } from './rideAnimationStore'
import { createStopMarker, createPoiMarker, stopColor, buildContextMenu } from './map-markers'
import { Badge } from '@kobalte/core/badge'
import { ToggleButton } from '@kobalte/core/toggle-button'
import {
  mapControls,
  mapControlActions,
  effectiveSunDateTime,
  shadowRouteActive,
} from './mapControlsStore'

// Tileserver URL: localhost in dev, same-host in prod (port 2323 exposed by Docker)
const TILESERVER_URL = import.meta.env.DEV
  ? 'http://localhost:2323'
  : `${window.location.protocol}//${window.location.hostname}:2323`

// ── Contour line setup (module-level, before any Map instance) ──
// Relative URL — works in dev (Vite proxy origin) and prod (same-origin via BE)
const demSource = new mlcontour.DemSource({
  url: '/api/terrain/{z}/{x}/{y}',
  encoding: 'terrarium',
  maxzoom: 14,
  worker: false,
})
demSource.setupMaplibre(maplibregl)

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
})

/**
 * Find bearing at a given distance along route geometry.
 * Uses the segment the point is on to determine direction.
 */
function bearingAtDistance(
  geometry: [number, number][],
  geometryDistances: number[],
  targetDistance: number,
): number | null {
  if (geometry.length < 2) return null
  const totalDist = geometryDistances[geometryDistances.length - 1]
  const lookahead = Math.min(targetDistance + 50, totalDist)
  const fromPos = findPositionAtDistance(geometry, geometryDistances, targetDistance)
  const toPos = findPositionAtDistance(geometry, geometryDistances, lookahead)
  if (!fromPos || !toPos) return null
  if (fromPos[0] === toPos[0] && fromPos[1] === toPos[1]) return null
  return computeBearing(fromPos, toPos)
}

/**
 * Upsert a GeoJSON source + layer on the map. If source exists, update data only.
 */
function upsertGeoJSON(
  map: maplibregl.Map,
  sourceId: string,
  data: Record<string, unknown>,
  layerSpec: Record<string, unknown>,
) {
  if (map.getSource(sourceId)) {
    ;(map.getSource(sourceId) as maplibregl.GeoJSONSource).setData(data as any)
  } else {
    map.addSource(sourceId, { type: 'geojson', data: data as any })
    map.addLayer({ ...layerSpec, source: sourceId } as any)
  }
}

function setPaintProperties(
  map: maplibregl.Map,
  layerId: string,
  properties: Array<[keyof maplibregl.AllPaintProperties, unknown]>,
) {
  for (const [name, value] of properties) {
    try {
      map.setPaintProperty(layerId, name, value as never)
    } catch (_) {}
  }
}

/**
 * Remove a MapLibre source and its layer. No-op if source doesn't exist.
 */
function removeMapSource(map: maplibregl.Map, sourceId: string, layerId?: string) {
  if (!map.getSource(sourceId)) return
  if (layerId && map.getLayer(layerId)) map.removeLayer(layerId)
  map.removeSource(sourceId)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function rgba(r: number, g: number, b: number, a: number): string {
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a.toFixed(3)})`
}

function hillshadeNightMix(date: Date, sunrise: Date | null, sunset: Date | null): number {
  if (!sunrise || !sunset) return 0.35

  const hour = 60 * 60 * 1000
  const t = date.getTime()
  const sunriseStart = sunrise.getTime() - hour
  const sunriseEnd = sunrise.getTime() + hour
  const sunsetStart = sunset.getTime() - hour
  const sunsetEnd = sunset.getTime() + hour

  if (t < sunriseStart) return 1
  if (t < sunriseEnd) return 1 - smoothstep(sunriseStart, sunriseEnd, t)
  if (t < sunsetStart) return 0
  if (t < sunsetEnd) return smoothstep(sunsetStart, sunsetEnd, t)
  return 1
}

function hillshadeVisibilityFactor(date: Date, sunrise: Date | null, sunset: Date | null): number {
  if (!sunrise || !sunset) return 1

  const hour = 60 * 60 * 1000
  const t = date.getTime()
  const sunriseStart = sunrise.getTime() - hour
  const sunriseEnd = sunrise.getTime() + hour
  const sunsetStart = sunset.getTime() - hour
  const sunsetEnd = sunset.getTime() + hour

  if (t < sunriseStart) return 0
  if (t < sunriseEnd) return smoothstep(sunriseStart, sunriseEnd, t)
  if (t < sunsetStart) return 1
  if (t < sunsetEnd) return 1 - smoothstep(sunsetStart, sunsetEnd, t)
  return 0
}

function hillshadeExaggerationFromIntensity(intensity: number): number {
  const normalized = clamp(intensity, 0, 3)
  return 0.45 + normalized * 0.35
}

function getHillshadePaint(
  intensity: number,
  daylightFactor: number,
  azimuth: number,
  altitude: number,
) {
  return [
    ['hillshade-illumination-direction', azimuth],
    ['hillshade-illumination-altitude', clamp(altitude, 5, 70)],
    ['hillshade-illumination-anchor', 'map'],
    ['hillshade-exaggeration', hillshadeExaggerationFromIntensity(intensity) * (0.4 + daylightFactor * 0.6)],
    ['hillshade-shadow-color', rgba(0, 0, 0, 0.35 * daylightFactor + 0.08)],
    ['hillshade-highlight-color', rgba(255, 255, 255, 0.22 * daylightFactor + 0.03)],
    ['hillshade-accent-color', rgba(90, 90, 90, 0.2 * daylightFactor + 0.04)],
  ] satisfies Array<[keyof maplibregl.AllPaintProperties, unknown]>
}

/**
 * Build a context menu from a declarative items list.
 */
export default function Map() {
  const { stops, setStops, addStop, updateStop, route, mapCenter, setMapCenter, loading, regenerateRoute } = useApp()
  let container!: HTMLDivElement
  let map: maplibregl.Map | undefined
  const [mapReady, setMapReady] = createSignal(false)
  const [webglFailed, setWebglFailed] = createSignal(false)
  let stopMarkers: maplibregl.Marker[] = []
  let poiMarkers: maplibregl.Marker[] = []
  let geometryDistances: number[] | null = null
  let contextMenu: HTMLDivElement | null = null
  let duskOverlay: HTMLDivElement | null = null
  let firstRoute = true
  let routeBounds: maplibregl.LngLatBounds | null = null
  let contoursReady = false
  const [mapZoom, setMapZoom] = createSignal(7)
  const [inspectMode, setInspectMode] = createSignal(false)
  const [inspectInfo, setInspectInfo] = createSignal<{ layerId: string; sourceLayer?: string; lng: string; lat: string; zoom: string; properties: Record<string, unknown> } | null>(null)
  let sunDateTime = formatLocalDateTime(new Date())
  const MIN_TERRAIN_ZOOM = 10
  let destroyed = false
  let updateHillshadeLightingLocal: (() => void) | null = null
  const [topRightSlot, setTopRightSlot] = createSignal<HTMLDivElement | null>(null)

  function syncDynamicLayers(m: maplibregl.Map) {
    try {
      if (!m.isStyleLoaded()) return
      const terrainVisible = mapControls.terrainOn && m.getZoom() >= MIN_TERRAIN_ZOOM
      if (terrainVisible) m.setTerrain({ source: 'terrain-dem', exaggeration: mapControls.terrainExaggeration })
      else m.setTerrain(null)

      if (m.getLayer('hillshade')) {
        m.setLayoutProperty('hillshade', 'visibility', mapControls.hillshadeOn && terrainVisible ? 'visible' : 'none')
      }

      const contoursVisible = mapControls.contoursOn && contoursReady
      if (m.getLayer('contour-lines')) {
        m.setLayoutProperty('contour-lines', 'visibility', contoursVisible ? 'visible' : 'none')
      }
      if (m.getLayer('contour-labels')) {
        m.setLayoutProperty('contour-labels', 'visibility', contoursVisible ? 'visible' : 'none')
      }
    } catch (_) {}
  }

  function refreshHillshade() {
    if (!map || !updateHillshadeLightingLocal) return
    const run = () => {
      if (!map || !updateHillshadeLightingLocal) return
      updateHillshadeLightingLocal()
    }

    if (map.isStyleLoaded()) {
      requestAnimationFrame(() => requestAnimationFrame(run))
    } else {
      map.once('idle', run)
    }
  }


  function removeContextMenu() {
    contextMenu?.remove()
    contextMenu = null
  }

  function showContextMenu(m: maplibregl.Map, lngLat: maplibregl.LngLat, point: { x: number; y: number }) {
    removeContextMenu()
    contextMenu = buildContextMenu([
      {
        label: 'Přidat zastávku',
        action: () => addStop({
          lat: lngLat.lat,
          lng: lngLat.lng,
          name: `${lngLat.lat.toFixed(5)}, ${lngLat.lng.toFixed(5)}`,
        }),
      },
      {
        label: 'Otevřít na Mapy.cz',
        action: () => window.open(
          `https://en.mapy.cz/turisticka?x=${lngLat.lng.toFixed(6)}&y=${lngLat.lat.toFixed(6)}&z=16`,
          '_blank',
        ),
      },
    ])
    const mapContainer = m.getContainer()
    const menuW = 180
    const menuH = contextMenu.offsetHeight || 80
    const containerRect = mapContainer.getBoundingClientRect()
    let left = Math.min(point.x, containerRect.width - menuW - 8)
    let top = Math.min(point.y, containerRect.height - menuH - 8)
    left = Math.max(8, left)
    top = Math.max(8, top)
    contextMenu.style.left = `${left}px`
    contextMenu.style.top = `${top}px`
    mapContainer.appendChild(contextMenu)
  }

  const LONG_PRESS_MS = 500
  const LONG_PRESS_MOVE_THRESHOLD = 10
  let longPressTimer: ReturnType<typeof setTimeout> | null = null
  let longPressStart: { x: number; y: number } | null = null
  let longPressFired = false

  function clearLongPress() {
    if (longPressTimer) {
      clearTimeout(longPressTimer)
      longPressTimer = null
    }
    longPressStart = null
  }

  function handleTouchStart(e: TouchEvent) {
    if (e.touches.length !== 1) { clearLongPress(); return }
    const t = e.touches[0]
    longPressStart = { x: t.clientX, y: t.clientY }
    longPressFired = false
    longPressTimer = setTimeout(() => {
      if (!longPressStart) return
      longPressFired = true
      const m = map
      if (!m) return
      const containerRect = m.getContainer().getBoundingClientRect()
      const point = {
        x: longPressStart.x - containerRect.left,
        y: longPressStart.y - containerRect.top,
      }
      const lngLat = m.unproject(new maplibregl.Point(point.x, point.y))
      showContextMenu(m, lngLat, point)
    }, LONG_PRESS_MS)
  }

  function handleTouchMove(e: TouchEvent) {
    if (!longPressStart || longPressFired) return
    const t = e.touches[0]
    const dx = Math.abs(t.clientX - longPressStart.x)
    const dy = Math.abs(t.clientY - longPressStart.y)
    if (dx > LONG_PRESS_MOVE_THRESHOLD || dy > LONG_PRESS_MOVE_THRESHOLD) {
      clearLongPress()
    }
  }

  function handleTouchEnd(_e: TouchEvent) {
    clearLongPress()
  }

  onMount(() => {
    try {
      map = new maplibregl.Map({
        container,
        style: `${TILESERVER_URL}/styles/basic/style.json?v=2`,
        center: [15.47, 49.82], // [lng, lat]
        zoom: 7,
      })
    } catch (err) {
      console.error('[Map] Failed to create map (WebGL not available?):', err)
      setWebglFailed(true)
      return
    }

    // TypeScript: map is guaranteed defined after successful construction
    const m = map!

    const topRightCorner = m.getContainer().querySelector('.maplibregl-ctrl-top-right')
    if (topRightCorner instanceof HTMLDivElement) {
      const slot = document.createElement('div')
      slot.className = 'map-top-right-slot'
      topRightCorner.prepend(slot)
      setTopRightSlot(slot)
    }

    m.addControl(new maplibregl.NavigationControl())

    m.addControl(new maplibregl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      fitBoundsOptions: { maxZoom: 15 },
    }))

    m.on('load', () => {
      setMapReady(true)
      // @ts-ignore debug
      window.__map = m
      // @ts-ignore debug — used by Stops panel "Přehled trasy" button
      ;(window as any).__fitRouteOverview = () => {
        if (routeBounds) m.fitBounds(routeBounds, { padding: 50 })
      }

      // ── De-emphasize motorways & primary roads for cycling ──
      try {
        if (m.getLayer('road_major_motorway')) {
          m.setPaintProperty('road_major_motorway', 'line-opacity', 0.35)
        }
        if (m.getLayer('road_trunk_primary')) {
          m.setPaintProperty('road_trunk_primary', 'line-opacity', 0.5)
        }
        // Brighten minor roads (residential, service) — good for cycling
        if (m.getLayer('road_minor')) {
          m.setPaintProperty('road_minor', 'line-color', '#fdf6e3')
        }
          // Widen forest tracks/paths — visible from z12
          // Note: MapLibre minzoom is integer-only, 12.5 would round to 13
          if (m.getLayer('road_path')) {
            // Hide original thin layer — our custom layer replaces it
            try { m.setLayoutProperty('road_path', 'visibility', 'none') } catch (_) {}
            // Bright track line
            m.addLayer({
              id: 'cycle-path-widen',
              type: 'line',
              source: 'openmaptiles',
              'source-layer': 'transportation',
              minzoom: 12,
              filter: [
                'all',
                ['==', '$type', 'LineString'],
                ['in', 'class', 'path', 'track'],
                ['!=', 'subclass', 'cycleway'],
              ],
              paint: {
                'line-color': 'hsl(0, 0%, 97%)',
                'line-dasharray': [1, 1],
                'line-width': [
                  'interpolate', ['linear'], ['zoom'],
                  12, 1,
                  14, 3,
                  18, 10,
                ],
              },
            }, 'road_path')
          }
        // Highlight tertiary roads — paved, lower traffic
        m.addLayer({
          id: 'cycle-tertiary-highlight',
          type: 'line',
          source: 'openmaptiles',
          'source-layer': 'transportation',
          minzoom: 12,
          filter: ['==', ['get', 'class'], 'tertiary'],
          paint: {
            'line-color': '#fdf6e3',
            'line-width': [
              'interpolate', ['linear'], ['zoom'],
              12, 0.5, 14, 3, 18, 8,
            ],
            'line-opacity': 0.7,
          },
        }, 'road_secondary_tertiary')
      } catch (_) {}

      // ── Terrain DEM sources ──
      try {
        m.addSource('terrain-dem', {
          type: 'raster-dem',
          tiles: ['/api/terrain/{z}/{x}/{y}'],
          encoding: 'terrarium',
          tileSize: 256,
          maxzoom: 14,
        })
        m.addLayer({
          id: 'hillshade',
          type: 'hillshade',
          source: 'terrain-dem',
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
        }, 'road_major_label')

        const updateHillshadeLighting = () => {
          try {
            if (destroyed || !m.getLayer('hillshade') || !m.isStyleLoaded()) return
            if (!mapControls.hillshadeOn) {
              if (duskOverlay) {
                duskOverlay.style.opacity = '0'
                duskOverlay.style.background = 'transparent'
              }
              return
            }
            const dt = parseLocalDateTime(sunDateTime) ?? new Date()
            const center = m.getCenter()
            const pos = SunCalc.getPosition(dt, center.lat, center.lng)
            const azimuth = (pos.azimuth * 180 / Math.PI + 180 + 360) % 360
            const altitude = pos.altitude * 180 / Math.PI
            const times = SunCalc.getTimes(dt, center.lat, center.lng)
            const sunrise = times.sunrise ?? null
            const sunset = times.sunset ?? null
            const daylightFactor = hillshadeVisibilityFactor(dt, sunrise, sunset)
            const nightMix = hillshadeNightMix(dt, sunrise, sunset)
            const hillshadeIntensity = mapControls.hillshadeIntensity
            const ambientTintFactor = clamp((1 - daylightFactor) * (0.08 + nightMix * 0.22), 0, 0.28)

            if (duskOverlay) {
              const overlay = duskOverlay
              overlay.style.opacity = String(ambientTintFactor)
              overlay.style.background = ambientTintFactor > 0
                ? `linear-gradient(180deg, rgba(10, 20, 64, ${0.10 + nightMix * 0.18}), rgba(2, 8, 28, ${0.08 + nightMix * 0.18}))`
                : 'transparent'
            }

            setPaintProperties(m, 'hillshade', getHillshadePaint(hillshadeIntensity, daylightFactor, azimuth, altitude))
          } catch (_) {}
        }

        updateHillshadeLightingLocal = updateHillshadeLighting

        syncDynamicLayers(m)
        refreshHillshade()
      } catch (_) {}

      // ── Contour lines ──
      try {
        m.addSource('contours', {
          type: 'vector',
          tiles: [contourTileUrl],
          maxzoom: 15,
        })
        m.addLayer({
          id: 'contour-lines',
          type: 'line',
          source: 'contours',
          'source-layer': 'contours',
          paint: {
            'line-color': '#8B7355',
            'line-opacity': 0.5,
            'line-width': ['match', ['get', 'level'], 1, 1, 0.4],
          },
        }, 'road_major_label')
        m.addLayer({
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
        }, 'road_major_label')
        contoursReady = true
        syncDynamicLayers(m)
      } catch (err) {
      }

      // ── Transit: railway lines (visible from z10) ──
      try {
        m.addLayer({
          id: 'cycle-railway',
          type: 'line',
          source: 'openmaptiles',
          'source-layer': 'transportation',
          minzoom: 10,
          filter: ['==', ['get', 'class'], 'rail'],
          paint: {
            'line-color': '#555',
            'line-width': [
              'interpolate', ['linear'], ['zoom'],
              10, 2, 14, 4, 18, 5.5,
            ],
            'line-opacity': [
              'interpolate', ['linear'], ['zoom'],
              10, 0.3, 12, 0.6, 14, 1,
            ],
            'line-dasharray': [1, 1.5],
          },
        }, 'road_major_label')

        m.addLayer({
          id: 'cycle-railway-transit',
          type: 'line',
          source: 'openmaptiles',
          'source-layer': 'transportation',
          minzoom: 11,
          filter: ['all', ['==', ['get', 'class'], 'transit'], ['!=', ['get', 'brunnel'], 'tunnel']],
          paint: {
            'line-color': '#777',
            'line-width': [
              'interpolate', ['linear'], ['zoom'],
              11, 1.5, 14, 3, 18, 4.5,
            ],
            'line-opacity': [
              'interpolate', ['linear'], ['zoom'],
              11, 0.3, 13, 0.6, 15, 1,
            ],
            'line-dasharray': [1, 1.5],
          },
        }, 'road_major_label')

        // ── Train stations ──
        m.addLayer({
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
        }, 'road_major_label')

        m.addLayer({
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
        }, 'road_major_label')

        // ── Bus stops ──
        m.addLayer({
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
        }, 'road_major_label')

      } catch (err) {
      }

      // Load KČT cycle routes overlay
      fetch('/api/cycleroutes')
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          return res.json()
        })
        .then((geojson) => {
          m.addSource('cycleroutes', {
            type: 'geojson',
            data: geojson,
            tolerance: 0.0005,
            buffer: 1,
            maxzoom: 14,
          })

          const networkLayers: Array<{ id: string; filter: maplibregl.FilterSpecification; color: string; width: number }> = [
            { id: 'cycleroutes-ncn', filter: ['==', ['get', 'network'], 'ncn'], color: '#e53e3e', width: 2.5 },
            { id: 'cycleroutes-rcn', filter: ['==', ['get', 'network'], 'rcn'], color: '#2b6cb0', width: 2 },
            { id: 'cycleroutes-lcn', filter: ['==', ['get', 'network'], 'lcn'], color: '#38a169', width: 1.5 },
            { id: 'cycleroutes-other', filter: ['all', ['!=', ['get', 'network'], 'ncn'], ['!=', ['get', 'network'], 'rcn'], ['!=', ['get', 'network'], 'lcn']], color: '#a0aec0', width: 1.2 },
          ]

          for (const layer of networkLayers) {
            m.addLayer({
              id: layer.id,
              type: 'line',
              source: 'cycleroutes',
              minzoom: 10,
              filter: layer.filter,
              paint: {
                'line-color': layer.color,
                'line-width': layer.width,
                'line-dasharray': [3, 2],
                'line-opacity': 0.7,
              },
            }, 'road_major_label')
          }

          console.log(`[Map] Cycle routes loaded: ${geojson.features.length} features`)
        })
        .catch(() => {})
    })

    // Context menu handling
    m.on('contextmenu', (e) => {
      e.preventDefault()
      if (longPressFired) return
      showContextMenu(m, e.lngLat, e.point)
    })
    m.on('click', (e) => {
      if (inspectMode()) {
        const features = m.queryRenderedFeatures(e.point)
        if (features.length > 0) {
          const f = features[0]
          const p = (f.properties ?? {}) as Record<string, unknown>
          // Pick relevant OSM tags for display
          const propsToShow: Record<string, unknown> = {}
          const relevant = [
            'class', 'subclass', 'surface', 'smoothness', 'tracktype',
            'highway', 'bicycle', 'foot', 'horse', 'bridge', 'tunnel',
            'oneway', 'lit', 'width', 'osm_id',
          ]
          for (const k of relevant) {
            if (k in p) propsToShow[k] = p[k]
          }
          // Show any remaining props except internal names
          const skip = new Set([...relevant, 'name', 'name:cs', 'name:en', 'name:de', '$type', 'layer'])
          for (const [k, v] of Object.entries(p)) {
            if (!skip.has(k)) propsToShow[k] = v
          }
          setInspectInfo({
            layerId: String(f.layer?.id ?? 'unknown'),
            sourceLayer: typeof f.sourceLayer === 'string' ? f.sourceLayer : undefined,
            lng: e.lngLat.lng.toFixed(6),
            lat: e.lngLat.lat.toFixed(6),
            zoom: m.getZoom().toFixed(1),
            properties: propsToShow,
          })
        } else {
          setInspectInfo({
            layerId: '(none)',
            lng: e.lngLat.lng.toFixed(6),
            lat: e.lngLat.lat.toFixed(6),
            zoom: m.getZoom().toFixed(1),
            properties: {},
          })
        }
        return
      }
      removeContextMenu()
    })

    // Track map center
    const updateCenter = () => {
      try {
        if (destroyed) return
        const c = m.getCenter()
        setMapCenter({ lat: c.lat, lon: c.lng, zoom: m.getZoom() })
      } catch (_) {}
    }
    const updateZoom = () => {
      try { if (!destroyed) setMapZoom(m.getZoom()) } catch (_) {}
    }
    m.on('moveend', updateCenter)
    m.on('zoom', updateZoom)
    updateCenter()
    updateZoom()

    // Global escape key handler for context menu
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        removeContextMenu()
        setInspectMode(false)
        setInspectInfo(null)
      }
    }
    document.addEventListener('keydown', handleKey)

    const mapCanvas = m.getCanvas()
    mapCanvas.addEventListener('touchstart', handleTouchStart, { passive: true })
    mapCanvas.addEventListener('touchmove', handleTouchMove, { passive: true })
    mapCanvas.addEventListener('touchend', handleTouchEnd)
    mapCanvas.addEventListener('touchcancel', handleTouchEnd)
    const suppressNativeContextMenu = (e: Event) => { e.preventDefault() }
    mapCanvas.addEventListener('contextmenu', suppressNativeContextMenu)

    onCleanup(() => {
      destroyed = true
      updateHillshadeLightingLocal = null
      if ((window as any).__fitRouteOverview) delete (window as any).__fitRouteOverview
      document.removeEventListener('keydown', handleKey)
      mapCanvas.removeEventListener('touchstart', handleTouchStart)
      mapCanvas.removeEventListener('touchmove', handleTouchMove)
      mapCanvas.removeEventListener('touchend', handleTouchEnd)
      mapCanvas.removeEventListener('touchcancel', handleTouchEnd)
      mapCanvas.removeEventListener('contextmenu', suppressNativeContextMenu)
      clearLongPress()
      removeContextMenu()
      m.off('moveend', updateCenter)
      m.off('zoom', updateZoom)
      m.remove()
    })
  })

  createEffect(() => {
    if (!map) return
    const m = map
    const current = stops()
    const total = current.length

    // Diff markers: reuse by index, add new, remove excess
    while (stopMarkers.length > total) {
      stopMarkers.pop()!.remove()
    }

    for (let i = 0; i < total; i++) {
      const s = current[i]
      if (i < stopMarkers.length) stopMarkers[i].remove()
      const marker = createStopMarker({
        color: stopColor(i, total), index: i, name: s.name,
        lat: s.lat, lng: s.lng, map: m,
        onDragEnd: (lat, lng) => updateStop(i, lat, lng),
      })
      if (i < stopMarkers.length) stopMarkers[i] = marker
      else stopMarkers.push(marker)
    }
  })

  createEffect(() => {
    if (!map) return
    const m = map
    const r = route()

    // Always compute geometry distances (needed by highlight effect regardless of mapReady)
    if (r?.geometry.length) {
      geometryDistances = computeGeometryDistances(r.geometry)
    } else {
      geometryDistances = null
    }

    if (!mapReady()) return
    if (!r?.geometry.length) {
      removeMapSource(m, 'route', 'route-line')
      return
    }

    // Convert [lat, lng] to [lng, lat] for GeoJSON
    const coords: [number, number][] = r.geometry.map(([lat, lng]) => [lng, lat] as [number, number])

    const geojson = {
      type: 'Feature' as const,
      properties: {},
      geometry: {
        type: 'LineString' as const,
        coordinates: coords,
      },
    }

    upsertGeoJSON(m, 'route', geojson, {
      id: 'route-line',
      type: 'line',
      paint: {
        'line-color': '#9900ff',
        'line-width': 4,
      },
    })

    // Fit bounds — only on first route computation
    const bounds = coords.reduce(
      (b, c) => b.extend(c as [number, number]),
      new maplibregl.LngLatBounds(coords[0], coords[0]),
    )
    routeBounds = bounds
    if (firstRoute) {
      firstRoute = false
      m.fitBounds(bounds, { padding: 50 })
    }
  })

  createEffect(() => {
    if (!map) return
    const m = map
    // Clean up existing POI markers
    poiMarkers.forEach((m) => m.remove())
    poiMarkers = []

    const r = route()
    if (!r?.allPOILocations?.length) return

    for (const poi of r.allPOILocations) {
      const marker = createPoiMarker({
        name: poi.name, type: poi.type,
        lat: poi.lat, lng: poi.lng, map: m,
        onAddStop: () => {
          const routeGeo = route()?.geometry
          if (!routeGeo || routeGeo.length === 0 || stops().length < 2) {
            addStop({ lat: poi.lat, lng: poi.lng, name: poi.name })
            return
          }
          // Find closest geometry index for POI
          let poiClosest = 0
          let poiMin = Infinity
          for (let i = 0; i < routeGeo.length; i++) {
            const d = haversineMeters(poi.lat, poi.lng, routeGeo[i][0], routeGeo[i][1])
            if (d < poiMin) { poiMin = d; poiClosest = i }
          }
          // Find closest geometry index for each interior stop
          const currentStops = stops()
          let insertIdx = currentStops.length - 1
          for (let si = 1; si < currentStops.length - 1; si++) {
            let sClosest = 0
            let sMin = Infinity
            for (let i = 0; i < routeGeo.length; i++) {
              const d = haversineMeters(currentStops[si].lat, currentStops[si].lng, routeGeo[i][0], routeGeo[i][1])
              if (d < sMin) { sMin = d; sClosest = i }
            }
            if (sClosest < poiClosest) insertIdx = si + 1
            else break
          }
          setStops(prev => {
            const next = [...prev]
            next.splice(insertIdx, 0, { lat: poi.lat, lng: poi.lng, name: poi.name })
            return next
          })
        },
      })
      poiMarkers.push(marker)
    }
  })

  createEffect(() => {
    if (!map) return
    const m = map
    const point = hoveredPoint()
    if (!mapReady()) return
    if (!point || !geometryDistances || !route()?.geometry.length) {
      removeMapSource(m, 'highlight', 'highlight-circle')
      return
    }

    const pos = findPositionAtDistance(route()!.geometry, geometryDistances, point.distance)
    if (!pos) {
      removeMapSource(m, 'highlight', 'highlight-circle')
      return
    }

    const pointGeoJSON = {
      type: 'Feature' as const,
      properties: {},
      geometry: {
        type: 'Point' as const,
        coordinates: [pos[1], pos[0]] as [number, number], // [lng, lat]
      },
    }

    upsertGeoJSON(m, 'highlight', pointGeoJSON, {
      id: 'highlight-circle',
      type: 'circle',
      paint: {
        'circle-radius': 7,
        'circle-color': '#f59e0b',
        'circle-stroke-color': '#fff',
        'circle-stroke-width': 2,
      },
    })
  })

  // ── Ride animation: shadow time sync ──
  // Direct update bypassing refreshHillshade's rAF/idle gate (too slow for animation)
  createEffect(() => {
    if (!map) return
    const anim = rideAnimation()
    if (!anim.playing || !anim.currentDateTime) return

    sunDateTime = anim.currentDateTime
    // Call hillshade update directly — no rAF/idle delay
    try {
      if (!destroyed && map.isStyleLoaded() && updateHillshadeLightingLocal) {
        syncDynamicLayers(map)
        updateHillshadeLightingLocal()
      }
    } catch (_) {}
  })

  // ── Ride animation: smooth camera tracking via rAF ──
  let cameraRafId = 0
  let smoothCenter: { lng: number; lat: number } | null = null
  let smoothBearing = 0
  // Lerp factor per frame (0.12 = smooth but responsive inertia)
  const CAM_LERP = 0.06
  const BEARING_LERP = 0.03 // slower bearing turn for inertia

  function cameraLoop() {
    if (!map || !cameraTarget.active) {
      smoothCenter = null
      cameraRafId = 0
      return
    }

    const m = map
    const target = cameraTarget

    // Initialize smooth position on first frame
    if (!smoothCenter) {
      const c = m.getCenter()
      smoothCenter = { lng: c.lng, lat: c.lat }
      smoothBearing = m.getBearing()
    }

    // Lerp toward target
    const dx = target.lng - smoothCenter.lng
    const dy = target.lat - smoothCenter.lat

    // Shortest-path bearing interpolation
    let dBearing = target.bearing - smoothBearing
    if (dBearing > 180) dBearing -= 360
    if (dBearing < -180) dBearing += 360

    // Only move if delta is significant (avoid micro-jitter)
    if (Math.abs(dx) > 0.000001 || Math.abs(dy) > 0.000001) {
      smoothCenter.lng += dx * CAM_LERP
      smoothCenter.lat += dy * CAM_LERP
    }
    if (Math.abs(dBearing) > 0.01) {
      smoothBearing += dBearing * BEARING_LERP
      smoothBearing = ((smoothBearing % 360) + 360) % 360
    }

    try {
      m.jumpTo({
        center: [smoothCenter.lng, smoothCenter.lat],
        zoom: 14,
        bearing: smoothBearing,
        pitch: 60,
      })
    } catch (_) {}

    cameraRafId = requestAnimationFrame(cameraLoop)
  }

  // Watch for animation start/stop to manage camera rAF loop
  createEffect(() => {
    const anim = rideAnimation()
    if (!anim.playing) {
      // Stop camera loop
      if (cameraRafId) {
        cancelAnimationFrame(cameraRafId)
        cameraRafId = 0
      }
      // Restore zoom
      if (cameraTarget.preZoom !== null && map) {
        try { map.setZoom(cameraTarget.preZoom) } catch (_) {}
        cameraTarget.preZoom = null
      }
      cameraTarget.active = false
      return
    }

    // Start camera loop if not running
    if (!cameraRafId) {
      if (map && cameraTarget.preZoom === null) {
        cameraTarget.preZoom = map.getZoom()
      }
      cameraRafId = requestAnimationFrame(cameraLoop)
    }
  })

  onCleanup(() => {
    if (cameraRafId) cancelAnimationFrame(cameraRafId)
  })

  // Reset animation state when route changes
  createEffect(() => {
    const r = route()
    if (!r) {
      updateRideAnimation({ playing: false, currentDistance: 0, elapsedMs: 0, currentDateTime: null })
    }
  })

  onCleanup(() => {
    topRightSlot()?.remove()
    setTopRightSlot(null)
    map?.remove()
  })

  // ── Map controls wiring (store → MapLibre mutable state) ──

  function maybeRegenerate() {
    if (!route() || loading()) return
    setTimeout(() => {
      if (!route() || loading() || !shadowRouteActive()) return
      void regenerateRoute()()
    }, 0)
  }

  createEffect(() => {
    if (!mapReady() || !map) return
    const { terrainOn, hillshadeOn, contoursOn, terrainExaggeration } = mapControls
    void terrainOn
    void hillshadeOn
    void contoursOn
    void terrainExaggeration
    syncDynamicLayers(map)
  })

  createEffect(() => {
    if (!mapReady()) return
    const { hillshadeIntensity } = mapControls
    void hillshadeIntensity
    if (mapControls.hillshadeOn) refreshHillshade()
  })

  createEffect(() => {
    if (!mapReady()) return
    sunDateTime = effectiveSunDateTime()
    refreshHillshade()
  })

  return (
    <div class="map-wrapper">
      <div class="map-container">
        <div ref={container} class="map-host" />
        <div ref={(el) => { duskOverlay = el }} class="map-dusk-overlay" aria-hidden="true" />
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
                      setInspectMode(pressed)
                      setInspectInfo(null)
                    }}
                  >
                    ⌖ Inspect
                  </ToggleButton>
                </div>
                </Show>
                {inspectMode() && inspectInfo() && (() => {
                  const info = inspectInfo()!
                  const props = info.properties
                  return (
                    <div class="map-inspect-panel">
                      <div class="map-inspect-header">
                        <span class="map-inspect-title">{info.layerId}</span>
                        {info.sourceLayer && <span class="map-inspect-subtitle">{info.sourceLayer}</span>}
                        <span class="map-inspect-zoom">z{info.zoom}</span>
                      </div>
                      <div class="map-inspect-gps">📍 {info.lat}, {info.lng}</div>
                      {Object.keys(props).length > 0 && (
                        <pre class="map-inspect-pre">{JSON.stringify(props, null, 2)}</pre>
                      )}
                    </div>
                  )
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
                        onChange={(p) => { mapControlActions.setHillshadeOn(p); maybeRegenerate() }}
                        title="Stínování podle denní doby"
                      >
                        🌗
                      </ToggleButton>
                    </Show>
                  </div>
                </Show>

              </div>
            </Portal>
          )}
        </Show>
      </div>
    </div>
  )
}
