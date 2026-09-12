# Vrstevnice — Agent Reference

Key information for AI agents working on this project.

Cycling route planner with 3D terrain, shadows, elevation profile chart, and ride animation. All data is local — no cloud APIs.

## Tech Stack

| Layer | Technology |
|-------------|-----------------------------------------------------------------------------------|
| Frontend | SolidJS 1.9, Kobalte 0.13 (UI primitives), MapLibre GL JS (map), Vite 8 (build) |
| Backend | Elysia 1.4 (HTTP), Bun (runtime), Logixlysia (logging) |
| Database | Drizzle ORM + Bun SQLite (WAL mode), file at `data/data.db` |
| Routing | GraphHopper 12.0 (Custom Models API, bike profile, SRTM elevation, flexible mode) |
| Geocoding | Photon in Docker, CZ database |
| Map tiles | Planetiler + tileserver-gl-light (local vector tiles, OpenMapTiles schema) |
| POI | Local SQLite (no external API) |
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

One-time setup (after first clone):

```bash
bash scripts/generate-tiles.sh          # vector tiles + original OSM road-way index for ratings
python3 scripts/generate-terrain-tiles-dmr5g.py --output data/cz-terrain.mbtiles  # DMR 5G terrain-rgb tiles
pnpm extract-routes                   # cycle routes from OSM (requires Python + osmium)
pnpm import-pois                      # SQLite POI DB from OSM PBF
```

### Agent rules for BE/FE processes

- **Never run `pnpm dev`, `bun index.ts`, or any dev servers without user permission.**
- If you need BE/FE restarted, ask the user.
- If BE/FE is running and you need it for testing (Playwright), ask the user — they will start it.
- If you accidentally created orphaned processes, kill them immediately and report it.
- Ports: BE :3002, FE :5173 (never use different ports)

## Project structure

```
src/
  shared/          @vrstevnice/shared — Stop, GeocodeResult, RouteResponse, RouteRequest
  be/              @vrstevnice/be    — Elysia server (index.ts), geocode.ts, gps.ts, db.ts, pois.ts
  fe/              @vrstevnice/fe    — SolidJS app, MapLibre mapa, elevation chart, GPX export
  routing/         @vrstevnice/routing — GraphHopper Custom Model API, POI pipeline
docker/            GH config, tileserver config, tile generation scripts
tests/             Vitest + Docker GH lifecycle, synthetic OSM graph, e2e smoke
scripts/           OSM data extraction (cycle routes, POIs)
data/              mbtiles, GeoJSON, DEM data, SQLite DB (gitignored)
```

## Ports

| Service | Port | Notes |
|-------------|------|--------------------------------------------|
| Backend | 3002 | 3000 taken by Docker |
| Frontend | 5173 | Vite dev server |
| GraphHopper | 8989 | israelhikingmap/graphhopper, flexible mode |
| GH (test) | 8988 | For tests, external 8988→internal 8989 |
| Photon | 2322 | Local geocoder, CZ database |
| tileserver | 2323 | Vector tiles from data/cz.mbtiles |

## API endpoints

| Method | Path | Description |
|--------|-------------------------|------------------------------------------------------|
| GET | `/api/geocode` | Place search (Photon) + reverse GPS geocoding |
| POST | `/api/route` | Route calculation (GraphHopper + optional POI pipeline + optional shadow profile) |
| GET | `/api/history` | Route history from SQLite |
| GET | `/api/cycleroutes` | GeoJSON of cycle routes |
| GET | `/api/terrain/:z/:x/:y` | Terrain tile proxy with 404 fallback (transparent PNG) |
| GET | `/api/road-rating-roads?bbox=minLng,minLat,maxLng,maxLat` | Original OSM road ways in viewport for rating interaction |
| GET | `/api/road-ratings?bbox=minLng,minLat,maxLng,maxLat` | Aggregated rated roads in viewport |
| GET | `/api/road-ratings/:wayId` | Aggregate for one OSM way and requesting IP |
| POST | `/api/road-ratings` | Create or update the requesting IP's road rating |
| DELETE | `/api/road-ratings/:wayId` | Remove the requesting IP's rating |

Rate limiting: soft-warn 60 req/min, hard-stop 300 req/min per IP.

## User features

### Route planning

