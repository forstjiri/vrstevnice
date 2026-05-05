import { onMount, onCleanup, createEffect, createSignal } from 'solid-js'
import maplibregl from 'maplibre-gl'
import mlcontour from 'maplibre-contour'
import { haversineMeters, computeGeometryDistances } from '@vrstevnice/shared'
import { useApp } from './App'
import ElevationChart from './ElevationChart'
import { hoveredPoint } from './hoverStore'
import { createStopMarker, createPoiMarker, stopColor } from './map-markers'
import ShadowControls from './ShadowControls'

// ── Contour line setup (module-level, before any Map instance) ──
const demSource = new mlcontour.DemSource({
  url: 'http://localhost:3002/api/terrain/{z}/{x}/{y}',
  encoding: 'terrarium',
  maxzoom: 12,
  worker: true,
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
 * Find [lat, lng] on the polyline at a given cumulative distance.
 * Linearly interpolates between the two bracketing geometry points.
 */
function findPositionAtDistance(
  geometry: [number, number][],
  geometryDistances: number[],
  targetDistance: number,
): [number, number] | null {
  if (geometry.length === 0) return null
  if (geometry.length === 1) return geometry[0]

  // Clamp to last point if target exceeds total distance
  if (targetDistance >= geometryDistances[geometryDistances.length - 1]) {
    return geometry[geometry.length - 1]
  }

  // Binary search for the segment containing targetDistance
  let lo = 0
  let hi = geometryDistances.length - 1
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1
    if (geometryDistances[mid] <= targetDistance) lo = mid
    else hi = mid
  }

  const segStart = geometryDistances[lo]
  const segEnd = geometryDistances[hi]
  const t = segEnd > segStart ? (targetDistance - segStart) / (segEnd - segStart) : 0

  return [
    geometry[lo][0] + (geometry[hi][0] - geometry[lo][0]) * t,
    geometry[lo][1] + (geometry[hi][1] - geometry[lo][1]) * t,
  ]
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

function parseLocalDateTime(value: string): Date | null {
  if (!value) return null
  const [datePart, timePart] = value.split('T')
  if (!datePart || !timePart) return null
  const [year, month, day] = datePart.split('-').map(Number)
  const [hour, minute] = timePart.split(':').map(Number)
  if ([year, month, day, hour, minute].some((n) => Number.isNaN(n))) return null
  return new Date(year, month - 1, day, hour, minute, 0, 0)
}

function formatLocalDateTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function computeSolarPosition(date: Date, latDeg: number, lonDeg: number): { azimuth: number; altitude: number } {
  const rad = Math.PI / 180
  const dayOfYear = Math.floor((date.getTime() - new Date(date.getFullYear(), 0, 0).getTime()) / 86400000)
  const minutes = date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60
  const tzOffset = date.getTimezoneOffset() // minutes west of UTC
  const gamma = (2 * Math.PI / 365) * (dayOfYear - 1 + (minutes - 720) / 1440)

  const eqTime = 229.18 * (
    0.000075
    + 0.001868 * Math.cos(gamma)
    - 0.032077 * Math.sin(gamma)
    - 0.014615 * Math.cos(2 * gamma)
    - 0.040849 * Math.sin(2 * gamma)
  )

  const decl = (
    0.006918
    - 0.399912 * Math.cos(gamma)
    + 0.070257 * Math.sin(gamma)
    - 0.006758 * Math.cos(2 * gamma)
    + 0.000907 * Math.sin(2 * gamma)
    - 0.002697 * Math.cos(3 * gamma)
    + 0.00148 * Math.sin(3 * gamma)
  )

  // getTimezoneOffset() is minutes west of UTC, so it already has the sign
  // NOAA's timezone term expects.
  const timeOffset = eqTime + 4 * lonDeg + tzOffset
  const trueSolarTime = (minutes + timeOffset + 1440) % 1440
  const hourAngle = ((trueSolarTime / 4) - 180) * rad
  const lat = latDeg * rad

  const cosZenith = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle)
  const zenith = Math.acos(clamp(cosZenith, -1, 1))
  const altitude = 90 - (zenith / rad)

  const azimuthRad = Math.atan2(
    Math.sin(hourAngle),
    Math.cos(hourAngle) * Math.sin(lat) - Math.tan(decl) * Math.cos(lat),
  ) + Math.PI
  const azimuth = (azimuthRad / rad + 360) % 360

  return { azimuth, altitude }
}

function computeSunriseSunset(date: Date, latDeg: number, lonDeg: number): { sunrise: Date | null; sunset: Date | null } {
  const rad = Math.PI / 180
  const dayOfYear = Math.floor((date.getTime() - new Date(date.getFullYear(), 0, 0).getTime()) / 86400000)
  const lngHour = lonDeg / 15
  const year = date.getFullYear()
  const month = date.getMonth()
  const day = date.getDate()

  const calc = (isSunrise: boolean): Date | null => {
    const t = dayOfYear + ((isSunrise ? 6 : 18) - lngHour) / 24
    const meanAnomaly = 0.9856 * t - 3.289
    let trueLng = meanAnomaly
      + 1.916 * Math.sin(meanAnomaly * rad)
      + 0.020 * Math.sin(2 * meanAnomaly * rad)
      + 282.634
    trueLng = ((trueLng % 360) + 360) % 360

    let rightAscension = Math.atan(0.91764 * Math.tan(trueLng * rad)) / rad
    rightAscension = ((rightAscension % 360) + 360) % 360
    const lQuadrant = Math.floor(trueLng / 90) * 90
    const raQuadrant = Math.floor(rightAscension / 90) * 90
    rightAscension += lQuadrant - raQuadrant
    rightAscension /= 15

    const sinDec = 0.39782 * Math.sin(trueLng * rad)
    const cosDec = Math.cos(Math.asin(sinDec))
    const cosH = (
      Math.cos(90.833 * rad) - sinDec * Math.sin(latDeg * rad)
    ) / (cosDec * Math.cos(latDeg * rad))

    if (cosH > 1 || cosH < -1) return null

    let hourAngle = isSunrise ? 360 - Math.acos(cosH) / rad : Math.acos(cosH) / rad
    hourAngle /= 15

    const localMeanTime = hourAngle + rightAscension - 0.06571 * t - 6.622
    let utcHours = localMeanTime - lngHour
    utcHours = ((utcHours % 24) + 24) % 24

    const hours = Math.floor(utcHours)
    const minutes = Math.floor((utcHours - hours) * 60)
    const seconds = Math.round((((utcHours - hours) * 60) - minutes) * 60)
    return new Date(Date.UTC(year, month, day, hours, minutes, seconds))
  }

  return { sunrise: calc(true), sunset: calc(false) }
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

/**
 * Build a context menu from a declarative items list.
 */
function buildContextMenu(items: Array<{ label: string; action: () => void }>): HTMLDivElement {
  const menu = document.createElement('div')
  menu.className = 'map-contextmenu'
  for (const item of items) {
    const el = document.createElement('div')
    el.className = 'map-contextmenu-item'
    el.textContent = item.label
    el.addEventListener('click', () => { item.action(); menu.remove() })
    menu.appendChild(el)
  }
  return menu
}

export default function Map() {
  const { stops, addStop, updateStop, route, mapCenter, setMapCenter } = useApp()
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
  let terrainEnabled = true
  let terrainExaggeration = 1.5
  let hillshadeEnabled = true
  let contoursEnabled = true
  let contoursReady = false
  let hillshadeBaseIntensity = 1
  let sunDateTime = formatLocalDateTime(new Date())
  const MIN_TERRAIN_ZOOM = 10
  let destroyed = false
  let updateHillshadeLightingLocal: (() => void) | null = null

  function syncDynamicLayers(m: maplibregl.Map) {
    try {
      if (!m.isStyleLoaded()) return
      const terrainVisible = terrainEnabled && m.getZoom() >= MIN_TERRAIN_ZOOM
      if (terrainVisible) m.setTerrain({ source: 'terrain-dem', exaggeration: terrainExaggeration })
      else m.setTerrain(null)

      if (m.getLayer('hillshade')) {
        m.setLayoutProperty('hillshade', 'visibility', hillshadeEnabled && terrainVisible ? 'visible' : 'none')
      }

      const contoursVisible = contoursEnabled && contoursReady
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

  function showContextMenu(m: maplibregl.Map, e: maplibregl.MapMouseEvent) {
    removeContextMenu()
    contextMenu = buildContextMenu([
      {
        label: 'Přidat zastávku',
        action: () => addStop({
          lat: e.lngLat.lat,
          lng: e.lngLat.lng,
          name: `${e.lngLat.lat.toFixed(5)}, ${e.lngLat.lng.toFixed(5)}`,
        }),
      },
      {
        label: 'Otevřít na Mapy.cz',
        action: () => window.open(
          `https://en.mapy.cz/turisticka?x=${e.lngLat.lng.toFixed(6)}&y=${e.lngLat.lat.toFixed(6)}&z=16`,
          '_blank',
        ),
      },
    ])
    const mapContainer = m.getContainer()
    contextMenu.style.left = `${e.point.x}px`
    contextMenu.style.top = `${e.point.y}px`
    mapContainer.appendChild(contextMenu)
  }

  onMount(() => {
    try {
      map = new maplibregl.Map({
        container,
        style: 'http://localhost:2323/styles/basic/style.json?v=2',
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
          tiles: ['http://localhost:3002/api/terrain/{z}/{x}/{y}'],
          encoding: 'terrarium',
          tileSize: 256,
          maxzoom: 11,
        })
        m.addSource('hillshade-dem', {
          type: 'raster-dem',
          tiles: ['http://localhost:3002/api/terrain/{z}/{x}/{y}'],
          encoding: 'terrarium',
          tileSize: 256,
          maxzoom: 11,
        })
        m.addLayer({
          id: 'hillshade',
          type: 'hillshade',
          source: 'hillshade-dem',
          layout: {
            visibility: hillshadeEnabled ? 'visible' : 'none',
          },
          paint: {
            'hillshade-method': 'basic',
            'hillshade-shadow-color': 'rgba(0, 0, 0, 0.35)',
            'hillshade-highlight-color': 'rgba(255, 255, 255, 0.22)',
            'hillshade-accent-color': 'rgba(90, 90, 90, 0.2)',
            'hillshade-exaggeration': hillshadeBaseIntensity,
            'hillshade-illumination-direction': 315,
            'hillshade-illumination-altitude': 45,
          },
        }, 'road_major_label')

        const updateHillshadeLighting = () => {
          try {
            if (destroyed || !m.getLayer('hillshade') || !m.isStyleLoaded()) return
            if (!hillshadeEnabled) {
              if (duskOverlay) {
                duskOverlay.style.opacity = '0'
                duskOverlay.style.background = 'transparent'
              }
              return
            }
            const dt = parseLocalDateTime(sunDateTime) ?? new Date()
            const center = m.getCenter()
            const { azimuth, altitude } = computeSolarPosition(dt, center.lat, center.lng)
            const { sunrise, sunset } = computeSunriseSunset(dt, center.lat, center.lng)
            const daylightFactor = hillshadeVisibilityFactor(dt, sunrise, sunset)
            const nightMix = hillshadeNightMix(dt, sunrise, sunset)
            const strengthT = clamp((hillshadeBaseIntensity - 1) / 2, 0, 1)
            const ambientTintFactor = clamp((1 - daylightFactor) * (0.08 + nightMix * 0.22), 0, 0.28)

            if (duskOverlay) {
              const overlay = duskOverlay
              overlay.style.opacity = String(ambientTintFactor)
              overlay.style.background = ambientTintFactor > 0
                ? `linear-gradient(180deg, rgba(10, 20, 64, ${0.10 + nightMix * 0.18}), rgba(2, 8, 28, ${0.08 + nightMix * 0.18}))`
                : 'transparent'
            }

            try { m.setPaintProperty('hillshade', 'hillshade-illumination-direction', azimuth) } catch (_) {}
            try { m.setPaintProperty('hillshade', 'hillshade-illumination-altitude', clamp(altitude, 5, 70)) } catch (_) {}
            try { m.setPaintProperty('hillshade', 'hillshade-illumination-anchor', 'map') } catch (_) {}
            try { m.setPaintProperty('hillshade', 'hillshade-exaggeration', hillshadeExaggerationFromIntensity(hillshadeBaseIntensity) * (0.4 + daylightFactor * 0.6)) } catch (_) {}
            try { m.setPaintProperty('hillshade', 'hillshade-shadow-color', rgba(0, 0, 0, 0.35 * daylightFactor + 0.08)) } catch (_) {}
            try { m.setPaintProperty('hillshade', 'hillshade-highlight-color', rgba(255, 255, 255, 0.22 * daylightFactor + 0.03)) } catch (_) {}
            try { m.setPaintProperty('hillshade', 'hillshade-accent-color', rgba(90, 90, 90, 0.2 * daylightFactor + 0.04)) } catch (_) {}
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
      fetch('http://localhost:3002/api/cycleroutes')
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
      showContextMenu(m, e)
    })
    m.on('click', () => removeContextMenu())

    // Track map center
    const updateCenter = () => {
      try {
        if (destroyed) return
        const c = m.getCenter()
        setMapCenter({ lat: c.lat, lon: c.lng, zoom: m.getZoom() })
      } catch (_) {}
    }
    m.on('moveend', updateCenter)
    updateCenter()

    // Global escape key handler for context menu
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') removeContextMenu()
    }
    document.addEventListener('keydown', handleKey)

    onCleanup(() => {
      destroyed = true
      updateHillshadeLightingLocal = null
      if ((window as any).__fitRouteOverview) delete (window as any).__fitRouteOverview
      document.removeEventListener('keydown', handleKey)
      removeContextMenu()
      m.off('moveend', updateCenter)
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

    if (m.getSource('route')) {
      ;(m.getSource('route') as maplibregl.GeoJSONSource).setData(geojson)
    } else {
      m.addSource('route', { type: 'geojson', data: geojson })
      m.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route',
        paint: {
          'line-color': '#9900ff',
          'line-width': 4,
        },
      })
    }

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

    // Build a set of selected POI coordinates for O(1) lookup
    const selectedKeys = new Set(
      (r.poiLocations ?? []).map((p) => `${p.lat},${p.lng}`),
    )

    for (const poi of r.allPOILocations) {
      const isSelected = selectedKeys.has(`${poi.lat},${poi.lng}`)
      const marker = createPoiMarker({
        name: poi.name, type: poi.type,
        lat: poi.lat, lng: poi.lng, map: m,
        dimmed: !isSelected,
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

    if (m.getSource('highlight')) {
      ;(m.getSource('highlight') as maplibregl.GeoJSONSource).setData(pointGeoJSON)
    } else {
      m.addSource('highlight', { type: 'geojson', data: pointGeoJSON })
      m.addLayer({
        id: 'highlight-circle',
        type: 'circle',
        source: 'highlight',
        paint: {
          'circle-radius': 7,
          'circle-color': '#f59e0b',
          'circle-stroke-color': '#fff',
          'circle-stroke-width': 2,
        },
      })
    }
  })

  onCleanup(() => map?.remove())

  const shadowCallbacks = {
    setTerrain: (enabled: boolean) => {
      if (!map) return
      try {
        terrainEnabled = enabled
        syncDynamicLayers(map)
      } catch (_) {}
    },
    setTerrainExaggeration: (v: number) => {
      if (!map) return
      terrainExaggeration = v
      try {
        syncDynamicLayers(map)
      } catch (_) {}
    },
    setHillshade: (enabled: boolean) => {
      hillshadeEnabled = enabled
      try {
        if (map) syncDynamicLayers(map)
        if (enabled) {
          refreshHillshade()
        }
      } catch (_) {}
    },
    setHillshadeExaggeration: (v: number) => {
      hillshadeBaseIntensity = v
      try {
        refreshHillshade()
      } catch (_) {}
    },
    setSunDateTime: (value: string) => {
      sunDateTime = value
      try {
        refreshHillshade()
      } catch (_) {}
    },
    setContours: (enabled: boolean) => {
      if (!map) return
      try {
        contoursEnabled = enabled
        if (!enabled) contoursReady = false
        else contoursReady = true
        syncDynamicLayers(map)
      } catch (_) {}
    },
    getMap: () => map ?? null,
  }

  return (
    <div class="map-wrapper">
      <div class="map-container">
        <div ref={container} class="map-host" />
        <div ref={(el) => { duskOverlay = el }} class="map-dusk-overlay" aria-hidden="true" />
        <div class="map-overlay-shadow-controls">
          <ShadowControls {...shadowCallbacks} mapReady={mapReady} webglFailed={webglFailed} />
        </div>
      </div>
      <ElevationChart />
    </div>
  )
}
