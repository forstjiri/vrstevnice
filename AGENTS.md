# Vrstevnice — Agent Reference

Souhrn klíčových informací pro AI agenty pracující s tímto projektem.

## Tech Stack (aktuální)

| Layer | Technology |
|-------|-----------|
| Frontend | SolidJS 1.9, Kobalte 0.13 (UI primitives), MapLibre GL JS (map), Vite 8 (build) |
| Backend | Elysia 1.4 (HTTP), Bun (runtime), Logixlysia (logging) |
| Database | Drizzle ORM + Bun SQLite (WAL mode) |
| Routing | GraphHopper 12.0 (Custom Models API, bike profile, SRTM elevation, flexible mode) |
| Geocoding | Photon (komoot) v Dockeru, CZ databáze |
| Map tiles | Planetiler + tileserver-gl-light (lokální vector tiles, OpenMapTiles schema) |
| POI | Overpass API (hospody/bary/restaurace podél trasy) |
| Type safety | Eden treaty (end-to-end typed API client) |
| Monorepo | pnpm workspaces |

## How to Run

```bash
pnpm install
docker compose up -d     # GH (:8989), Photon (:2322), tileserver (:2323)
pnpm dev                 # BE on :3002, FE on :5173
pnpm typecheck           # tsc --build
pnpm test                # Vitest
```

## Projektová struktura

```
src/
  shared/          @vrstevnice/shared — Stop, GeocodeResult, RouteResponse, RouteRequest
  be/              @vrstevnice/be    — Elysia server (index.ts), geocode.ts, gps.ts, db.ts
  fe/              @vrstevnice/fe    — SolidJS app, MapLibre mapa, elevation chart, GPX export
  routing/         @vrstevnice/routing — GraphHopper Custom Model API, POI pipeline
docker/            GH config, tileserver config, verify scripts
tests/             Vitest + Docker GH lifecycle, syntetický OSM graf
docs/              Architektura, API, gotchas (částečně zastaralé)
```

## Porty

| Služba | Port | Poznámka |
|--------|------|----------|
| Backend | 3002 | 3000 obsazen Dockerem |
| Frontend | 5173 | Vite dev server |
| GraphHopper | 8989 | israelhikingmap/graphhopper, flexible mode |
| GH (test) | 8988 | Pro testy, externí port 8988→interní 8989 |
| Photon | 2322 | Lokální geocoder, CZ databáze |
| tileserver | 2323 | Vector tiles z data/cz.mbtiles |

## Klíčová architektonická rozhodnutí

- **Monorepo:** pnpm workspaces — shared typy zajišťují type safety mezi FE a BE přes Eden treaty
- **GraphHopper Custom Models:** Nahradil Valhallu (D005) — umožňuje runtime pravidla (priority multiply_by, speed limit_to, distance_influence) přes Custom Model API
- **Flexible mode (bez CH):** Custom models vyžadují `profiles_ch: []` — pomalejší routování, ale podporuje runtime změny modelu
- **max_visited_nodes: 5M** pro CZ pokrytí (default 1M nestačí na dlouhé cyklo trasy)
- **Photon nahradil Nominatim:** (D026) — lokální Docker, nativní location bias (location_bias_scale=0.2), žádný viewbox cascade
- **MapLibre nahradil Leaflet:** (D039) — vector tiles z lokálního tileserveru, MapTiler Basic style s cyklostezky layer
- **Planetiler + tileserver-gl-light:** (D037) — jednorázový build step, ~684 MB mbtiles, 15 vector layers, z0-14
- **POI pipeline dvoustupňová:** Base route → Overpass POI dotazy → přepočítání přes rozšířené stops
- **Rate limiting:** elysia-rate-limit, soft-warn 60/min, hard-stop 300/min

## Gotchas & Patterny

### Coordinate order — #1 zdroj bugů
- **App používá [lat, lng]** (Leaflet konvence) ve všech shared typech
- **Photon/GeoJSON používá [lon, lat]** — explicit swap s komentářem v mapPhotonFeature()
- **MapLibre používá [lng, lat]** — `toLngLat()` helper na každém API boundary
- **GraphHopper vrací [lon, lat, ele]** v GeoJSON struktuře
- **Overpass QL používá lat,lon pořadí** (na rozdíl od GeoJSON)

### Eden Treaty
- Query params musí být explicitně typované — nikdy `Record<string, string>`
- `t.Array(t.Array(t.Number()))` inferuje `number[][]`, ne `[number, number][]` — narrowing cast je v pořádku
- Elysia response schema musí mirrorovat RouteResponse — Eden inferuje z Elysia schema, ne ze shared typu

