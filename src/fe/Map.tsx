import { onMount, onCleanup, createEffect, Show } from 'solid-js'
import L from 'leaflet'
import { useApp } from './App'

export default function Map() {
  const { stops, route, setMapBounds } = useApp()
  let container!: HTMLDivElement
  let map: L.Map
  let stopMarkers: L.CircleMarker[] = []
  let routeLine: L.Polyline | null = null

  onMount(() => {
    map = L.map(container, { zoomControl: true }).setView([49.82, 15.47], 7)

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap',
      maxZoom: 19,
    }).addTo(map)

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
    stopMarkers.forEach(m => map.removeLayer(m))
    stopMarkers = []

    const current = stops()
    for (let i = 0; i < current.length; i++) {
      const s = current[i]
      const color = i === 0 ? '#22c55e' : i === current.length - 1 ? '#ef4444' : '#3b82f6'

      stopMarkers.push(
        L.circleMarker([s.lat, s.lng], {
          radius: 8,
          fillColor: color,
          color: '#fff',
          weight: 2,
          fillOpacity: 1,
        }).bindPopup(s.name).addTo(map),
      )
    }

    if (current.length > 0 && !route()) {
      map.fitBounds(L.latLngBounds(current.map(s => [s.lat, s.lng])), { padding: [50, 50] })
    }
  })

  createEffect(() => {
    routeLine && map.removeLayer(routeLine)
    routeLine = null

    const r = route()
    if (r?.geometry.length) {
      routeLine = L.polyline(r.geometry, { color: '#2563eb', weight: 4, opacity: 0.8 }).addTo(map)
      map.fitBounds(routeLine.getBounds(), { padding: [50, 50] })
    }
  })

  onCleanup(() => map.remove())

  return (
    <div class="map-wrapper">
      <div ref={container} />
      <Show when={route()}>
        {r => (
          <div class="route-info">
            <span class="val">{r().distance.toFixed(1)} km</span>{'\n'}
            <span class="gain">↑ {r().elevationGain} m</span>{'\n'}
            <span class="loss">↓ {r().elevationLoss} m</span>{'\n'}
            <span class="val">⏱ {Math.round(r().duration / 60)} min</span>
          </div>
        )}
      </Show>
    </div>
  )
}
