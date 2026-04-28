import { createContext, useContext, createSignal, type Accessor, type Setter } from 'solid-js'
import Map from './Map'
import Stops from './Stops'
import { edenTreaty } from '@elysiajs/eden'
import type { App as ElysiaApp } from '@vrstevnice/be'
import type { Stop, RouteResponse } from '@vrstevnice/shared'

const treaty = edenTreaty<ElysiaApp>('http://localhost:3002')

interface MapCenter {
  lat: number
  lon: number
  zoom: number
}

interface AppContextValue {
  treaty: typeof treaty
  stops: Accessor<Stop[]>
  setStops: Setter<Stop[]>
  addStop: (stop: Stop) => void
  updateStop: (index: number, lat: number, lng: number) => void
  route: Accessor<RouteResponse | null>
  setRoute: Setter<RouteResponse | null>
  loading: Accessor<boolean>
  setLoading: Setter<boolean>
  error: Accessor<string | null>
  setError: Setter<string | null>
  mapCenter: Accessor<MapCenter | null>
  setMapCenter: Setter<MapCenter | null>
}

const AppContext = createContext<AppContextValue>()

export function useApp() {
  return useContext(AppContext)!
}

export default function App() {
  const [stops, setStops] = createSignal<Stop[]>([])
  const [route, setRoute] = createSignal<RouteResponse | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [mapCenter, setMapCenter] = createSignal<MapCenter | null>(null)
  const addStop = (stop: Stop) => {
    setStops(prev => [...prev, stop])
  }

  const updateStop = (index: number, lat: number, lng: number) => {
    setStops(prev => {
      if (index < 0 || index >= prev.length) return prev
      const next = [...prev]
      next[index] = { ...next[index], lat, lng }
      return next
    })
  }

  return (
    <AppContext.Provider value={{ treaty, stops, setStops, addStop, updateStop, route, setRoute, loading, setLoading, error, setError, mapCenter, setMapCenter }}>
      <Stops />
      <Map />
    </AppContext.Provider>
  )
}
