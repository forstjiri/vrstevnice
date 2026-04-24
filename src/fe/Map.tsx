import { onMount, onCleanup, createEffect } from 'solid-js'
import maplibregl from 'maplibre-gl'
import { useApp } from './App'
import ElevationChart from './ElevationChart'

const EARTH_RADIUS_M = 6_371_000

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

/** Pre-compute cumulative haversine distances for each geometry point. */
function computeGeometryDistances(geometry: [number, number][]): number[] {
  const distances = [0]
  for (let i = 1; i < geometry.length; i++) {
    distances.push(distances[i - 1] + haversineMeters(geometry[i - 1][0], geometry[i - 1][1], geometry[i][0], geometry[i][1]))
  }
  return distances
}

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

export default function Map() {
  const { stops, addStop, updateStop, route, mapCenter, setMapCenter, hoveredPoint } = useApp()
  let container!: HTMLDivElement
  let map!: maplibregl.Map
  let mapReady = false
  let stopMarkers: maplibregl.Marker[] = []
  let poiMarkers: maplibregl.Marker[] = []
  let geometryDistances: number[] | null = null
  let contextMenu: HTMLDivElement | null = null

  function stopColor(index: number, total: number): string {
    if (total === 1) return '#3b82f6'
    if (index === 0) return '#22c55e'
    if (index === total - 1) return '#ef4444'
    return '#3b82f6'
  }

  function createStopElement(color: string, index: number, name: string): HTMLElement {
    const el = document.createElement('div')
    el.className = 'stop-marker'
    const dot = document.createElement('span')
    dot.className = 'stop-marker-dot'
    dot.style.background = color
    dot.textContent = `${index + 1}`
    el.appendChild(dot)
    return el
  }

  function createPoiElement(): HTMLElement {
    const el = document.createElement('div')
    el.className = 'poi-marker'
    el.textContent = '🍺'
    return el
  }

  function removeContextMenu() {
    contextMenu?.remove()
    contextMenu = null
  }

  function showContextMenu(e: maplibregl.MapMouseEvent) {
    removeContextMenu()

    contextMenu = document.createElement('div')
    contextMenu.className = 'map-contextmenu'

    const addStopItem = document.createElement('div')
    addStopItem.className = 'map-contextmenu-item'
    addStopItem.textContent = 'Přidat zastávku'
    addStopItem.addEventListener('click', () => {
      addStop({
        lat: e.lngLat.lat,
        lng: e.lngLat.lng,
        name: `${e.lngLat.lat.toFixed(5)}, ${e.lngLat.lng.toFixed(5)}`,
      })
      removeContextMenu()
    })
    contextMenu.appendChild(addStopItem)

    const openMapyItem = document.createElement('div')
    openMapyItem.className = 'map-contextmenu-item'
    openMapyItem.textContent = 'Otevřít na Mapy.cz'
    openMapyItem.addEventListener('click', () => {
      window.open(
        `https://en.mapy.cz/turisticka?x=${e.lngLat.lng.toFixed(6)}&y=${e.lngLat.lat.toFixed(6)}&z=16`,
        '_blank',
      )
      removeContextMenu()
    })
    contextMenu.appendChild(openMapyItem)

    // Position relative to map container
    const mapContainer = map.getContainer()
    const rect = mapContainer.getBoundingClientRect()
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
      const color = stopColor(i, total)

      if (i < stopMarkers.length) {
        // MapLibre Marker doesn't support updating DOM content in-place;
        // remove old and create new at same position
        stopMarkers[i].remove()
        const el = createStopElement(color, i, s.name)
        const marker = new maplibregl.Marker({
          element: el,
          draggable: true,
          anchor: 'center',
        })
          .setLngLat([s.lng, s.lat])
          .addTo(map)

        marker.on('dragend', () => {
          const pos = marker.getLngLat()
          updateStop(i, pos.lat, pos.lng)
        })

        el.addEventListener('click', () => {
          new maplibregl.Popup({ offset: 14, closeButton: false })
            .setLngLat([s.lng, s.lat])
            .setText(s.name)
            .addTo(map)
        })

        stopMarkers[i] = marker
      } else {
        // Create new marker
        const el = createStopElement(color, i, s.name)
        const marker = new maplibregl.Marker({
          element: el,
          draggable: true,
          anchor: 'center',
        })
          .setLngLat([s.lng, s.lat])
          .addTo(map)

        marker.on('dragend', () => {
          const pos = marker.getLngLat()
          updateStop(i, pos.lat, pos.lng)
        })

        // Add popup on click
        el.addEventListener('click', () => {
          new maplibregl.Popup({ offset: 14, closeButton: false })
            .setLngLat([s.lng, s.lat])
            .setText(s.name)
            .addTo(map)
        })

        stopMarkers.push(marker)
      }
    }
  })

  createEffect(() => {
    if (!mapReady) return

    const r = route()
    if (!r?.geometry.length) {
      // Remove route source/layer if they exist
      if (map.getSource('route')) {
        map.removeLayer('route-line')
        map.removeSource('route')
      }
      geometryDistances = null
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
    } else {
      map.addSource('route', { type: 'geojson', data: geojson })
      map.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route',
        paint: {
          'line-color': '#ff00ae',
          'line-width': 4,
        },
      })
    }

    geometryDistances = computeGeometryDistances(r.geometry)

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
    if (!r?.poiLocations?.length) return

    for (const poi of r.poiLocations) {
      const el = createPoiElement()
      const marker = new maplibregl.Marker({
        element: el,
        anchor: 'center',
      })
        .setLngLat([poi.lng, poi.lat])
        .addTo(map)

      el.addEventListener('click', () => {
        new maplibregl.Popup({ offset: 11, closeButton: false })
          .setLngLat([poi.lng, poi.lat])
          .setHTML(`<b>${poi.name}</b><br/>${poi.type}`)
          .addTo(map)
      })

      poiMarkers.push(marker)
    }
  })

  createEffect(() => {
    if (!mapReady) return

    const point = hoveredPoint()
    if (!point || !geometryDistances || !route()?.geometry.length) {
      if (map.getSource('highlight')) {
        map.removeLayer('highlight-circle')
        map.removeSource('highlight')
      }
      return
    }

    const pos = findPositionAtDistance(route()!.geometry, geometryDistances, point.distance)
    if (!pos) {
      if (map.getSource('highlight')) {
        map.removeLayer('highlight-circle')
        map.removeSource('highlight')
      }
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
