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

export interface RouteResponse {
  geometry: [number, number][]
  distance: number
  duration: number
  elevationGain: number
  elevationLoss: number
  /** Elevation profile sampled from GH coordinates [{distance, elevation}] */
  elevationProfile: ElevationPoint[]
}

export interface RouteRequest {
  stops: Stop[]
  elevationCoefficient: number
  roadAvoidanceCoefficient: number
}
