# Gotchas & Hard-Won Lessons

Pitfalls discovered during M001 and M002 that aren't obvious from reading the code alone.

## Distance is already in km

Valhalla returns `trip.summary.length` in **kilometers** when `units: 'kilometers'` is set in the request. Do NOT divide by 1000 — this was a bug in `src/fe/Map.tsx` during M001. The distance value from `GET /api/route` can be used directly as km.

**File:** `src/be/index.ts` (line `units: 'kilometers'`), `src/fe/Map.tsx` (`r().distance.toFixed(1) km`)

## Eden query params must match schema exactly

When calling Eden treaty endpoints with query parameters, the params object must be typed as a narrow object literal matching the Elysia schema — **not** `Record<string, string>`. Eden infers the exact parameter types from the Elysia `t.Object` schema.

```typescript
// ✅ Correct — matches Elysia schema in src/be/index.ts
const params: { q: string; viewbox?: string; bounded?: string } = { q: query }

// ❌ Wrong — Eden can't narrow Record<string, string> to the expected shape
const params: Record<string, string> = { q: query }
```

**File:** `src/fe/Stops.tsx` (`searchGeocode` function, ~line 44)

## Geometry narrowing cast is intentional

The Eden response type for `POST /api/route` infers `geometry: number[][]` because Elysia expresses the schema as `t.Array(t.Array(t.Number()))`. The frontend casts this to `[number, number][]` at the call site:

```typescript
setRoute({ ...data, geometry: data.geometry as [number, number][] })
```

This is **not** an `any` escape — it's boundary narrowing from a wider type to a tuple. The data is guaranteed to be `[lat, lng]` pairs by the backend's `decodePolyline6()` function.

**File:** `src/fe/Stops.tsx` (`calculateRoute` function), `src/be/index.ts` (`decodePolyline6`)

## Port 3002 not 3000

The backend runs on **port 3002** due to a Docker container conflict on port 3000. Both the server and the treaty client URL must match:

- `src/be/index.ts` — `.listen(3002)`
- `src/fe/App.tsx` — `edenTreaty<ElysiaApp>('http://localhost:3002')`

If the backend doesn't start or the frontend shows network errors, check that both files agree on the port.

**Files:** `src/be/index.ts` (last line), `src/fe/App.tsx` (treaty creation)

## Valhalla public instance has rate limits

`valhalla1.openstreetmap.de` is a free public Valhalla instance with undocumented rate limits. Heavy development use (repeated route calculations) can trigger throttling or temporary blocks.

Set `VALHALLA_URL` env var to point to a local Docker Valhalla instance for reliable development:

```bash
VALHALLA_URL=http://localhost:8002 pnpm dev
```

**File:** `src/be/index.ts` (first line: `const VALHALLA_URL = process.env.VALHALLA_URL || ...`)

## Geolocation API requires HTTPS

The browser's `navigator.geolocation.getCurrentPosition()` — used in `src/fe/Map.tsx` to center the map on the user's location — only works in **secure contexts** (HTTPS or localhost). Deploying over plain HTTP will silently fail (the error callback runs, but the map stays at the default view).

**File:** `src/fe/Map.tsx` (`onMount`, geolocation call)

## use_roads maps to 10 road classes

The `roadAvoidanceCoefficient` (0–1) is mapped to ALL 10 Valhalla road classes with the same value. There is no per-class granularity — the coefficient is a blanket preference:

```
motorway, motorway_link, trunk, trunk_link, primary, primary_link,
secondary, secondary_link, tertiary, tertiary_link
```

A value of 0 avoids all road classes equally; 1 allows all equally. This is implemented as a `reduce` over a `roadClasses` array in the route handler.

**File:** `src/be/index.ts` (`roadClasses` const and `use_roads` reduce)

## SQLite DB file is gitignored

The Bun SQLite database `data.db` is created in the `src/be/` working directory at server startup. It is gitignored via the pattern `src/be/data*` in `.gitignore`. The DB is created with WAL journal mode for better concurrent read performance.

**Files:** `src/be/db.ts` (`new Database('data.db')`), `.gitignore` (`src/be/data*`)

## Slider pattern is fully replicable

Adding a new routing costing coefficient follows a mechanical four-step pattern — M002 demonstrated this by replicating the M001 `elevationCoefficient` pattern for `roadAvoidanceCoefficient`:

1. **Shared type** — Add field to `RouteRequest` in `src/shared/index.ts`
2. **Elysia body schema** — Add field with `t.Number({ minimum: 0, maximum: 1 })` to `POST /api/route` body schema in `src/be/index.ts`
3. **Valhalla costing_options** — Map the field to the appropriate Valhalla costing option in `src/be/index.ts`
4. **Kobalte Slider** — Add a `<Slider>` with signal, label, and value binding in `src/fe/Stops.tsx`

**Files:** `src/shared/index.ts`, `src/be/index.ts`, `src/fe/Stops.tsx`

## Nominatim search uses progressive bounding box expansion

The frontend doesn't send a single geocode request — it tries up to 4 searches with progressively wider bounding boxes:

1. Bounded search within the current map view
2. Unbounded search with ~20km expanded viewbox
3. Unbounded search with ~500km expanded viewbox
4. Fallback with no bounds at all

Each level only runs if the previous returned no results. This is implemented in `handleSearch` in `src/fe/Stops.tsx`.

**File:** `src/fe/Stops.tsx` (`handleSearch` and `expandBounds` functions)
