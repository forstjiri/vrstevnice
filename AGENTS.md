# Vrstevnice — Agent Reference

Souhrn klíčových informací pro AI agenty pracující s tímto projektem.

Cyklistický plánovač tras s 3D terénem, stínováním, profilovým grafem a animací jízdy. Všechna data lokální, žádné cloud API.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | SolidJS 1.9, Kobalte 0.13 (UI primitives), MapLibre GL JS (map), Vite 8 (build) |
| Backend | Elysia 1.4 (HTTP), Bun (runtime), Logixlysia (logging) |
| Database | Drizzle ORM + Bun SQLite (WAL mode), soubor v `data/data.db` |
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

Jednorázový setup (po prvním klonu):
```bash
bash scripts/generate-tiles.sh          # ~684 MB vector tiles
bash scripts/generate-terrain-tiles.sh  # ~2 GB terrain-rgb tiles
pnpm extract-routes                   # cyklostezky z OSM (vyžaduje Python + osmium)
```

### Agent pravidla pro BE/FE procesy

- **Nikdy nespouštěj `pnpm dev`, `bun index.ts`, ani žádné dev servery bez svolení uživatele.**
- Pokud potřebuješ BE/FE restart, zeptej se uživatele.
- Pokud BE/FE běží a ty je potřebuješ pro test (Playwright), zeptej se uživatele — on je spustí.
- Pokud jsi omylem vytvořil orphaned procesy, okamžitě je zabij a nahlas to.
- Porty: BE :3002, FE :5173 (nikdy nepoužívej jiné porty)

## Projektová struktura

