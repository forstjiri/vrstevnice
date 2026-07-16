import { createContext, useContext, createSignal, createEffect, type Accessor, type Setter } from 'solid-js'
import { Show } from 'solid-js'
import { Badge } from '@kobalte/core/badge'
import { Button } from '@kobalte/core/button'
import { ToggleButton } from '@kobalte/core/toggle-button'
import Map from './Map'
import Stops from './Stops'
import ElevationChart from './ElevationChart'
import ShadowControls from './ShadowControls'
import { edenTreaty } from '@elysiajs/eden'
import type { App as ElysiaApp } from '@vrstevnice/be'
import type { Stop, RouteResponse } from '@vrstevnice/shared'
import { mapControls } from './mapControlsStore'

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
  showPOI: Accessor<boolean>
  setShowPOI: Setter<boolean>
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
  const [showPOI, setShowPOI] = createSignal(false)
  const [regenerateRoute, setRegenerateRoute] = createSignal<() => Promise<void>>(async () => {})
  const [sheetOpen, setSheetOpen] = createSignal(false)
  const [activeTab, setActiveTab] = createSignal<'planner' | 'terrain' | 'chart'>('planner')

  const hasTerrainItems = () => mapControls.terrainOn || mapControls.hillshadeOn

  // Fallback to planner when route disappears
  createEffect(() => {
    if (!route() && activeTab() === 'chart') {
      setActiveTab('planner')
    }
    if (!hasTerrainItems() && activeTab() === 'terrain') {
      setActiveTab('planner')
    }
  })

  function selectTab(tab: 'planner' | 'terrain' | 'chart') {
    if (activeTab() === tab) {
      setSheetOpen((v) => !v)
    } else {
      setActiveTab(tab)
      setSheetOpen(true)
    }
  }

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
    showPOI,
    setShowPOI,
    regenerateRoute,
    setRegenerateRoute,
  }

  setLatestAppContext(contextValue)

  return (
    <AppContext.Provider value={contextValue}>
      <Map />
      <Show when={sheetOpen()}>
        <div class="bottom-sheet-panel">
          <Button
            class="btn btn-icon-circle sheet-close"
            onClick={() => setSheetOpen(false)}
            aria-label="Zavřít panel"
          >
            ×
          </Button>
          <Show when={activeTab() === 'planner'}>
            <Stops />
          </Show>
          <Show when={activeTab() === 'terrain'}>
            <ShadowControls />
          </Show>
          <Show when={activeTab() === 'chart'}>
            <ElevationChart />
          </Show>
        </div>
      </Show>
      <Show when={!sheetOpen()}>
        <div class="bottom-sheet-tabs">
          <ToggleButton
            class="btn btn-toggle-tab"
            pressed={false}
            onClick={() => selectTab('planner')}
          >
            🗺️ Najdi trasu
            <Show when={stops().length > 0}>
              <Badge class="badge badge-tab" textValue={`${stops().length} zastávky`}>
                {stops().length}
              </Badge>
            </Show>
          </ToggleButton>
          <Show when={hasTerrainItems()}>
            <ToggleButton
              class="btn btn-toggle-tab"
              pressed={false}
              onClick={() => selectTab('terrain')}
            >
              🏔️ Terén
            </ToggleButton>
          </Show>
          <Show when={route()}>
            <ToggleButton
              class="btn btn-toggle-tab"
              pressed={false}
              onClick={() => selectTab('chart')}
            >
              📊 Graf
            </ToggleButton>
          </Show>
        </div>
      </Show>
    </AppContext.Provider>
  )
}
