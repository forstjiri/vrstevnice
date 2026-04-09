import { createContext, useContext, createSignal, type Accessor, type Setter } from 'solid-js'
import Map from './Map'
import Stops from './Stops'
import { edenTreaty } from '@elysiajs/eden'
import type { App as ElysiaApp } from '@vrstevnice/be'
import type { Stop, RouteResponse } from '@vrstevnice/shared'

const treaty = edenTreaty<ElysiaApp>('http://localhost:3002')

interface LatLngBounds {
  south: number
  west: number
  north: number
  east: number
}

interface AppContextValue {
  treaty: typeof treaty
  stops: Accessor<Stop[]>
  setStops: Setter<Stop[]>
  route: Accessor<RouteResponse | null>
  setRoute: Setter<RouteResponse | null>
  loading: Accessor<boolean>
  setLoading: Setter<boolean>
  mapBounds: Accessor<LatLngBounds | null>
  setMapBounds: Setter<LatLngBounds | null>
}

const AppContext = createContext<AppContextValue>()

export function useApp() {
  return useContext(AppContext)!
}

export default function App() {
  const [stops, setStops] = createSignal<Stop[]>([])
  const [route, setRoute] = createSignal<RouteResponse | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [mapBounds, setMapBounds] = createSignal<LatLngBounds | null>(null)

  return (
    <AppContext.Provider value={{ treaty, stops, setStops, route, setRoute, loading, setLoading, mapBounds, setMapBounds }}>
      <Stops />
      <Map />
    </AppContext.Provider>
  )
}
