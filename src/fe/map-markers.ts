import maplibregl from 'maplibre-gl'

export function stopColor(index: number, total: number): string {
  if (total === 1) return '#3b82f6'
  if (index === 0) return '#22c55e'
  if (index === total - 1) return '#ef4444'
  return '#3b82f6'
}

export function createStopElement(color: string, index: number, name: string): HTMLElement {
  const el = document.createElement('div')
  el.className = 'stop-marker'
  const dot = document.createElement('span')
  dot.className = 'stop-marker-dot'
  dot.style.background = color
  dot.textContent = `${index + 1}`
  el.appendChild(dot)
  return el
}

export function createPoiElement(name: string, dimmed = false): HTMLElement {
  const el = document.createElement('div')
  el.className = dimmed ? 'poi-marker poi-marker-dimmed' : 'poi-marker'
  el.textContent = '🍺'
  el.title = name
  el.style.cursor = 'pointer'
  return el
}

export function createStopMarker(opts: {
  color: string; index: number; name: string;
  lat: number; lng: number;
  map: maplibregl.Map;
  onDragEnd: (lat: number, lng: number) => void;
}): maplibregl.Marker {
  const el = createStopElement(opts.color, opts.index, opts.name)
  const marker = new maplibregl.Marker({
    element: el, draggable: true, anchor: 'center',
  })
    .setLngLat([opts.lng, opts.lat])
    .addTo(opts.map)

  marker.on('dragend', () => {
    const pos = marker.getLngLat()
    opts.onDragEnd(pos.lat, pos.lng)
  })

  el.addEventListener('click', () => {
    new maplibregl.Popup({ offset: 14, closeButton: false })
      .setLngLat([opts.lng, opts.lat])
      .setText(opts.name)
      .addTo(opts.map)
  })

  return marker
}

export function createPoiMarker(opts: {
  name: string; type: string;
  lat: number; lng: number;
  map: maplibregl.Map;
  dimmed?: boolean;
}): maplibregl.Marker {
  const el = createPoiElement(opts.name, opts.dimmed)
  const marker = new maplibregl.Marker({
    element: el, anchor: 'center',
  })
    .setLngLat([opts.lng, opts.lat])
    .addTo(opts.map)

  el.addEventListener('click', () => {
    new maplibregl.Popup({ offset: 11, closeButton: false })
      .setLngLat([opts.lng, opts.lat])
      .setHTML(`<b>${opts.name}</b><br/>${opts.type}`)
      .addTo(opts.map)
  })

  return marker
}
