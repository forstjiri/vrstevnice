# Vrstevnice

Cycling route planner with elevation awareness. Plans routes between stops using Valhalla routing, with configurable preference for hilly terrain and road avoidance.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | SolidJS 1.9, Kobalte 0.13 (UI primitives), Leaflet (map), Vite 8 (build) |
| Backend | Elysia 1.4 (HTTP), Bun (runtime) |
| Database | Drizzle ORM + Bun SQLite (WAL mode) |
| Routing | Valhalla (bicycle costing, polyline6 decode) |
| Geocoding | Nominatim (OpenStreetMap) |
| Type safety | Eden treaty (end-to-end typed API client) |
| Monorepo | pnpm workspaces |

## How to Run

```bash
pnpm install
pnpm dev          # starts BE on :3002 and FE on :5173 in parallel
pnpm typecheck    # tsc --build across all packages
```

Optional env vars (backend):
- `VALHALLA_URL` — Valhalla instance URL (default: `https://valhalla1.openstreetmap.de`)

## Project Structure

```
src/
  shared/          @vrstevnice/shared — Stop, GeocodeResult, RouteResponse, RouteRequest
  be/              @vrstevnice/be    — Elysia server (index.ts), Drizzle DB schema (db.ts)
  fe/              @vrstevnice/fe    — SolidJS app (App.tsx), stops panel (Stops.tsx), map (Map.tsx)
docs/              Architecture and API documentation
```

## Key Architectural Decisions

- [docs/architecture.md](docs/architecture.md) — monorepo layout, data flow, key patterns (Eden treaty, Kobalte, Leaflet)
- [docs/api.md](docs/api.md) — all 3 API endpoints with request/response schemas, external API integrations
- [docs/gotchas.md](docs/gotchas.md) — hard-won lessons from M001/M002 (distance units, Eden typing, port 3002, Valhalla limits)

See [.gsd/DECISIONS.md](.gsd/DECISIONS.md) for the full decision register.

## Important Files

| File | Purpose |
|------|---------|
| `src/shared/index.ts` | Shared TypeScript interfaces (Stop, GeocodeResult, RouteResponse, RouteRequest) |
| `src/be/index.ts` | Elysia server — 3 endpoints (/geocode, /route, /history), Valhalla integration, decodePolyline6 |
| `src/be/db.ts` | Drizzle schema + Bun SQLite setup, `routes` table |
| `src/fe/App.tsx` | SolidJS context provider, Eden treaty client, app-level signals |
| `src/fe/Stops.tsx` | Stop management panel — Kobalte Search/Slider/Button/Tooltip |
| `src/fe/Map.tsx` | Leaflet map — tile layer, stop markers, polyline rendering, route info overlay |
| `pnpm-workspace.yaml` | Monorepo workspace config (packages: `src/*`) |
| `package.json` | Root scripts (dev, typecheck) |
