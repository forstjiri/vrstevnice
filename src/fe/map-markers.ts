import * as maplibregl from 'maplibre-gl';

export function stopColor(index: number, total: number): string {
  if (total === 1) return '#3b82f6';
  if (index === 0) return '#22c55e';
  if (index === total - 1) return '#ef4444';
  return '#3b82f6';
}

export function buildContextMenu(
  items: { label: string; action: () => void }[],
  title?: string,
): HTMLDivElement {
  const menu = document.createElement('div');
  menu.className = 'map-contextmenu';

  if (title) {
    const titleEl = document.createElement('div');
    titleEl.className = 'map-contextmenu-title';
    titleEl.textContent = title;
    menu.appendChild(titleEl);
  }

  items.forEach((item) => {
    const el = document.createElement('div');
    el.className = 'map-contextmenu-item';
    el.textContent = item.label;
    el.addEventListener('click', () => {
      item.action();
      menu.remove();
    });
    menu.appendChild(el);
  });
  return menu;
}

export function createStopElement(color: string, index: number, _name: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'stop-marker';
  const dot = document.createElement('span');
  dot.className = 'stop-marker-dot';
  dot.style.background = color;
  dot.textContent = `${index + 1}`;
  el.appendChild(dot);
  return el;
}

let tooltipEl: HTMLDivElement | null = null;

function showTooltip(text: string, x: number, y: number) {
  if (!tooltipEl) {
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'poi-tooltip';
    document.body.appendChild(tooltipEl);
  }
  tooltipEl.textContent = text;
  tooltipEl.style.left = `${x}px`;
  tooltipEl.style.top = `${y - 8}px`;
  tooltipEl.style.display = 'block';
}

function hideTooltip() {
  if (tooltipEl) tooltipEl.style.display = 'none';
}

export function createPoiElement(name: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'poi-marker';
  el.textContent = '🍺';
  el.addEventListener('mouseenter', (e) => {
    showTooltip(name, e.clientX, e.clientY);
  });
  el.addEventListener('mouseleave', hideTooltip);
  return el;
}

export function createStopMarker(opts: {
  color: string;
  index: number;
  name: string;
  lat: number;
  lng: number;
  map: maplibregl.Map;
  onDragEnd: (lat: number, lng: number) => void;
}): maplibregl.Marker {
  const el = createStopElement(opts.color, opts.index, opts.name);
  const marker = new maplibregl.Marker({
    element: el,
    draggable: true,
    anchor: 'center',
  })
    .setLngLat([opts.lng, opts.lat])
    .addTo(opts.map);

  marker.on('dragend', () => {
    const pos = marker.getLngLat();
    opts.onDragEnd(pos.lat, pos.lng);
  });

  el.addEventListener('click', () => {
    new maplibregl.Popup({ offset: 14, closeButton: false })
      .setLngLat([opts.lng, opts.lat])
      .setText(opts.name)
      .addTo(opts.map);
  });

  return marker;
}

export function createPoiMarker(opts: {
  name: string;
  type: string;
  lat: number;
  lng: number;
  map: maplibregl.Map;
  onAddStop?: () => void;
}): maplibregl.Marker {
  const el = createPoiElement(opts.name);
  const marker = new maplibregl.Marker({
    element: el,
    anchor: 'center',
  })
    .setLngLat([opts.lng, opts.lat])
    .addTo(opts.map);

  el.addEventListener('click', (e) => {
    e.stopPropagation();
    // Remove any existing context menu
    document.querySelectorAll('.map-contextmenu').forEach((m) => m.remove());
    const menu = buildContextMenu(
      [
        {
          label: 'Mapy.cz',
          action: () => window.open(
            `https://en.mapy.cz/zakladni?x=${opts.lng.toFixed(7)}&y=${opts.lat.toFixed(7)}&z=19`,
            '_blank',
          ),
        },
        {
          label: 'Google Maps',
          action: () => window.open(
            `https://www.google.com/maps/@${opts.lat.toFixed(7)},${opts.lng.toFixed(7)},19z`,
            '_blank',
          ),
        },
        ...(opts.onAddStop
          ? [
            {
              label: 'Přidat jako průjezdní bod',
              action: opts.onAddStop,
            },
          ]
          : []),
      ],
      `${opts.name} (${opts.type})`,
    );
    const mapContainer = opts.map.getContainer();
    const rect = el.getBoundingClientRect();
    const containerRect = mapContainer.getBoundingClientRect();
    menu.style.left = `${rect.left - containerRect.left + rect.width / 2}px`;
    menu.style.top = `${rect.top - containerRect.top + rect.height + 4}px`;
    mapContainer.appendChild(menu);
  });

  // Close context menu on map click
  opts.map.on('click', () => {
    document.querySelectorAll('.map-contextmenu').forEach((m) => m.remove());
  });

  return marker;
}
