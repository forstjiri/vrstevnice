import type {
	ElevationPoint,
	POILocation,
	RoadClassSegment,
	RouteResponse,
	Stop,
	SurfaceSegment
} from '@vrstevnice/shared'
import {computeGeometryDistances, haversineMeters} from '@vrstevnice/shared'

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
  roadEnvSegments: RoadClassSegment[] // reuse same shape: { from, to, roadClass: string }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const GRAPHHOPPER_URL = process.env.GRAPHHOPPER_URL || 'http://localhost:8989'
const OVERPASS_URL = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter'

// ---------------------------------------------------------------------------
// Custom model builder
// ---------------------------------------------------------------------------

/**
 * Map the three frontend coefficients to GraphHopper `priority` rules.
 *
 * - roadAvoidanceCoefficient 0→1: penalize MOTORWAY+TRUNK (0.01→1.0),
 *   PRIMARY (0.05→1.0), SECONDARY (0.2→1.0)
 * - elevationCoefficient 0→1: 0 = hills ok (no penalty), 1 = avoid hills (heavy penalty).
 *   Slope bands: average_slope > 3% (0.5→1.0), max_slope > 6% (0.3→1.0),
 *   max_slope > 10% (0.1→1.0). GH encoded values are in percentage units (3 = 3%).
 * - cyclewayCoefficient 0→1: boost CYCLEWAY priority (1.0→5.0), lower
 *   distance_influence (allow longer detours)
 * - distance_influence = 70 + (1 - roadAvoidanceCoefficient) * 30 - cyclewayCoefficient * 30 - elevationCoefficient * 30
 */
