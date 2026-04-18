import type { Stop, RouteResponse, ElevationPoint, SurfaceSegment, RoadClassSegment } from '@vrstevnice/shared'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GHCustomModelRule {
  if: string
  multiply_by: string
}

export interface GHCustomModel {
  priority: GHCustomModelRule[]
  distance_influence: number
}

export interface GHPoint {
  point: [number, number] // [lon, lat]
}

export interface GHRouteRequest {
  points: [number, number][] // [[lon, lat], ...]
  profile: string
  elevation: boolean
  points_encoded: boolean
  'ch.disable': boolean
  details?: string[]
  'custom_model'?: GHCustomModel
}

export interface GHPath {
  distance: number     // meters
  time: number         // milliseconds
  ascend: number       // meters
  descend: number      // meters
  points: {
    type: string
    coordinates: Array<[number, number, number]> // [lon, lat, ele]
  }
  instructions: unknown[]
  details?: Record<string, unknown[]>
}

export interface GHRouteResponse {
  paths: GHPath[]
  info?: { errors?: unknown[] }
}

export interface GHRouteResult {
  distance: number     // meters (raw GH)
  duration: number     // milliseconds (raw GH)
  elevationGain: number // meters
  elevationLoss: number // meters
  geometry: Array<[number, number, number]> // [lon, lat, ele]
  surfaceSegments: SurfaceSegment[]
  roadClassSegments: RoadClassSegment[]
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const GRAPHHOPPER_URL = process.env.GRAPHHOPPER_URL || 'http://localhost:8989'

// ---------------------------------------------------------------------------
// Custom model builder
// ---------------------------------------------------------------------------

/**
 * Map the three frontend coefficients to GraphHopper `priority` rules.
 *
 * - roadAvoidanceCoefficient 0→1: penalize MOTORWAY+TRUNK (0.01→1.0),
 *   PRIMARY (0.05→1.0), SECONDARY (0.2→1.0)
 * - elevationCoefficient 0→1: slope bands >3% (0.5→1.0), >6% (0.3→1.0),
 *   >10% (0.1→1.0)
 * - cyclewayCoefficient 0→1: boost CYCLEWAY priority (1.0→5.0), lower
 *   distance_influence (allow longer detours)
 * - distance_influence = 70 + (1 - roadAvoidanceCoefficient) * 30 - cyclewayCoefficient * 30
 */
export function buildCustomModel(
  elevationCoefficient: number,
  roadAvoidanceCoefficient: number,
  cyclewayCoefficient = 0,
): GHCustomModel {
  // Road avoidance: 0 = max avoidance (low priority), 1 = no avoidance (full priority)
  const roadRules: GHCustomModelRule[] = [
    {
      if: 'road_class == MOTORWAY || road_class == TRUNK',
      multiply_by: String(lerp(0.01, 1.0, roadAvoidanceCoefficient)),
    },
    {
      if: 'road_class == PRIMARY',
      multiply_by: String(lerp(0.05, 1.0, roadAvoidanceCoefficient)),
    },
    {
      if: 'road_class == SECONDARY',
      multiply_by: String(lerp(0.2, 1.0, roadAvoidanceCoefficient)),
    },
  ]

  // Elevation: 0 = max flat preference (low priority for slopes), 1 = hills ok (full priority)
  // GH bike profile uses average_slope and max_slope (encoded numeric values)
  // slope thresholds: 3% = 0.03, 6% = 0.06, 10% = 0.10
  const elevationRules: GHCustomModelRule[] = [
    {
      if: 'max_slope > 0.10',
      multiply_by: String(lerp(0.1, 1.0, elevationCoefficient)),
    },
    {
      if: 'max_slope > 0.06',
      multiply_by: String(lerp(0.3, 1.0, elevationCoefficient)),
    },
    {
      if: 'average_slope > 0.03',
      multiply_by: String(lerp(0.5, 1.0, elevationCoefficient)),
    },
  ]

  // Cycleway forcing: 0 = don't care, 1 = strongly prefer cycleways (accept long detours)
  const cyclewayRules: GHCustomModelRule[] = [
    {
      if: 'road_class == CYCLEWAY',
      multiply_by: String(lerp(1.0, 3.0, cyclewayCoefficient)),
    },
    {
      if: 'cycleway != NO',
      multiply_by: String(lerp(1.0, 1.5, cyclewayCoefficient)),
    },
  ]

  const distance_influence = Math.max(30, 70 + (1 - roadAvoidanceCoefficient) * 30 - cyclewayCoefficient * 30)

  return {
    priority: [...roadRules, ...elevationRules, ...cyclewayRules],
    distance_influence,
  }
}

// ---------------------------------------------------------------------------
// Route fetcher
// ---------------------------------------------------------------------------

/**
 * POST to GraphHopper /route and return a typed GHRouteResult.
 *
 * - `ch.disable: true` (required for custom models)
 * - `points_encoded: false` for raw [lon, lat, ele] coordinates
 * - `elevation: true` for ascend/descend
 * - `profile: 'bike'`
 */
export async function fetchRouteFromGH(
  stops: Stop[],
  customModel: GHCustomModel,
): Promise<GHRouteResult> {
  const url = `${GRAPHHOPPER_URL}/route`

  // GH points input is [[lon, lat], ...] — stops have {lat, lng}
  const points: [number, number][] = stops.map(s => [s.lng, s.lat])

  const body: GHRouteRequest = {
    points,
    profile: 'bike',
    elevation: true,
    points_encoded: false,
    'ch.disable': true,
    details: ['surface', 'road_class'],
    'custom_model': customModel,
  }

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (err) {
    console.error(`GraphHopper fetch failed: ${GRAPHHOPPER_URL} — ${(err as Error).message}`)
    throw new Error(`Could not connect to GraphHopper at ${GRAPHHOPPER_URL}`)
  }

  if (!res.ok) {
    const text = await res.text()
    console.error(`GraphHopper error: ${res.status} ${GRAPHHOPPER_URL} — ${text}`)
    throw new Error(`GraphHopper returned ${res.status}: ${text}`)
  }

  const data: GHRouteResponse = await res.json()

  if (data.info?.errors?.length) {
    throw new Error(`GraphHopper routing errors: ${JSON.stringify(data.info.errors)}`)
  }

  const path = data.paths?.[0]
  if (!path) {
    throw new Error('No route found by GraphHopper')
  }

  const surfaceSegments = parseSurfaceSegments(path.details)
  const roadClassSegments = parseRoadClassSegments(path.details)

  return {
    distance: path.distance,
    duration: path.time,
    elevationGain: path.ascend,
    elevationLoss: path.descend,
    geometry: path.points.coordinates,
    surfaceSegments,
    roadClassSegments,
  }
}

// ---------------------------------------------------------------------------
// Detail segment parsers
// ---------------------------------------------------------------------------

function parseDetailTriples(
  details: Record<string, unknown[]> | undefined,
  key: string,
): Array<[number, number, string]> {
  const raw = details?.[key]
  if (!Array.isArray(raw) || raw.length === 0) return []
  const result: Array<[number, number, string]> = []
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length < 3) continue
    const [from, to, value] = entry
    if (typeof from !== 'number' || typeof to !== 'number' || typeof value !== 'string') continue
    result.push([from, to, value])
  }
  return result
}

