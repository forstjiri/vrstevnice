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
