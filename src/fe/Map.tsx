import { onMount, onCleanup, createEffect } from 'solid-js'
import maplibregl from 'maplibre-gl'
import { haversineMeters, computeGeometryDistances } from '@vrstevnice/shared'
import { useApp } from './App'
import ElevationChart from './ElevationChart'
import { hoveredPoint } from './hoverStore'
import { createStopMarker, createPoiMarker, stopColor } from './map-markers'

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
  let map!: maplibregl.Map
  let mapReady = false
  let stopMarkers: maplibregl.Marker[] = []
  let poiMarkers: maplibregl.Marker[] = []
  let geometryDistances: number[] | null = null
  let contextMenu: HTMLDivElement | null = null

  function removeContextMenu() {
    contextMenu?.remove()
    contextMenu = null
  }

  function showContextMenu(e: maplibregl.MapMouseEvent) {
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
    const mapContainer = map.getContainer()
    contextMenu.style.left = `${e.point.x}px`
    contextMenu.style.top = `${e.point.y}px`
    mapContainer.appendChild(contextMenu)
  }

  onMount(() => {
    map = new maplibregl.Map({
      container,
      style: 'http://localhost:2323/styles/basic/style.json',
      center: [15.47, 49.82], // [lng, lat]
      zoom: 7,
    })

    map.addControl(new maplibregl.NavigationControl())

    map.on('load', () => {
      mapReady = true
      // @ts-ignore debug
      window.__map = map

      // Load KČT cycle routes overlay
      fetch('http://localhost:3002/api/cycleroutes')
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          return res.json()
        })
        .then((geojson) => {
          map.addSource('cycleroutes', { type: 'geojson', data: geojson })

          const networkLayers: Array<{ id: string; filter: maplibregl.FilterSpecification; color: string; width: number }> = [
            { id: 'cycleroutes-ncn', filter: ['==', ['get', 'network'], 'ncn'], color: '#e53e3e', width: 2.5 },
            { id: 'cycleroutes-rcn', filter: ['==', ['get', 'network'], 'rcn'], color: '#2b6cb0', width: 2 },
            { id: 'cycleroutes-lcn', filter: ['==', ['get', 'network'], 'lcn'], color: '#38a169', width: 1.5 },
            { id: 'cycleroutes-other', filter: ['all', ['!=', ['get', 'network'], 'ncn'], ['!=', ['get', 'network'], 'rcn'], ['!=', ['get', 'network'], 'lcn']], color: '#a0aec0', width: 1.2 },
          ]

          for (const layer of networkLayers) {
            map.addLayer({
              id: layer.id,
              type: 'line',
              source: 'cycleroutes',
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
        .catch((err) => console.warn('[Map] Failed to load cycle routes:', err))
    })

    // Context menu handling
    map.on('contextmenu', (e) => {
      e.preventDefault()
      showContextMenu(e)
    })
    map.on('click', () => removeContextMenu())

    // Track map center
    const updateCenter = () => {
      const c = map.getCenter()
      setMapCenter({ lat: c.lat, lon: c.lng, zoom: map.getZoom() })
    }
    map.on('moveend', updateCenter)
    updateCenter()

    // Geolocation
    navigator.geolocation?.getCurrentPosition(
      (pos) => {
        map.setCenter([pos.coords.longitude, pos.coords.latitude])
        map.setZoom(14)
      },
      () => {},
    )

    // Global escape key handler for context menu
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') removeContextMenu()
    }
    document.addEventListener('keydown', handleKey)

    onCleanup(() => {
      document.removeEventListener('keydown', handleKey)
      removeContextMenu()
    })
  })

  createEffect(() => {
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
        lat: s.lat, lng: s.lng, map,
        onDragEnd: (lat, lng) => updateStop(i, lat, lng),
      })
      if (i < stopMarkers.length) stopMarkers[i] = marker
      else stopMarkers.push(marker)
    }
  })

  createEffect(() => {
    const r = route()
    console.log('[Map] Route effect, mapReady:', mapReady, 'hasRoute:', !!r, 'geometryLen:', r?.geometry?.length)

    // Always compute geometry distances (needed by highlight effect regardless of mapReady)
    if (r?.geometry.length) {
      geometryDistances = computeGeometryDistances(r.geometry)
    } else {
      geometryDistances = null
    }

    if (!mapReady) return
    if (!r?.geometry.length) {
      removeMapSource(map, 'route', 'route-line')
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

    if (map.getSource('route')) {
      ;(map.getSource('route') as maplibregl.GeoJSONSource).setData(geojson)
      console.log('[Map] Route source updated, coords:', coords.length)
    } else {
      map.addSource('route', { type: 'geojson', data: geojson })
      map.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route',
        paint: {
          'line-color': '#9900ff',
          'line-width': 4,
        },
      })
      console.log('[Map] Route source+layer added, coords:', coords.length)
    }

    // Verify layer exists after adding
    const checkLayer = map.getLayer('route-line')
    console.log('[Map] route-line layer exists:', !!checkLayer, 'type:', checkLayer?.type)

    // Fit bounds
    const bounds = coords.reduce(
      (b, c) => b.extend(c as [number, number]),
      new maplibregl.LngLatBounds(coords[0], coords[0]),
    )
    map.fitBounds(bounds, { padding: 50 })
  })

  createEffect(() => {
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
        lat: poi.lat, lng: poi.lng, map,
        dimmed: !isSelected,
      })
      poiMarkers.push(marker)
    }
  })

  createEffect(() => {
    const point = hoveredPoint()
    if (!mapReady) return
    if (!point || !geometryDistances || !route()?.geometry.length) {
      removeMapSource(map, 'highlight', 'highlight-circle')
      return
    }

    const pos = findPositionAtDistance(route()!.geometry, geometryDistances, point.distance)
    if (!pos) {
      removeMapSource(map, 'highlight', 'highlight-circle')
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

    if (map.getSource('highlight')) {
      ;(map.getSource('highlight') as maplibregl.GeoJSONSource).setData(pointGeoJSON)
    } else {
      map.addSource('highlight', { type: 'geojson', data: pointGeoJSON })
      map.addLayer({
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

  onCleanup(() => map.remove())

  return (
    <div class="map-wrapper">
      <div class="map-container">
        <div ref={container} class="map-host" />
      </div>
      <ElevationChart />
    </div>
  )
}
