import { createContext, useContext, createSignal, type Accessor, type Setter } from 'solid-js'
import Map from './Map'
import Stops from './Stops'
import { edenTreaty } from '@elysiajs/eden'
import type { App as ElysiaApp } from '@vrstevnice/be'
import type { Stop, RouteResponse } from '@vrstevnice/shared'

const API_BASE = import.meta.env.DEV
  ? 'http://localhost:3002'
  : (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3002')
const treaty = edenTreaty<ElysiaApp>(API_BASE)

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
  hillshadeEnabled: Accessor<boolean>
  setHillshadeEnabled: Setter<boolean>
  shadowRouteEnabled: Accessor<boolean>
  setShadowRouteEnabled: Setter<boolean>
  shadowDateTime: Accessor<string>
  setShadowDateTime: Setter<string>
  regenerateRoute: Accessor<() => Promise<void>>
  setRegenerateRoute: Setter<() => Promise<void>>
}

const AppContext = createContext<AppContextValue>()
const APP_CONTEXT_KEY = '__vrstevnice_app_context__'

function setLatestAppContext(value: AppContextValue) {
  ;(globalThis as unknown as Record<string, AppContextValue | undefined>)[APP_CONTEXT_KEY] = value
}

function getLatestAppContext() {
  return (globalThis as unknown as Record<string, AppContextValue | undefined>)[APP_CONTEXT_KEY]
}

export function useApp() {
  return useContext(AppContext) ?? getLatestAppContext()!
}

export default function App() {
  const [stops, setStops] = createSignal<Stop[]>([])
  const [route, setRoute] = createSignal<RouteResponse | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [mapCenter, setMapCenter] = createSignal<MapCenter | null>(null)
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const [hillshadeEnabled, setHillshadeEnabled] = createSignal(false)
  const [shadowRouteEnabled, setShadowRouteEnabled] = createSignal(false)
  const [shadowDateTime, setShadowDateTime] = createSignal(
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`,
  )
  const [regenerateRoute, setRegenerateRoute] = createSignal<() => Promise<void>>(async () => {})
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

  const contextValue: AppContextValue = {
    treaty,
    stops,
    setStops,
    addStop,
    updateStop,
    route,
    setRoute,
    loading,
    setLoading,
    error,
    setError,
    mapCenter,
    setMapCenter,
    hillshadeEnabled,
    setHillshadeEnabled,
    shadowRouteEnabled,
    setShadowRouteEnabled,
    shadowDateTime,
    setShadowDateTime,
    regenerateRoute,
    setRegenerateRoute,
  }

  setLatestAppContext(contextValue)

  return (
    <AppContext.Provider value={contextValue}>
      <Stops />
      <Map />
    </AppContext.Provider>
  )
}