export function buildCustomModel(
  elevationCoefficient: number,
  roadAvoidanceCoefficient: number,
  cyclewayCoefficient = 0,
): GHCustomModel {
  // Road avoidance: 0 = max avoidance (low priority), 1 = no avoidance (full priority)
  // Floors kept high enough that roads stay viable when stacked with elevation penalties
  const roadRules: GHCustomModelRule[] = [
    {
      if: 'road_class == MOTORWAY || road_class == TRUNK',
      multiply_by: String(lerp(0.1, 1.0, roadAvoidanceCoefficient)),
    },
    {
      if: 'road_class == PRIMARY',
      multiply_by: String(lerp(0.2, 1.0, roadAvoidanceCoefficient)),
    },
    {
      if: 'road_class == SECONDARY',
      multiply_by: String(lerp(0.2, 1.0, roadAvoidanceCoefficient)),
    },
  ]

  // Elevation: 0 = hills ok (full priority), 1 = max flat preference (low priority for slopes)
  // GH encoded values for average_slope/max_slope are in percentage (3 = 3%, 7 = 7%)
  // Thresholds in percentage units: steep >10%, moderate >6%, gentle >3%
  //
  // IMPORTANT: keep minimum multipliers high enough that elevation penalties don't
  // stack with road_class penalties and kill edges entirely. If PRIMARY road with
  // average_slope > 6 gets 0.05 * 0.2 = 0.01, GH can't find any valid flat detour
  // (they tend to be on higher-class roads) and falls back to the direct hilly route.
  const elevationRules: GHCustomModelRule[] = [
    {
      if: 'max_slope > 10',
      multiply_by: String(lerp(0.3, 1.0, 1 - elevationCoefficient)),
    },
    {
      if: 'max_slope > 6',
      multiply_by: String(lerp(0.5, 1.0, 1 - elevationCoefficient)),
    },
    {
      if: 'average_slope > 6',
      multiply_by: String(lerp(0.4, 1.0, 1 - elevationCoefficient)),
    },
    {
      if: 'average_slope > 3',
      multiply_by: String(lerp(0.6, 1.0, 1 - elevationCoefficient)),
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

  const distance_influence = Math.max(30, 70 + (1 - roadAvoidanceCoefficient) * 30 - cyclewayCoefficient * 30 - elevationCoefficient * 30)

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
    details: ['surface', 'road_class', 'road_environment'],
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
  const roadEnvSegments = parseDetailTriples(path.details, 'road_environment').map(
    ([from, to, env]) => ({ from, to, roadClass: env }),
  )

  return {
    distance: path.distance,
    duration: path.time,
    elevationGain: path.ascend,
    elevationLoss: path.descend,
    geometry: path.points.coordinates,
    surfaceSegments,
    roadClassSegments,
    roadEnvSegments,
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
    roadEnvSegments: ghResult.roadEnvSegments ?? [],
    poiLocations: [],
    allPOILocations: [],
  }
}

// ---------------------------------------------------------------------------
// Elevation profile
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Overpass API — Lemonade route pipeline
// ---------------------------------------------------------------------------

const DEFAULT_DEDUP_DISTANCE = 100 // meters

/** Result of the POI pipeline: selected waypoints + all discovered POIs for map display. */
export interface POIResult {
  /** POIs selected as waypoints (after spatial thinning) */
  selected: POILocation[]
  /** All discovered POIs (before thinning, deduplicated) — for map display */
  all: POILocation[]
}

/** Compute total route length in meters from Leaflet [lat, lng] geometry. */
function computeRouteLength(geometry: [number, number][]): number {
  let total = 0
  for (let i = 1; i < geometry.length; i++) {
    total += haversineMeters(geometry[i - 1][0], geometry[i - 1][1], geometry[i][0], geometry[i][1])
  }
  return total
}

/**
 * Query Overpass API for nearby pubs, bars, restaurants, cafes, biergarten.
 *
 * Returns [] on any error (network, parsing, non-JSON response).
 * Overpass uses lat,lon order (not lon,lat like GeoJSON).
 */
export async function queryOverpassAround(
  lat: number,
  lon: number,
  radius: number,
): Promise<POILocation[]> {
  const query = `[out:json];node["amenity"~"pub|bar|restaurant|cafe|biergarten"](around:${radius},${lat},${lon});out body;`

  let res: Response
  try {
    res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Vrstevnice/1.0 (https://github.com/jiriforst/vrstevnice)',
      },
      body: `data=${encodeURIComponent(query)}`,
    })
  } catch (err) {
    console.error(`Overpass fetch failed: ${OVERPASS_URL} — ${(err as Error).message}`)
    return []
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '(empty)')
    console.error(`Overpass error: ${res.status} — ${text.slice(0, 500)}`)
    return []
  }

  const contentType = res.headers.get('content-type') || ''
  if (!contentType.includes('application/json')) {
    console.error(`Overpass returned non-JSON content-type: ${contentType}`)
    return []
  }

  let data: any
  try {
    data = await res.json()
  } catch {
    console.error('Overpass returned invalid JSON')
    return []
  }

  const elements: any[] = data?.elements ?? []
  if (elements.length === 0) {
    console.warn(`Overpass: no POIs found at (${lat},${lon}) radius=${radius}m`)
  }

  return elements
    .filter((el) => el.lat != null && el.lon != null && el.tags?.name)
    .map((el) => ({
      lat: el.lat,
      lng: el.lon,
      name: el.tags.name,
      type: el.tags.amenity || 'unknown',
    }))
}

/**
 * Sample route geometry at regular distance intervals.
 *
 * Input is Leaflet [lat, lng] format. Returns sample points in the same format.
 * @param maxSamples Cap on number of sample points (default 8, to limit Overpass API load).
 */
export function sampleRouteGeometry(
  geometry: [number, number][],
  interval: number,
  maxSamples = 8,
): [number, number][] {
  if (geometry.length < 2) return []

  const points: [number, number][] = [geometry[0]]
  let distSinceLast = 0

  for (let i = 1; i < geometry.length; i++) {
    const [prevLat, prevLng] = geometry[i - 1]
    const [curLat, curLng] = geometry[i]
    const segDist = haversineMeters(prevLat, prevLng, curLat, curLng)

    distSinceLast += segDist

    while (distSinceLast >= interval && points.length < maxSamples) {
      // Interpolate the exact point at the interval boundary
      const overshoot = distSinceLast - interval
      const fraction = 1 - overshoot / segDist
      const interpLat = prevLat + (curLat - prevLat) * fraction
      const interpLng = prevLng + (curLng - prevLng) * fraction
      points.push([interpLat, interpLng])
      distSinceLast = overshoot
    }
  }

  return points
}

/**
 * Deduplicate POIs by proximity — keeps the first occurrence within minDistance.
 *
 * Uses haversine distance. Default minDistance: 100m.
 */
