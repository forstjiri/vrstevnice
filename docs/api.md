# API Reference

Three Elysia endpoints under `/api`, served by `src/be/index.ts`. Types flow from `src/shared/index.ts` via the Eden treaty.

## GET /api/geocode

Geocodes a place name using Nominatim. Returns matching locations with coordinates.

### Query Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `q` | `string` (minLength 1) | Yes | Search query — place name or address |
| `viewbox` | `string` | No | Bounding box as `west,south,east,north` |
| `bounded` | `string` | No | Set to `"1"` to restrict results to viewbox |

### Response

`GeocodeResult[]` — array of matching places.

```typescript
interface GeocodeResult {
  lat: number
  lng: number
  name: string        // short name (first part of display_name)
  displayName: string  // full Nominatim display_name
}
```

### External API

Nominatim Search API at `https://nominatim.openstreetmap.org/search`. Parameters forwarded:

- `format=json`
- `q=<query>`
- `limit=5`
- `accept-language=cs`
- `viewbox=<viewbox>` (only if `viewbox` param is provided)
- `bounded=<bounded>` (only if `viewbox` is set and `bounded=1`)

Rate limit: 1 request per second (Nominatim policy). The frontend Kobalte Search uses 300ms debounce in `src/fe/Stops.tsx`.

## POST /api/route

Plans a bicycle route between stops with configurable elevation and road preferences. Returns route geometry, distance, duration, and elevation profile.

### Request Body

`RouteRequest` from `src/shared/index.ts`:

```typescript
interface RouteRequest {
  stops: Stop[]                    // 2+ waypoints
  elevationCoefficient: number     // 0–1, maps to Valhalla use_hills
  roadAvoidanceCoefficient: number // 0–1, maps to Valhalla use_roads
}

interface Stop {
  lat: number
  lng: number
  name: string
}
```

### Response

`RouteResponse` from `src/shared/index.ts`:

```typescript
interface RouteResponse {
  geometry: [number, number][]  // [lat, lng] pairs from decodePolyline6
  distance: number              // km (Valhalla returns km with units: 'kilometers')
  duration: number              // seconds
  elevationGain: number         // meters, rounded
  elevationLoss: number         // meters, rounded
}
```

### Valhalla Integration

**Route request** — POST to `${VALHALLA_URL}/route`:

```json
{
  "locations": [{ "lat": ..., "lon": ..., "type": "break" }, ...],
  "costing": "bicycle",
  "costing_options": {
    "bicycle": {
      "use_hills": <elevationCoefficient>,
      "use_roads": {
        "motorway": <roadAvoidanceCoefficient>,
        "motorway_link": <roadAvoidanceCoefficient>,
        "trunk": <roadAvoidanceCoefficient>,
        "trunk_link": <roadAvoidanceCoefficient>,
        "primary": <roadAvoidanceCoefficient>,
        "primary_link": <roadAvoidanceCoefficient>,
        "secondary": <roadAvoidanceCoefficient>,
        "secondary_link": <roadAvoidanceCoefficient>,
        "tertiary": <roadAvoidanceCoefficient>,
        "tertiary_link": <roadAvoidanceCoefficient>
      }
    }
  },
  "units": "kilometers"
}
```

**Geometry decode** — Valhalla returns a polyline6 encoded string in `trip.legs[0].shape`. Decoded by `decodePolyline6()` in `src/be/index.ts` into `[lat, lng][]`.

**Elevation** — POST to `${VALHALLA_URL}/height` with the decoded shape and `resample_distance: 50`. Returns `height[]` array; elevation gain/loss computed by summing positive/negative differences between consecutive height values.

### Database Persistence

After a successful route calculation, the route is inserted into the `routes` table via Drizzle ORM. See `src/be/db.ts` for schema.

## GET /api/history

Returns all saved routes ordered by creation time.

### Response

```typescript
// Drizzle inferred type from the routes table
{
  id: number
  name: string       // "Trasa <ISO timestamp>"
  stops: string      // JSON stringified Stop[]
  geometry: string   // JSON stringified [lat, lng][]
  distance: number | null
  duration: number | null
  elevationGain: number | null
  elevationLoss: number | null
  createdAt: string  // ISO datetime
}[]
```

### Query

```typescript
db.select().from(routes).orderBy(routes.createdAt).all()
```

Note: `stops` and `geometry` are stored as JSON strings — the client must parse them. `distance`, `duration`, `elevationGain`, and `elevationLoss` are nullable (`real` columns with no NOT NULL constraint).

## External APIs

### Nominatim (OpenStreetMap)

- **Purpose:** Geocoding — place name to coordinates
- **Base URL:** `https://nominatim.openstreetmap.org`
- **Rate limit:** 1 request/second
- **Usage policy:** Must include valid User-Agent; results must not be cached long-term
- **Configurable:** No — URL is hardcoded in `src/be/index.ts`

### Valhalla

- **Purpose:** Bicycle routing (`/route`) and elevation profiles (`/height`)
- **Base URL:** `${VALHALLA_URL}` — configurable via `VALHALLA_URL` env var, defaults to `https://valhalla1.openstreetmap.de`
- **Rate limits:** Public instance has undocumented rate limits; heavy use may be throttled
- **Local option:** Run Valhalla in Docker and set `VALHALLA_URL=http://localhost:8002` (or your mapped port)

## Eden Treaty Type Flow

The entire stack is type-safe via the Eden treaty pattern:

1. **Shared types** defined in `src/shared/index.ts` — `Stop`, `GeocodeResult`, `RouteResponse`, `RouteRequest`
2. **Backend** (`src/be/index.ts`) imports shared types and validates request/response with Elysia `t.Object`/`t.Array` schemas
3. **App export** — `export type App = typeof app` exposes the Elysia instance type
4. **Frontend** (`src/fe/App.tsx`) creates the treaty client: `edenTreaty<ElysiaApp>('http://localhost:3002')`
5. **Client-side** Eden infers request/response types from the Elysia schema — no manual type annotations needed for API calls

Example in `src/fe/Stops.tsx`:

```typescript
const { data, error } = await treaty.api.geocode.get({ $query: params })
// data is inferred as GeocodeResult[] | undefined
```

**Caveat:** Elysia's `t.Array(t.Array(t.Number()))` infers `number[][]`, not `[number, number][]`. The frontend narrows this with a cast at the call site (`data.geometry as [number, number][]`) — see `docs/gotchas.md`.