### GraphHopper
- Docker image: `israelhikingmap/graphhopper:latest` — komunitní fork s předpřipraveným SRTM
- GH 12.0 vyžaduje `import.osm.ignored_highways: ''` v configu
- Custom model file name se nesmí jmenovat jako built-in profily (bike.json, car.json)
- `points_encoded: false` → GeoJSON struktura `{ type: "LineString", coordinates: [[lon, lat, ele], ...] }`
- Vzdálenost v metrech, čas v milisekundách
- Nepoužívat `abs()` v custom model expressions — není povoleno
- Názvy encoded values: `average_slope` a `max_slope` (ne `slope`)
- Surface detail přijde jako `[fromIdx, toIdx, surfaceValue]` triples

### MapLibre GL JS
- **Style-load gate je povinný** — všechny addSource/addLayer/getSource musí být PO `load` eventu
- **Žádné setDOMContent na Marker** — při změně obsahu markeru remove+recreate
- GeoJSON source expects `Feature` s `properties` field — vždy include i když prázdný
- Context menu je custom div — MapLibre nemá built-in

### Overpass API
- Vrací HTML error pages při 503 — vždy zkontrolovat `content-type` před JSON parse
- Dynamic sample count: `min(20, max(8, ceil(routeKm / 5)))` — ~1 vzorek na 5km
- Search radius: `min(1200, interval * 0.5)`
- Fallback pattern: Overpass chyby → `[]` → base route se vrací jako fallback

### Elysia
- `onBeforeHandle` v separate plugin vyžaduje `{ as: 'global' }` jinak se nikdy nezavolá
- logixlysia file logging zachytává jen access logy — custom log entries přes `appendFile()`
- elysia-rate-limit `errorResponse` je static value (string|Response|Error), ne callback — použít custom Error subclass pro 429

### Canvas Elevation Chart
- HiDPI scaling: canvas.width/height = displayWidth * devicePixelRatio, ctx.scale(dpr, dpr)
- ResizeObserver na container div pro re-scale při resize
- Surface-colored segments: group consecutive same-color points pro efektivní kresbu (~245 draw calls místo ~5000)
- Chart↔Map sync: distance-fraction interpolation s binary search, nikdy index-based mapping

### Photon
- `zoom` param vyžaduje integer — MapLibre předává float (12.33), vždy `Math.round()`
- `/reverse` bere `lon=...&lat=...` (GeoJSON pořadí)
- location_bias_scale=0.2 = silná lokální preference

### Testování
- Test GH kontejner na portu 8988 (produkční GH na 8989)
- Bez slope encodings s noop elevation provider — GH throws IllegalArgumentException
- Docker volume mount filename musí přesně match GH config custom_model_files reference
- Vitest `import.meta.url` s non-ASCII cestami → použít `fileURLToPath` + `path.resolve`
- Syntetický graf: collineární uzly mohou být DouglasPeucker odstraněny → přidat zigzag offset (±0.0005°)

### Obecné
- Road avoidance penalizuje, nikdy nepromuje — base bike priority pro secondary (~0.3-0.5) je už nižší než residential (~0.8)
- Slider direction pro UX: road avoidance slider je inverted (right = more avoidance)
- Module-level mutable refs pro Leaflet/MapLibre marker instances (imperativní objekty, ne Solid signals)
- SQLite ALTER TABLE migration: try/catch na "duplicate column" error — nevyžaduje recreate

## Důležité soubory

| Soubor | Účel |
|--------|------|
| `src/shared/index.ts` | Shared TypeScript interface (Stop, GeocodeResult, RouteResponse, RouteRequest) |
| `src/be/index.ts` | Elysia server — /geocode, /route, /history endpointy |
| `src/be/geocode.ts` | Photon geocoder mapping (coordinate swap!) |
| `src/be/gps.ts` | GPS parsování (DD/DDM/DMS formáty) |
| `src/be/db.ts` | Drizzle schema + Bun SQLite |
| `src/routing/index.ts` | GraphHopper Custom Model API, POI pipeline |
| `src/fe/App.tsx` | SolidJS context provider, Eden treaty client |
| `src/fe/Stops.tsx` | Stop management + slidery (Kobalte Search/Slider/Button) |
| `src/fe/Map.tsx` | MapLibre GL mapa — stop markery, polyline, context menu |
| `src/fe/ElevationChart.tsx` | Canvas 2D elevation profil s barvením podle povrchu |
| `docker-compose.yml` | GH + Photon + tileserver služby |