export function deduplicatePOIs(
  pois: POILocation[],
  minDistance = DEFAULT_DEDUP_DISTANCE,
): POILocation[] {
  const accepted: POILocation[] = []

  for (const poi of pois) {
    const isDuplicate = accepted.some(
      (a) => haversineMeters(a.lat, a.lng, poi.lat, poi.lng) < minDistance,
    )
    if (!isDuplicate) {
      accepted.push(poi)
    }
  }

  return accepted
}

/**
 * Insert POI waypoints between original stops in route-traversal order.
 *
 * For each POI, finds its closest point on the route geometry, then inserts
 * the POI after the last original stop that appears before it in the route.
 * Original stops remain at their exact positions in the array.
 */
export function insertPOIWaypoints(
  originalStops: Stop[],
  pois: POILocation[],
  geometry: [number, number][],
): Stop[] {
  if (originalStops.length < 2 || pois.length === 0 || geometry.length < 2) {
    return [...originalStops]
  }

  // Find the geometry index closest to each original stop
  const stopGeometryIndices = originalStops.map((stop) =>
    closestGeometryIndex(stop.lat, stop.lng, geometry),
  )

  // For each POI, find its closest geometry index
  const poiGeometryIndices = pois.map((poi) =>
    closestGeometryIndex(poi.lat, poi.lng, geometry),
  )

  // Build result: start with original stops, insert POIs in route order
  const result: Stop[] = [...originalStops]

  // For each POI, determine after which original stop it should be inserted
  // Route order: POIs sorted by their geometry index, then placed after the
  // last original stop whose geometry index is ≤ the POI's geometry index
  const poiInsertions: { poi: POILocation; afterStopIdx: number; geoIdx: number }[] = []

  for (let p = 0; p < pois.length; p++) {
    const poiGeoIdx = poiGeometryIndices[p]
    let afterStopIdx = 0
    for (let s = stopGeometryIndices.length - 1; s >= 0; s--) {
      if (stopGeometryIndices[s] <= poiGeoIdx) {
        afterStopIdx = s
        break
      }
    }
    poiInsertions.push({ poi: pois[p], afterStopIdx, geoIdx: poiGeoIdx })
  }

  // Sort by geometry index to maintain route order
  poiInsertions.sort((a, b) => a.geoIdx - b.geoIdx)

  // Insert POIs after the corresponding original stop
  // We iterate in reverse order of insertion position to avoid index shifting
  // Group POIs by their target stop index, then insert from back to front
  const byStop = new Map<number, POILocation[]>()
  for (const ins of poiInsertions) {
    const list = byStop.get(ins.afterStopIdx) || []
    list.push(ins.poi)
    byStop.set(ins.afterStopIdx, list)
  }

  // Insert from back to front so indices don't shift
  const stopIndices = [...byStop.keys()].sort((a, b) => b - a)
  for (const stopIdx of stopIndices) {
    const poisToInsert = byStop.get(stopIdx)!
    // Insert POIs in route order (already sorted by geoIdx within each group)
    for (let i = poisToInsert.length - 1; i >= 0; i--) {
      const poi = poisToInsert[i]
      result.splice(stopIdx + 1, 0, { lat: poi.lat, lng: poi.lng, name: poi.name })
    }
  }

  return result
}

/**
 * Main orchestrator: fetch POIs along a route based on lemonade coefficient.
 *
 * Route-length-aware: the slider behaves consistently on 5km and 100km routes.
 * - coefficient ≤ 0 → returns {selected:[], all:[]} (completely off)
 * - coefficient < 0.07 → dead zone: find and return POIs for map display,
 *   but insert NO waypoints (no rerouting, zero detour)
 * - coefficient ≥ 0.07 → two controls:
 *   1) Max waypoint cap (controls detour intensity):
 *      12km route: 0.1→1, 0.6→3, 1.0→8
 *      Scales with route length (capped at 3× for long routes)
 *   2) Spatial thinning (ensures even spacing along route)
 * - Returns both selected (capped + thinned) and all (deduplicated) POIs
 */
