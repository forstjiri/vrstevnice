# Architecture

## Monorepo Layout

pnpm workspaces with three packages under `src/*`:

```
vrstevnice/
├── package.json              # root scripts: dev, typecheck
├── pnpm-workspace.yaml       # packages: ["src/*"]
├── tsconfig.json             # project references to src/*/tsconfig.json
├── src/
│   ├── shared/               # @vrstevnice/shared
│   │   ├── index.ts          # TypeScript interfaces
│   │   └── package.json
│   ├── be/                   # @vrstevnice/be
│   │   ├── index.ts          # Elysia HTTP server
│   │   ├── db.ts             # Drizzle ORM + Bun SQLite
│   │   └── package.json
│   └── fe/                   # @vrstevnice/fe
│       ├── App.tsx           # Context provider + Eden treaty client
│       ├── Stops.tsx         # Stop management panel
│       ├── Map.tsx           # Leaflet map component
│       ├── index.tsx         # Vite entry point
│       ├── app.css           # Styles
│       └── package.json
```

## Shared Types (`src/shared/index.ts`)

Four interfaces shared between frontend and backend via `@vrstevnice/shared` workspace package:

```typescript
interface Stop {
  lat: number
  lng: number
  name: string
}

interface GeocodeResult {
  lat: number
  lng: number
  name: string
  displayName: string
}

interface RouteResponse {
  geometry: [number, number][]
  distance: number
  duration: number
  elevationGain: number
  elevationLoss: number
}

interface RouteRequest {
  stops: Stop[]
  elevationCoefficient: number
  roadAvoidanceCoefficient: number
}
```

## Backend (`src/be/index.ts`)

Elysia app listening on **port 3002** with prefix `/api`. CORS allows `localhost:5173` (dev) and `localhost:4173` (preview).

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/geocode?q=...&viewbox=...&bounded=...` | Proxy to Nominatim, returns `GeocodeResult[]` |
| POST | `/api/route` | Calculate bicycle route via Valhalla, returns `RouteResponse` |
| GET | `/api/history` | List all saved routes from DB |

### Valhalla Integration

- **Routing**: POST to `{VALHALLA_URL}/route` with `costing: 'bicycle'`, `use_hills` and `use_roads` options derived from coefficients
- **Elevation**: POST to `{VALHALLA_URL}/height` with resample distance 50m, computes gain/loss from height array
- **Polyline**: Custom `decodePolyline6()` function decodes Valhalla's polyline6 encoding into `[lat, lng][]`

### `roadAvoidanceCoefficient` Mapping

The coefficient (0–1) maps to Valhalla's `use_roads` for all road classes from motorway to tertiary_link: 0 = avoid all, 1 = allow all.

## Database (`src/be/db.ts`)

Drizzle ORM over Bun SQLite. WAL mode enabled via `PRAGMA journal_mode=WAL`.

### `routes` table

| Column | Drizzle type | SQLite type | Notes |
|--------|-------------|-------------|-------|
| id | `integer().primaryKey({ autoIncrement: true })` | INTEGER | Auto-increment |
| name | `text().notNull()` | TEXT | Route label |
| stops | `text().notNull()` | TEXT | JSON-encoded `Stop[]` |
| geometry | `text().notNull()` | TEXT | JSON-encoded `[number, number][]` |
| distance | `real()` | REAL | km |
| duration | `real()` | REAL | seconds |
| elevationGain | `real('elevation_gain')` | REAL | meters |
| elevationLoss | `real('elevation_loss')` | REAL | meters |
| createdAt | `text().notNull().default(sql\`(datetime('now'))\`)` | TEXT | ISO timestamp |

Database file: `src/be/data.db` (gitignored).

## Frontend (`src/fe/App.tsx`)

SolidJS app with a single context provider (`AppContext`) exposing:

| Signal | Type | Purpose |
|--------|------|---------|
| `stops` | `Stop[]` | Ordered list of route waypoints |
| `route` | `RouteResponse \| null` | Current computed route |
| `loading` | `boolean` | Route calculation in progress |
| `mapBounds` | `LatLngBounds \| null` | Current visible map extent (used for geocode viewbox) |
| `treaty` | `EdenTreaty<App>` | Type-safe API client |

## Data Flow

```
User types in Search → Nominatim (via BE /api/geocode)
  → GeocodeResult[] displayed in Kobalte Search dropdown
  → User selects result → Stop added to signal array

User adjusts Sliders → elevationCoefficient, roadAvoidanceCoefficient

User clicks "Vytvořit trasu"
  → POST /api/route with RouteRequest
  → BE proxies to Valhalla /route (bicycle costing)
  → BE fetches elevation via Valhalla /height
  → BE saves route to SQLite, returns RouteResponse
  → FE renders polyline on Leaflet map + route info overlay

Map interaction:
  → moveend event updates mapBounds signal
  → mapBounds used in subsequent geocode calls (viewbox + bounded search)
  → geocode falls back: bounded → expanded 20km → expanded 500km → unbounded
```

## Key Pattern: Eden Treaty

End-to-end type safety between backend and frontend with zero `any` casts:

1. Backend (`src/be/index.ts`) exports the Elysia app and its type:
   ```typescript
   export type App = typeof app
   ```

2. Frontend (`src/fe/App.tsx`) imports the type and creates a typed treaty client:
   ```typescript
   import type { App as ElysiaApp } from '@vrstevnice/be'
   const treaty = edenTreaty<ElysiaApp>('http://localhost:3002')
   ```

3. All API calls are fully typed — request params, body, and response:
   ```typescript
   // Autocompleted query params, typed response
   const { data, error } = await treaty.api.geocode.get({ $query: params })
   // data is GeocodeResult[], error is typed
   ```

The `@vrstevnice/be` package is listed as a devDependency in the frontend to provide the `App` type at compile time without bundling the server code.

## Key Pattern: Kobalte Components

Unstyled, accessible headless UI primitives from `@kobalte/core`:

| Component | Usage |
|-----------|-------|
| **Search** | Async autocomplete for place search. `onInputChange` fires Nominatim lookup (debounced 300ms), `options` bound to results signal, `onChange` fires on selection. `triggerMode="focus"` opens dropdown on input focus. |
| **Slider** | Two sliders: "Kopcovitost" (elevationCoefficient, 0–1, step 0.05) and "Vyhnutí silnicím" (roadAvoidanceCoefficient, 0–1, step 0.05). |
| **Button** | Action buttons — route calculation, stop reorder arrows, stop removal. |
| **Tooltip** | Hover tooltips on reorder/remove buttons (400ms open delay). |
| **Separator** | Visual separator before the route calculation button. |
| **Progress** | Indeterminate progress bar shown during route calculation. |

## Key Pattern: Leaflet Map

`src/fe/Map.tsx` — imperative Leaflet integration wrapped in SolidJS lifecycle:

- **Tile layer**: OpenStreetMap (`https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png`), max zoom 19
- **Initial view**: Czech Republic center `[49.82, 15.47]`, zoom 7; overrides to geolocation on mount
- **Stop markers**: `L.circleMarker` with color-coded badges (green = start, blue = intermediate, red = end), bound to popup with stop name
- **Auto-fit**: Map fits bounds to all stop markers (or route polyline when available) with 50px padding
- **Route polyline**: `L.polyline` with blue (#2563eb) stroke, 4px weight, rendered on route signal change
- **Route info overlay**: Distance (km), elevation gain/loss (m), duration (min) displayed in a floating div
- **Bounds tracking**: `moveend` event pushes current bounds to `mapBounds` signal for geocode viewbox
