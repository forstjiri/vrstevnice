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

export interface RouteResponse {
  geometry: [number, number][]
  distance: number
  duration: number
  elevationGain: number
  elevationLoss: number
}

export interface RouteRequest {
  stops: Stop[]
  elevationCoefficient: number
  roadAvoidanceCoefficient: number
}