export async function fetchPOIsAlongRoute(
  geometry: [number, number][],
  coefficient: number,
): Promise<POIResult> {
  if (coefficient <= 0) return { selected: [], all: [] }

  const routeLengthM = computeRouteLength(geometry)
  const routeLengthKm = routeLengthM / 1000

  // Dynamic sample count: one sample per ~5km, min 8, max 20
  const desiredSamples = Math.max(8, Math.ceil(routeLengthKm / 5))
  const maxSamples = Math.min(20, desiredSamples)

  // Spread samples evenly across the route
  const interval = routeLengthM / (maxSamples - 1)

  // Search radius: proportional to sample interval, capped at 1.2km
  const radius = Math.min(1_200, interval * 0.5)

  console.info(
		{
			coefficient,
			routeLengthKm: Math.round(routeLengthKm * 10) / 10,
			intervalM: Math.round(interval),
			radiusM: Math.round(radius),
			maxSamples
		},
    'POI pipeline: sampling route',
  )

  const samplePoints = sampleRouteGeometry(geometry, interval, maxSamples)
  if (samplePoints.length === 0) return { selected: [], all: [] }

  console.info({ sampleCount: samplePoints.length }, 'POI pipeline: querying Overpass')

  // Query Overpass at each sample point
  const allPOIs: POILocation[] = []
  for (const [lat, lng] of samplePoints) {
    const pois = await queryOverpassAround(lat, lng, radius)
    allPOIs.push(...pois)
  }

  console.info({ rawPOIs: allPOIs.length }, 'POI pipeline: raw results before dedup')

  // Remove exact duplicates (overlapping query results)
  const deduped = deduplicatePOIs(allPOIs)

  // Sort by route position so thinning preserves route order
  const sorted = sortPOIsByRoutePosition(deduped, geometry)

  // --- Dead zone: below threshold, no waypoints (just show POIs on map) ---
  const WAYPOINT_THRESHOLD = 0.07
  if (coefficient < WAYPOINT_THRESHOLD) {
    console.info(
      { coefficient, threshold: WAYPOINT_THRESHOLD, deduped: deduped.length },
      'POI pipeline: below waypoint threshold, showing POIs without rerouting',
    )
    return { selected: [], all: deduped }
  }

  // --- Normalize coefficient to [0, 1] above threshold ---
  const norm = (coefficient - WAYPOINT_THRESHOLD) / (1 - WAYPOINT_THRESHOLD)

  // --- Max waypoints: primary control on detour intensity ---
  // On 12km route: coeff 0.1→1, 0.6→3, 1.0→8
  // Quadratic curve ensures low coefficients produce very few waypoints
  const baseMax = Math.max(1, Math.ceil(norm * norm * 8))
  // Scales with route length (capped at 3× for long routes), rounded down
  // so a 12.7km route doesn't get an extra waypoint vs exactly 12km
  const routeFactor = Math.floor(Math.min(routeLengthKm / 12, 3) * 10) / 10
  const maxWaypoints = Math.max(1, Math.ceil(baseMax * routeFactor))

  // --- Start delay: don't stop immediately after start ---
  // The more stops you want, the sooner the first one can be (but never immediately).
  // Heuristic: startDelayFraction = 1 / (1 + maxWaypoints)
  // 1 stop -> 1/2 (50%) delay
  // 2 stops -> 1/3 (33%) delay
  // 3 stops -> 1/4 (25%) delay
  // 9 stops -> 1/10 (10%) delay
  const startDelayFraction = 1 / (1 + maxWaypoints)
  const minStartDistance = routeLengthM * startDelayFraction

  // Pre-compute cumulative distances along geometry for all subsequent lookups
  const geomDists = computeGeometryDistances(geometry)

  const delayedPOIs = sorted.filter(poi => {
    const geoIdx = closestGeometryIndex(poi.lat, poi.lng, geometry)
    return geomDists[geoIdx] >= minStartDistance
  })

  // --- Spatial thinning: spread waypoints evenly across the route ---
  // Exponential decay: at norm=0 fraction≈1.0 (minDist≈route length → 1 POI),
  // at norm=1 fraction≈0.05 (minDist≈5% of route → dense POIs)
  // Raw arithmetic — must NOT use the clamped lerp() here
  const stopFraction = Math.exp(-3 * norm)
  const minStopDistance = Math.max(50, routeLengthM * stopFraction)

  // Apply thinning then cap
  const detourAware = filterPOIsByDetourEfficiency(delayedPOIs, geometry, geomDists)
  const thinned = thinPOIsBySpacing(detourAware, minStopDistance)
  const capped = thinned.slice(0, maxWaypoints)

  console.info(
		{
			deduped: deduped.length,
			detourAware: detourAware.length,
			thinned: thinned.length,
			capped: capped.length,
			maxWaypoints,
			minStopDistM: Math.round(minStopDistance)
		},
    'POI pipeline: final POIs after thinning + cap',
  )

  return { selected: capped, all: deduped }
}

