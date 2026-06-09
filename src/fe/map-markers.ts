import * as maplibregl from 'maplibre-gl'

export function stopColor(index: number, total: number): string {
  if (total === 1) return '#3b82f6'
  if (index === 0) return '#22c55e'
  if (index === total - 1) return '#ef4444'
  return '#3b82f6'
}

/**
 * Build a context menu from a declarative items list.
 */
function buildPoiMenu(
  name: string,
  lat: number,
  lng: number,
  type: string,
): HTMLDivElement {
  const menu = document.createElement('div')
  menu.className = 'map-contextmenu'

  const title = document.createElement('div')
  title.className = 'map-contextmenu-title'
  title.textContent = `${name} (${type})`
  menu.appendChild(title)

  const items = [
    {
      label: 'Mapy.cz',
      action: () => window.open(
        `https://en.mapy.cz/zakladni?x=${lng.toFixed(7)}&y=${lat.toFixed(7)}&z=19`,
        '_blank',
      ),
    },
    {
      label: 'Google Maps',
      action: () => window.open(
        `https://www.google.com/maps/@${lat.toFixed(7)},${lng.toFixed(7)},19z`,
        '_blank',
      ),
    },
  ]

  for (const item of items) {
    const el = document.createElement('div')
    el.className = 'map-contextmenu-item'
    el.textContent = item.label
    el.addEventListener('click', () => { item.action(); menu.remove() })
    menu.appendChild(el)
  }
  return menu
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

  el.addEventListener('click', (e) => {
    e.stopPropagation()
    // Remove any existing context menu
    document.querySelectorAll('.map-contextmenu').forEach(m => m.remove())
    const menu = buildPoiMenu(opts.name, opts.lat, opts.lng, opts.type)
    const mapContainer = opts.map.getContainer()
    const rect = el.getBoundingClientRect()
    const containerRect = mapContainer.getBoundingClientRect()
    menu.style.left = `${rect.left - containerRect.left + rect.width / 2}px`
    menu.style.top = `${rect.top - containerRect.top + rect.height + 4}px`
    mapContainer.appendChild(menu)
  })

  return marker
}