- **4 route parameters** (sliders): avoid ascent, avoid roads, prefer cycleways, lemonade route
- **Avoid ascent** uses a two-tier GH custom model: (a) constant light penalty for steep sections
  both directions (`max_slope >/< 12` → 0.8, always on), (b) slider-controlled uphill-only
  penalty (`average_slope > 3/6/10`). Post-hoc ascent guard: two parallel GH queries, returns
  whichever has less total ascent, guaranteeing ascent never increases with slider.
- **POI pipeline ("Limonádová cesta")**: local SQLite finds pubs/bars/restaurants along the route and reroutes through them
- **Drag & drop stops**: dragging markers on the map updates coordinates
- **GPX export**: download route as GPX 1.1 with elevation

### Road ratings

- **Rating mode**: transient `👍👎 Hodnocení cest` mode enables road hover/click and a modal with multi-select reasons.
- **Community routing**: persisted `👥 Komunitní hodnocení` opt-in applies ratings to route calculation; saving or
  deleting a rating recalculates only when an active route and this opt-in are both enabled.
- **Bubbles**: rated roads show aggregate and per-subtype counts while rating mode is active at zoom ≥ 12.
- **Identity and storage**: v1 identity is the requesting IP. A rating targets one connected same-name street group
  (or one unnamed OSM way); `rated_roads` stores its cached geometry and anchor data, while `road_ratings` stores
  votes with a unique `(way_id, ip)` upsert.

### Map

- **3D terrain** (Exaggeration slider) + **hillshade** (solar lighting from date/time + map center)
- **Contour lines** from DEM data via maplibre-contour protocol
- **Cycling styling**: highways/primary roads dimmed, forest tracks widened (`cycle-path-widen` layer, minzoom 12)
- **KČT cycle routes**: colored overlay from cycleroutes.geojson (~48 MB, future: vector tiles)
- **Transit layers**: railways, train stops, bus stops
- **Inspect mode**: shows layer ID, source-layer, zoom, GPS, relevant OSM tags
- **Context menu**: add stop, open Mapy.cz

### Shadows and time

- **Hillshade**: solar lighting from date/time + map center (NOAA-style solar position)
- **Night overlay**: automatic map darkening at sunrise/sunset based on chosen date/time
- **Ride animation**: route playback with camera tracking, shadow sync with virtual time

### Elevation profile chart

- **Surface-colored fill**: area under the curve colored by surface type (asphalt, gravel, grass, …)
- **Road-class line color**: line color reflects road_class (path = brown dashed, cycleway = pink dashed,
  track = olive solid, …)
- **Hover sync**: hovering over chart shows crosshair on map and vice versa
- **Ride animation**: play/pause/reset, speed slider (2×–100×), click to seek

### Search

- **Photon geocoding**: local Docker, CZ database, strong location bias
- **GPS coordinates**: enter DD/DDM/DMS directly in search field with auto-detection and reverse geocoding
- **Search preview**: temporary marker on map when hovering over a suggestion

## Debug hooks

- `window.__map` — access MapLibre instance
- `window.__fitRouteOverview` — fit map to route bounds

## Key architectural decisions

- **Monorepo:** pnpm workspaces — shared types ensure type safety between FE and BE via Eden treaty
- **GraphHopper Custom Models:** enables runtime rules (priority multiply_by, speed limit_to, distance_influence)
  via Custom Model API
- **Flexible mode (no CH):** Custom models require `profiles_ch: []` — slower routing but supports runtime
  model changes
- **max_visited_nodes: 5M** for CZ coverage (default 1M is not enough for long cycle routes)
- **Photon:** local Docker, native location bias (location_bias_scale=0.2), no viewbox cascade
- **MapLibre GL JS:** vector tiles from local tileserver, MapTiler Basic style
- **Planetiler + tileserver-gl-light:** one-time build step, ~684 MB mbtiles, 15 vector layers, z0-14
- **POI pipeline two-stage:** Base route → local SQLite POI queries → reroute through extended stops
- **Rate limiting:** elysia-rate-limit, soft-warn 60/min, hard-stop 300/min
- **Road ratings:** write endpoints use a manual sliding-window limit of 2/min and 20/hour per IP. The first vote
  resolves a connected same-name group from exact original OSM ways in `data/road-rating-roads.sqlite`; no external
  API is used.
- **Road-rating routing:** OSM way IDs cannot be referenced in GraphHopper custom-model expressions. Rated ways are
  buffered into closed `[lng, lat]` Polygon areas inside `custom_model.areas`; `in_<id>` rules use median-aggregated
  multipliers. Only rated roads anchored in the stops bbox plus 10 km corridor are used, capped at 200, and the
  same areas/rules are applied to both ascent-guard queries.