/**
 * Filter POIs by comparing their detour distance (off-route) against
 * the distance to the next potential candidate.
 *
 * @param geomDists Pre-computed cumulative distances for each geometry point
 *   (from computeGeometryDistances). Avoids redundant haversine loops.
 */
function filterPOIsByDetourEfficiency(
  pois: POILocation[],
  geometry: [number, number][],
  geomDists: number[],
): POILocation[] {
  if (pois.length < 2) return pois

  const accepted: POILocation[] = []

  for (let i = 0; i < pois.length; i++) {
    const current = pois[i]
    const next = pois[i + 1]

    // Distance from POI to its closest point on route
    const geoIdx = closestGeometryIndex(current.lat, current.lng, geometry)
    const onRoutePoint = geometry[geoIdx]
    const detourDist = haversineMeters(current.lat, current.lng, onRoutePoint[0], onRoutePoint[1])

    // Total cost of detour (going there and back)
    const detourCost = detourDist * 2

    if (next) {
      const nextGeoIdx = closestGeometryIndex(next.lat, next.lng, geometry)

      // Distance along the route between the two POI projections (pre-computed)
      const distToNextOnRoute = geomDists[nextGeoIdx] - geomDists[geoIdx]

      // If detour is longer than the distance to the next candidate on the path,
      // and that next candidate is significantly "cheaper" (closer to route), skip current.
      const nextDetourDist = haversineMeters(next.lat, next.lng, geometry[nextGeoIdx][0], geometry[nextGeoIdx][1])

      if (detourCost > distToNextOnRoute && nextDetourDist < detourDist * 0.5) {
        // Skip this one because there's a much better one soon
        continue
      }
    }

    accepted.push(current)
  }

  return accepted
}

/**
 * Sort POIs by their position along the route geometry (closest geometry index).
 *
 * Pre-computes indices into a Map keyed by POI identity to avoid calling
 * closestGeometryIndex inside the O(n·log n) comparator.
 */
function sortPOIsByRoutePosition(
  pois: POILocation[],
  geometry: [number, number][],
): POILocation[] {
  const indexMap = new Map<POILocation, number>()
  for (const poi of pois) {
    indexMap.set(poi, closestGeometryIndex(poi.lat, poi.lng, geometry))
  }
  return [...pois].sort((a, b) => indexMap.get(a)! - indexMap.get(b)!)
}

/**
 * Find the geometry index closest to a given lat/lng point.
 */
function closestGeometryIndex(
  lat: number,
  lng: number,
  geometry: [number, number][],
): number {
  let bestIdx = 0
  let bestDist = Infinity
  for (let i = 0; i < geometry.length; i++) {
    const d = haversineMeters(lat, lng, geometry[i][0], geometry[i][1])
    if (d < bestDist) {
      bestDist = d
      bestIdx = i
    }
  }
  return bestIdx
}

/**
 * Greedy spatial thinning: keep POIs that are at least minDistance apart.
 *
 * POIs must already be sorted by route position.
 * Uses haversine (straight-line) distance as a practical approximation of route distance.
 */
function thinPOIsBySpacing(
  pois: POILocation[],
  minDistance: number,
): POILocation[] {
  if (pois.length === 0) return []

  const accepted: POILocation[] = [pois[0]]

  for (let i = 1; i < pois.length; i++) {
    const lastAccepted = accepted[accepted.length - 1]
    const dist = haversineMeters(lastAccepted.lat, lastAccepted.lng, pois[i].lat, pois[i].lng)
    if (dist >= minDistance) {
      accepted.push(pois[i])
    }
  }

  return accepted
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lerp(a: number, b: number, t: number): number {
  return Math.max(0.01, a + (b - a) * t)
}