```
src/
  shared/          @vrstevnice/shared — Stop, GeocodeResult, RouteResponse, RouteRequest
  be/              @vrstevnice/be    — Elysia server (index.ts), geocode.ts, gps.ts, db.ts
  fe/              @vrstevnice/fe    — SolidJS app, MapLibre mapa, elevation chart, GPX export
  routing/         @vrstevnice/routing — GraphHopper Custom Model API, POI pipeline
docker/            GH config, tileserver config, tile generation scripts
tests/             Vitest + Docker GH lifecycle, syntetický OSM graf, e2e smoke
scripts/           extrakce cyklostezek z OSM
data/              mbtiles, GeoJSON, DEM data, SQLite DB (gitignored)
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

## API endpointy

| Metoda | Cesta | Popis |
|--------|-------|-------|
| GET | `/api/geocode` | Hledání míst (Photon) + reverzní geokódování GPS |
| POST | `/api/route` | Výpočet trasy (GraphHopper + volitelná POI pipeline) |
| GET | `/api/history` | Historie tras z SQLite |
| GET | `/api/cycleroutes` | GeoJSON cyklostezek |
| GET | `/api/terrain/:z/:x/:y` | Proxy terrain tiles s 404 fallback (transparent PNG) |

Rate limiting: soft-warn 60 req/min, hard-stop 300 req/min per IP.

## Uživatelské funkce

### Plánování tras
- **4 parametry trasy** (slidery): vyhýbání kopcům, vyhýbání silnicím, preference cyklostezek, limonádová cesta
- **POI pipeline ("Limonádová cesta")**: Overpass API najde hospody/bary/restaurace podél trasy, vloží je jako zastávky a přepočítá trasu přes ně
- **Drag & drop zastávek**: tažení markerů na mapě aktualizuje souřadnice
- **GPX export**: stažení trasy jako GPX 1.1 s elevací

### Mapa
- **3D terén** (Exaggeration slider) + **hillshade** (sluneční osvětlení podle data/času)
- **Vrstevnice** z DEM dat přes maplibre-contour protokol
- **Cyklistické stylování**: zeslabení dálnic/primárek, zvětšení lesních cest (`cycle-path-widen` layer, minzoom 12)
- **KČT cyklostezky**: barevné překrytí z cycleroutes.geojson (~48 MB, budoucnost → vector tiles)
- **Transit vrstvy**: železnice, zastávky vlaků, autobusové zastávky
- **Inspect mode**: zobrazení layer ID, source-layer, zoom, GPS, relevantních OSM tagů
- **Context menu**: přidat zastávku, otevřít Mapy.cz

### Stíny a čas
- **Hillshade**: sluneční osvětlení z data/času + střed mapy (NOAA-style solar position)
- **Nocní overlay**: automatické ztmavení mapy při západu/východu slunce
- **Ride animation**: přehrávání trasy s kamerovým sledem, synchronizací stínů s virtuálním časem

### Profilový graf
- **Fill podle povrchu**: barva plochy pod křivkou odpovídá typu povrchu (asfalt, štěrk, tráva, …)
- **Čára podle typu cesty**: barva křivky odpovídá road_class (path = hnědá přerušovaná, cycleway = růžová přerušovaná, track = olivová plná, …)
- **Hover sync**: najetí myší na graf zobrazí kříž na mapě a naopak
- **Ride animation**: play/pause/reset, speed slider (2×–100×), klik pro seek

### Hledání
- **Photon geocoding**: lokální Docker, CZ databáze, silný location bias
- **GPS koordináty**: zadání DD/DDM/DMS přímo do search pole s automatickou detekcí a reverzním geokódováním
- **Search preview**: dočasný marker na mapě při najetí na návrh

## Debug hooks

- `window.__map` — přístup k MapLibre instanci
- `window.__fitRouteOverview` — fitnutí mapy na trasu

## Klíčová architektonická rozhodnutí

- **Monorepo:** pnpm workspaces — shared typy zajišťují type safety mezi FE a BE přes Eden treaty
- **GraphHopper Custom Models:** umožňuje runtime pravidla (priority multiply_by, speed limit_to, distance_influence) přes Custom Model API
- **Flexible mode (bez CH):** Custom models vyžadují `profiles_ch: []` — pomalejší routování, ale podporuje runtime změny modelu
- **max_visited_nodes: 5M** pro CZ pokrytí (default 1M nestačí na dlouhé cyklo trasy)
- **Photon:** lokální Docker, nativní location bias (location_bias_scale=0.2), žádný viewbox cascade
- **MapLibre GL JS:** vector tiles z lokálního tileserveru, MapTiler Basic style
- **Planetiler + tileserver-gl-light:** jednorázový build step, ~684 MB mbtiles, 15 vector layers, z0-14
- **POI pipeline dvoustupňová:** Base route → Overpass POI dotazy → přepočítání přes rozšířené stops
- **Rate limiting:** elysia-rate-limit, soft-warn 60/min, hard-stop 300/min
- **Datové zdroje:**
  - Vector tiles: `data/cz.mbtiles` (OpenMapTiles, z0–14, ~684 MB)
  - Terrain tiles: `data/cz-terrain.mbtiles` (terrain-rgb, z0–12, ~2 GB)
  - Cyklostezky: `data/cycleroutes.geojson` (~48 MB, 3510 features)
- **Jediná externí API volání** (mimo Docker): Overpass API pro POI pipeline

## Gotchas & Patterny

### Coordinate order — #1 zdroj bugů
- **App používá [lat, lng]** ve všech shared typech
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
- **`minzoom` na layers je integer-only** — `12.5` se silently zaokrouhlí na `13`
- **Planetiler generalizuje** některé track/path features pryč na z12–13; zobrazí se až od vyššího zoomu

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
- Chart↔Map sync: distance-fraction interpolation s binary search (`binarySearchSegment`), nikdy index-based mapping
- Road class stroke: `ROAD_CLASS_COLORS` (lowercase keys matching GH output), `ROAD_CLASS_DASH` pro přerušované čáry
- `binarySearchSegment` boundary: inclusive obou konců, přesná hranice vrací dřívější segment

### Photon
- `zoom` param vyžaduje integer — MapLibre předává float (12.33), vždy `Math.round()`
- `/reverse` bere `lon=...&lat=...` (GeoJSON pořadí)
- location_bias_scale=0.2 = silná lokální preference

### Ride Animation
- `rideAnimationStore.ts`: signals (`rideAnimation`, `updateRideAnimation`) + mutable ref (`cameraTarget`, `setCameraTarget`)
- `untrack()` povinný při čtení `rideAnimation()` v ShadowControls createEffect — jinak infinite SolidJS loop
- Shadow time sync během animace volá `updateHillshadeLightingLocal()` přímo, nikoliv přes `refreshHillshade()` rAF gate
- Camera smoothing: lerp (CAM_LERP=0.06, BEARING_LERP=0.03) s `jumpTo` každý frame

### Testování
- Test GH kontejner na portu 8988 (produkční GH na 8989)
- Bez slope encodings s noop elevation provider — GH throws IllegalArgumentException
- Docker volume mount filename musí přesně match GH config custom_model_files reference
- Vitest `import.meta.url` s non-ASCII cestami → použít `fileURLToPath` + `path.resolve`
- Syntetický graf: collineární uzly mohou být DouglasPeucker odstraněny → přidat zigzag offset (±0.0005°)
- E2E smoke: top-level `await` pro service check před `describe` — `skipIf` na `describe` nefunguje

### Obecné
- Road avoidance penalizuje, nikdy nepromuje — base bike priority pro secondary (~0.3-0.5) je už nižší než residential (~0.8)
- Slider direction pro UX: road avoidance slider je inverted (right = more avoidance)
- Module-level mutable refs pro MapLibre marker instances (imperativní objekty, ne Solid signals)
- SQLite ALTER TABLE migration: try/catch na "duplicate column" error — nevyžaduje recreate
- Konfigurace má být v package.json pokud možno — minimalizovat počet config souborů v repo
- Nepřekládat do starého JS — vždy nejmodernější ES moduly
- Python venvy: `data/.venv-terrain` (terrain tiles), data/ je celá gitignored

## Důležité soubory

| Soubor | Účel |
|--------|------|
| `src/shared/index.ts` | Shared TypeScript interface (Stop, GeocodeResult, RouteResponse, RouteRequest) |
| `src/be/index.ts` | Elysia server — /geocode, /route, /history, /cycleroutes, /terrain endpointy |
| `src/be/geocode.ts` | Photon geocoder mapping (coordinate swap!) |
| `src/be/gps.ts` | GPS parsování (DD/DDM/DMS formáty) |
| `src/be/db.ts` | Drizzle schema + Bun SQLite (`data/data.db`) |
| `src/routing/index.ts` | GraphHopper Custom Model API, POI pipeline, road_class/surface/road_environment details |
| `src/fe/App.tsx` | SolidJS context provider, Eden treaty client |
| `src/fe/Stops.tsx` | Stop management + slidery (Kobalte Search/Slider/Button) |
| `src/fe/Map.tsx` | MapLibre GL mapa — stop markery, polyline, context menu, hillshade, ride animation camera, inspect mode, forest tracks |
| `src/fe/ElevationChart.tsx` | Canvas 2D elevation profil s barvením podle povrchu + road_class, ride animation play/pause/seek |
| `src/fe/chart-constants.ts` | SURFACE_COLORS, ROAD_CLASS_COLORS, ROAD_CLASS_DASH, binarySearchSegment, hexToRgba |
| `src/fe/ShadowControls.tsx` | Hillshade/terrain/time UI, sync s rideAnimationStore |
| `src/fe/rideAnimationStore.ts` | Shared state pro ride animation (playing, speed, cameraTarget) |
| `src/fe/hoverStore.ts` | Hover sync chart↔map |
| `docker-compose.yml` | GH + Photon + tileserver služby |
| `scripts/generate-terrain-tiles.sh` | Generování terrain-rgb mbtiles z Copernicus DEM |
