import { onMount, onCleanup, createEffect } from 'solid-js'
import L from 'leaflet'
import 'leaflet-contextmenu'
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
  const { stops, addStop, updateStop, route, setMapBounds, hoveredPoint } = useApp()
  let container!: HTMLDivElement
  let map: L.Map
  let stopMarkers: L.Marker[] = []
  let routeLine: L.Polyline | null = null
  let highlightMarker: L.CircleMarker | null = null
  let poiMarkers: L.Marker[] = []
  let geometryDistances: number[] | null = null

  /** Create a divIcon with a colored circle, matching the original color scheme. */
  function makeStopIcon(color: string, index: number): L.DivIcon {
    return L.divIcon({
      className: 'stop-marker',
      html: `<span class="stop-marker-dot" style="background:${color}">${index + 1}</span>`,
      iconSize: [26, 26],
      iconAnchor: [13, 13],
      popupAnchor: [0, -14],
    })
  }

  function stopColor(index: number, total: number): string {
    if (total === 1) return '#3b82f6'
    if (index === 0) return '#22c55e'
    if (index === total - 1) return '#ef4444'
    return '#3b82f6'
  }

  onMount(() => {
    map = L.map(container, {
      zoomControl: true,
      contextmenu: true,
      contextmenuItems: [
        {
          text: 'Přidat zastávku',
          callback: (e: any) => {
            addStop({ lat: e.latlng.lat, lng: e.latlng.lng, name: `${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)}` })
          },
        },
        {
          text: 'Otevřít na Mapy.cz',
          callback: (e: any) => {
            window.open(`https://en.mapy.cz/turisticka?x=${e.latlng.lng.toFixed(6)}&y=${e.latlng.lat.toFixed(6)}&z=16`, '_blank')
          },
        },
      ],
    } as any).setView([49.82, 15.47], 7)

    L.tileLayer('https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.cyclosm.org">CyclOSM</a>',
      maxZoom: 19,
      className: 'cyclosm-tiles',
    }).addTo(map)

    // Prevent default browser context menu on the map
    map.getContainer().addEventListener('contextmenu', e => e.preventDefault())

    const updateBounds = () => {
      const b = map.getBounds()
      setMapBounds({ south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() })
    }

    map.on('moveend', updateBounds)
    updateBounds()

    navigator.geolocation?.getCurrentPosition(
      pos => map.setView([pos.coords.latitude, pos.coords.longitude], 14),
      () => {},
    )
  })

  createEffect(() => {
    const current = stops()
    const total = current.length

    // Diff markers: reuse by index, add new, remove excess
    while (stopMarkers.length > total) {
      map.removeLayer(stopMarkers.pop()!)
    }

    for (let i = 0; i < total; i++) {
      const s = current[i]
      const color = stopColor(i, total)

      if (i < stopMarkers.length) {
        // Update existing marker position and icon
        stopMarkers[i].setLatLng([s.lat, s.lng])
        stopMarkers[i].setIcon(makeStopIcon(color, i))
      } else {
        // Create new marker
        const marker = L.marker([s.lat, s.lng], {
          icon: makeStopIcon(color, i),
          draggable: true,
          zIndexOffset: 1000,
        } as L.MarkerOptions).bindPopup(s.name).addTo(map)

        marker.on('dragend', () => {
          const pos = marker.getLatLng()
          updateStop(i, pos.lat, pos.lng)
        })

        stopMarkers.push(marker)
      }
    }

    if (current.length > 0 && !route()) {
      map.fitBounds(L.latLngBounds(current.map(s => [s.lat, s.lng])), { padding: [50, 50] })
    }
  })

  createEffect(() => {
    routeLine && map.removeLayer(routeLine)
    routeLine = null
    geometryDistances = null

    const r = route()
    if (r?.geometry.length) {
      routeLine = L.polyline(r.geometry, { color: '#2563eb', weight: 4, opacity: 0.8 }).addTo(map)
      geometryDistances = computeGeometryDistances(r.geometry)
      map.fitBounds(routeLine.getBounds(), { padding: [50, 50] })
    }
  })

  createEffect(() => {
    // Clean up existing POI markers
    poiMarkers.forEach(m => map.removeLayer(m))
    poiMarkers = []

    const r = route()
    if (!r?.poiLocations?.length) return

    const icon = L.divIcon({
      className: 'poi-marker',
      html: '🍺',
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    })

    for (const poi of r.poiLocations) {
      const marker = L.marker([poi.lat, poi.lng], {
        icon,
        draggable: false,
        zIndexOffset: 500,
      } as L.MarkerOptions).bindPopup(`<b>${poi.name}</b><br/>${poi.type}`).addTo(map)
      poiMarkers.push(marker)
    }
  })

  createEffect(() => {
    const point = hoveredPoint()
    if (!point || !geometryDistances || !route()?.geometry.length) {
      if (highlightMarker) {
        map.removeLayer(highlightMarker)
        highlightMarker = null
      }
      return
    }

    const pos = findPositionAtDistance(route()!.geometry, geometryDistances, point.distance)
    if (!pos) {
      if (highlightMarker) {
        map.removeLayer(highlightMarker)
        highlightMarker = null
      }
      return
    }

    if (highlightMarker) {
      highlightMarker.setLatLng(pos)
    } else {
      highlightMarker = L.circleMarker(pos, {
        radius: 7,
        fillColor: '#f59e0b',
        color: '#fff',
        weight: 2,
        fillOpacity: 1,
      }).addTo(map)
    }
  })

  onCleanup(() => map.remove())

  return (
    <div class="map-wrapper">
      <div class="map-container">
        <div ref={container} class="leaflet-host" />
      </div>
      <ElevationChart />
    </div>
  )
}
