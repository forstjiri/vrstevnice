export interface Stop {
  lat: number
  lng: number
  name: string
}

export interface GeocodeResult {
  lat: number
  lng: number
  name: string
  displayName: string
}

export interface ElevationPoint {
  /** Cumulative distance from route start in meters */
  distance: number
  /** Elevation in meters above sea level */
  elevation: number
}

export interface SurfaceSegment {
  /** Index of the first coordinate point in the route geometry */
  from: number
  /** Index of the last coordinate point in the route geometry */
  to: number
  /** Surface type string from GraphHopper (e.g. "asphalt", "gravel", "unpaved") */
  surface: string
}

export interface RoadClassSegment {
  /** Index of the first coordinate point in the route geometry */
  from: number
  /** Index of the last coordinate point in the route geometry */
  to: number
  /** Road class string from GraphHopper (e.g. "RESIDENTIAL", "SECONDARY", "TERTIARY") */
  roadClass: string
}

export interface ShadowPoint {
	/** Cumulative distance from route start (meters) */
	distance: number
	/** True = point is in shadow (blocked by vegetation/building) */
	shadow: boolean
	/** Direct sunlight exposure: 0 = full shadow, 1 = full direct sun */
	sunExposure: number
}

export interface POILocation {
  /** Latitude */
  lat: number
  /** Longitude */
  lng: number
  /** POI display name from Overpass/Photon */
  name: string
  /** Amenity category: pub, bar, restaurant, cafe, or biergarten */
  type: string
}

export interface RouteResponse {
  geometry: [number, number][]
  distance: number
  duration: number
  elevationGain: number
  elevationLoss: number
  /** Elevation profile sampled from GH coordinates [{distance, elevation}] */
  elevationProfile: ElevationPoint[]
  /** Surface type segments parsed from GraphHopper details */
  surfaceSegments: SurfaceSegment[]
  /** Road class segments parsed from GraphHopper details */
  roadClassSegments: RoadClassSegment[]
  /** Road environment segments parsed from GraphHopper (road, bridge, tunnel, ford) */
  roadEnvSegments: RoadClassSegment[]
	/** Shadow profile computed from DSM ray-tracing (optional, requires elevation service) */
	shadowProfile?: ShadowPoint[]
  /** POI locations (pubs, bars, restaurants) along the route when lemonadeCoefficient > 0 */
  poiLocations: POILocation[]
  /** All discovered POIs (including non-selected) for map display */
  allPOILocations: POILocation[]
}

export interface RouteRequest {
  stops: Stop[]
  elevationCoefficient: number
  roadAvoidanceCoefficient: number
  cyclewayCoefficient: number
  /** Lemonade coefficient: 0 = off (normal routing), 1 = max pub density along route */
  lemonadeCoefficient: number
  /** Optional datetime used for terrain-based shadow profile computation */
  shadowDateTime?: string
}

// --- Geo utilities ---

export const EARTH_RADIUS_M = 6_371_000

/**
 * Haversine distance between two lat/lon points in meters.
 */
export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

/** Pre-compute cumulative haversine distances for each geometry point. */
export function computeGeometryDistances(geometry: [number, number][]): number[] {
  const distances = [0]
  for (let i = 1; i < geometry.length; i++) {
    distances.push(distances[i - 1] + haversineMeters(geometry[i - 1][0], geometry[i - 1][1], geometry[i][0], geometry[i][1]))
  }
  return distances
}

/**
 * Interpolate [lat, lng] position at a given cumulative distance along geometry.
 * Requires pre-computed distances from computeGeometryDistances().
 */
export function findPositionAtDistance(
  geometry: [number, number][],
  geometryDistances: number[],
  targetDistance: number,
): [number, number] | null {
  if (geometry.length === 0) return null
  if (geometry.length === 1) return geometry[0]
  if (targetDistance >= geometryDistances[geometryDistances.length - 1]) {
    return geometry[geometry.length - 1]
  }
  let lo = 0
  let hi = geometryDistances.length - 1
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1
    if (geometryDistances[mid] <= targetDistance) lo = mid
    else hi = mid
  }
  const segStart = geometryDistances[lo]
  const segEnd = geometryDistances[hi]
  const t = segEnd > segStart ? (targetDistance - segStart) / (segEnd - segStart) : 0
  return [
    geometry[lo][0] + (geometry[hi][0] - geometry[lo][0]) * t,
    geometry[lo][1] + (geometry[hi][1] - geometry[lo][1]) * t,
  ]
}

/**
 * Compute bearing in degrees (0=north, 90=east) between two [lat, lng] points.
 */
export function computeBearing(from: [number, number], to: [number, number]): number {
  const toRad = Math.PI / 180
  const toDeg = 180 / Math.PI
  const lat1 = from[0] * toRad
  const lat2 = to[0] * toRad
  const dLng = (to[1] - from[1]) * toRad
  const y = Math.sin(dLng) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng)
  return ((Math.atan2(y, x) * toDeg) + 360) % 360
}

export function parseLocalDateTime(value: string): Date | null {
  if (!value) return null
  const [datePart, timePart] = value.split('T')
  if (!datePart || !timePart) return null
  const [year, month, day] = datePart.split('-').map(Number)
  const [hour, minute] = timePart.split(':').map(Number)
  if ([year, month, day, hour, minute].some((n) => Number.isNaN(n))) return null
  return new Date(year, month - 1, day, hour, minute, 0, 0)
}

export function formatLocalDateTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function formatLocalDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
