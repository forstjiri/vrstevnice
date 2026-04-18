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
}

export interface RouteRequest {
  stops: Stop[]
  elevationCoefficient: number
  roadAvoidanceCoefficient: number
  cyclewayCoefficient: number
}