- **Data sources:**
  - Vector tiles: `data/cz.mbtiles` (OpenMapTiles, z0–14, ~684 MB)
  - Terrain tiles: `data/cz-terrain.mbtiles` (terrain-rgb, DMR 5G z0–14)
  - Cycle routes: `data/cycleroutes.geojson` (~48 MB, 3510 features)
  - Road ratings: `data/road-rating-roads.sqlite` (original OSM highway ways with R-tree viewport index)
  - POIs: `data/cz-pois.sqlite` (~20k amenity nodes: pubs, bars, restaurants, cafes, biergartens)
- **Zero external API calls** (all data local)

## Gotchas & Patterns

### Coordinate order — #1 source of bugs

- **App uses [lat, lng]** in all shared types
- **Photon/GeoJSON uses [lon, lat]** — explicit swap with comment in mapPhotonFeature()
- **MapLibre uses [lng, lat]** — `toLngLat()` helper at every API boundary
- **GraphHopper returns [lon, lat, ele]** in GeoJSON structure
- **SQLite POI queries use lat, lng** (standard order)

### Eden Treaty

- Query params must be explicitly typed — never `Record<string, string>`
- `t.Array(t.Array(t.Number()))` infers `number[][]`, not `[number, number][]` — narrowing cast is fine
- Elysia response schema must mirror RouteResponse — Eden infers from Elysia schema, not from shared type

### GraphHopper

- Docker image: `israelhikingmap/graphhopper:latest` — community fork with pre-built SRTM
- GH 12.0 requires `import.osm.ignored_highways: ''` in config
- Custom model file name must not be named like built-in profiles (bike.json, car.json)
- `points_encoded: false` → GeoJSON structure `{ type: "LineString", coordinates: [[lon, lat, ele], ...] }`
- Distance in meters, time in milliseconds
- Do not use `abs()` in custom model expressions — not allowed
- Encoded value names: `average_slope` and `max_slope` (not `slope`)
- Slope values are SIGNED: positive = uphill, negative = downhill. `average_slope > 6` matches only uphill edges.
- Surface details come as `[fromIdx, toIdx, surfaceValue]` triples

### MapLibre GL JS

- **Style-load gate is required** — all addSource/addLayer/getSource must be AFTER `load` event
- **No setDOMContent on Marker** — when marker content changes, remove and recreate
- GeoJSON source expects `Feature` with `properties` field — always include even if empty
- Context menu is a custom div — MapLibre has no built-in
- **`minzoom` on layers is integer-only** — `12.5` silently rounds to `13`
- **Planetiler generalizes** some track/path features away at z12–13; they only appear at higher zoom

### POI pipeline (local SQLite)

- Bounding-box pre-filter with haversine post-filter (bbox is widened by 5% for circle corners)
- Dynamic sample count: `min(20, max(8, ceil(routeKm / 5)))` — ~1 sample per 5km
- Search radius scales with coefficient: 1× at low coeff, up to 4× at full coeff, max 2000m
- Fallback pattern: query errors → `[]` → base route is returned as fallback

### Elysia

- `onBeforeHandle` in a separate plugin requires `{ as: 'global' }` otherwise it never fires
- logixlysia file logging captures only access logs — custom log entries via `appendFile()`
- elysia-rate-limit `errorResponse` is a static value (string|Response|Error), not a callback — use custom Error subclass
  for 429

### Canvas Elevation Chart

- HiDPI scaling: canvas.width/height = displayWidth * devicePixelRatio, ctx.scale(dpr, dpr)
- ResizeObserver on container div for re-scale on resize
- Surface-colored segments: group consecutive same-color points for efficient drawing (~245 draw calls vs ~5000)
- Chart↔Map sync: distance-fraction interpolation with binary search (`binarySearchSegment`), never index-based mapping
- Road class stroke: `ROAD_CLASS_COLORS` (lowercase keys matching GH output), `ROAD_CLASS_DASH` for dashed lines
- `binarySearchSegment` boundary: inclusive on both ends, exact boundary returns earlier segment

### Photon

- `zoom` param requires integer — MapLibre passes float (12.33), always use `Math.round()`
- `/reverse` takes `lon=...&lat=...` (GeoJSON order)
- location_bias_scale=0.2 = strong local preference

### Ride Animation