/**
 * Parse GraphHopper `details.surface` triples into structured SurfaceSegment[].
 */
export function parseSurfaceSegments(
  details: Record<string, unknown[]> | undefined,
): SurfaceSegment[] {
  return parseDetailTriples(details, 'surface').map(([from, to, surface]) => ({
    from, to, surface,
  }))
}

/**
 * Parse GraphHopper `details.road_class` triples into structured RoadClassSegment[].
 */
export function parseRoadClassSegments(
  details: Record<string, unknown[]> | undefined,
): RoadClassSegment[] {
  return parseDetailTriples(details, 'road_class').map(([from, to, roadClass]) => ({
    from, to, roadClass,
  }))
}

// ---------------------------------------------------------------------------
// Coordinate converter
// ---------------------------------------------------------------------------

/**
 * Swap GH [lon, lat, ele] → Leaflet [lat, lng][] (drops elevation).
 */
export function convertGHGeometryToLeaflet(
  coords: Array<[number, number, number]>,
): [number, number][] {
  return coords.map(([lon, lat]) => [lat, lon])
}

// ---------------------------------------------------------------------------
// Unit converter
// ---------------------------------------------------------------------------

/**
 * Convert a GHRouteResult to the app's RouteResponse contract.
 * - distance: meters → kilometers
 * - duration: milliseconds → seconds
 * - geometry: swapped for Leaflet
 */
export function convertGHToRouteResponse(ghResult: GHRouteResult): RouteResponse {
  return {
    geometry: convertGHGeometryToLeaflet(ghResult.geometry),
    distance: Math.round(ghResult.distance / 100) / 10,   // meters → km, 1 decimal
    duration: Math.round(ghResult.duration / 1000),        // ms → seconds
    elevationGain: Math.round(ghResult.elevationGain),
    elevationLoss: Math.round(ghResult.elevationLoss),
    elevationProfile: computeElevationProfile(ghResult.geometry),
    surfaceSegments: ghResult.surfaceSegments,
    roadClassSegments: ghResult.roadClassSegments,
  }
}

// ---------------------------------------------------------------------------
// Elevation profile
// ---------------------------------------------------------------------------

const EARTH_RADIUS_M = 6_371_000

/**
 * Compute cumulative-distance elevation profile from GH [lon, lat, ele] coordinates.
 *
 * Returns an array of {distance, elevation} points where distance is cumulative
 * haversine distance in meters from the start of the route.
 * Points with NaN/undefined elevation are excluded.
 */
export function computeElevationProfile(
  coords: Array<[number, number, number]>,
): ElevationPoint[] {
  const profile: ElevationPoint[] = []
  let cumulativeDistance = 0

  for (let i = 0; i < coords.length; i++) {
    const [lon, lat, ele] = coords[i]

    // Skip coordinates with missing or invalid elevation
    if (ele == null || !Number.isFinite(ele)) {
      continue
    }

    if (i > 0) {
      const [prevLon, prevLat] = coords[i - 1]
      cumulativeDistance += haversineMeters(prevLat, prevLon, lat, lon)
    }

    profile.push({ distance: cumulativeDistance, elevation: ele })
  }

  return profile
}

/**
 * Haversine distance between two lat/lon points in meters.
 */
function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lerp(a: number, b: number, t: number): number {
  return Math.max(0.01, a + (b - a) * t)
}