- `rideAnimationStore.ts`: signals (`rideAnimation`, `updateRideAnimation`) + mutable ref (`cameraTarget`,
  `setCameraTarget`)
- `untrack()` required when reading `rideAnimation()` in ShadowControls createEffect — otherwise infinite SolidJS loop
- Shadow time sync during animation calls `updateHillshadeLightingLocal()` directly, not via `refreshHillshade()` rAF gate
- Camera smoothing: lerp (CAM_LERP=0.06, BEARING_LERP=0.03) with `jumpTo` every frame

### Testing

- Road ratings core: run `pnpm vitest run tests/road-ratings.test.ts` for the targeted pure-unit suite.
- Test GH container on port 8988 (production GH on 8989)
- Without slope encodings with noop elevation provider — GH throws IllegalArgumentException
- Docker volume mount filename must exactly match GH config custom_model_files reference
- Vitest `import.meta.url` with non-ASCII paths → use `fileURLToPath` + `path.resolve`
- Synthetic graph: collinear nodes can be removed by DouglasPeucker → add zigzag offset (±0.0005°)
- E2E smoke: top-level `await` for service check before `describe` — `skipIf` on `describe` does not work

### General

- Road avoidance penalizes, never promotes — base bike priority for secondary (~0.3-0.5) is already lower than
  residential (~0.8)
- Slider direction for UX: road avoidance slider is inverted (right = more avoidance)
- Module-level mutable refs for MapLibre marker instances (imperative objects, not Solid signals)
- SQLite ALTER TABLE migration: try/catch on "duplicate column" error — does not require recreate
- Configuration should be in package.json when possible — minimize number of config files in repo
- Never transpile to old JS — always use modern ES modules
- Python venvs: `data/.venv-extract` (osmium), data/ is entirely gitignored

## Important files

| File | Purpose |
|-------------------------------------------|------------------------------------------------------------------------------------------------------------------------|
| `src/shared/index.ts` | Shared TypeScript interfaces (Stop, GeocodeResult, RouteResponse, RouteRequest) |
| `src/be/index.ts` | Elysia server — /geocode, /route, /history, /cycleroutes, /terrain |
| `src/be/geocode.ts` | Photon geocoder mapping (coordinate swap!) |
| `src/be/gps.ts` | GPS parsing (DD/DDM/DMS formats) |
| `src/be/db.ts` | Drizzle schema + Bun SQLite (`data/data.db`) |
| `src/be/pois.ts` | Local SQLite POI query with bbox pre-filter + haversine post-filter |
| `src/be/road-ratings.ts` | Road-rating SQLite service and original OSM-way spatial index |
| `src/be/road-ratings-core.ts` | Pure road-rating aggregation, buffering, chaining, throttle, and area helpers |
| `src/routing/index.ts` | GraphHopper Custom Model API, POI pipeline, road_class/surface/road_environment details |
| `src/fe/App.tsx` | SolidJS context provider, Eden treaty client |
| `src/fe/Stops.tsx` | Stop management + sliders (Kobalte Search/Slider/Button) |
| `src/fe/Map.tsx` | MapLibre GL map — stop markers, polyline, context menu, hillshade, ride animation camera, inspect mode, forest tracks |
| `src/fe/ElevationChart.tsx` | Canvas 2D elevation profile with surface color fill + road_class stroke, ride animation controls |
| `src/fe/chart-constants.ts` | SURFACE_COLORS, ROAD_CLASS_COLORS, ROAD_CLASS_DASH, binarySearchSegment, hexToRgba |
| `src/fe/ShadowControls.tsx` | Hillshade/terrain/time UI, sync with rideAnimationStore |
| `src/fe/roadRatingsStore.ts` | Road-rating Solid state and typed Eden API actions |
| `src/fe/RoadRatingModal.tsx` | Road-rating reason selection and save/delete modal |
| `src/fe/rideAnimationStore.ts` | Shared state for ride animation (playing, speed, cameraTarget) |
| `src/fe/hoverStore.ts` | Hover sync chart↔map |
| `docker-compose.yml` | GH + Photon + tileserver services |
| `scripts/generate-terrain-tiles-dmr5g.py` | Generate terrain-rgb mbtiles from ČÚZK DMR 5G |
| `scripts/import-pois.py` | Extract amenity nodes from OSM PBF into SQLite POI database |
| `scripts/extract_bicycle_routes.py` | Extract cycle route relations from OSM PBF into GeoJSON |
