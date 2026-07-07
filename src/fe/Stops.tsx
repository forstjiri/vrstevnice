import { createSignal, For, Show, onMount, type JSX } from 'solid-js'
import * as maplibregl from 'maplibre-gl'
import { Search } from '@kobalte/core/search'
import { Button } from '@kobalte/core/button'
import { Slider } from '@kobalte/core/slider'
import { Separator } from '@kobalte/core/separator'
import { Progress } from '@kobalte/core/progress'
import { Tooltip } from '@kobalte/core/tooltip'
import { useApp } from './App'
import { downloadGPX } from './gpx'
import type { RouteRequest, Stop, RouteResponse } from '@vrstevnice/shared'
import type { GeocodeResult } from '@vrstevnice/shared'
import type { SearchRootItemComponentProps } from '@kobalte/core/search'

const DEFAULT_ROAD_AVOIDANCE = 1;
const DEFAULT_CYCLEWAY = 1;
const DEFAULT_ELEVATION = .7;

interface LabeledSliderProps {
  value: number[]
  onChange: (v: number[]) => void
  label: string
  minValue: number
  maxValue: number
  step: number
  labelExtra?: JSX.Element
}

function LabeledSlider(props: LabeledSliderProps) {
  return (
    <Slider
      value={props.value}
      onChange={props.onChange}
      minValue={props.minValue}
      maxValue={props.maxValue}
      step={props.step}
    >
      <div class={`slider-label${props.labelExtra ? ' slider-label-experimental' : ''}`}>
        <Show when={props.labelExtra} fallback={<Slider.Label>{props.label}</Slider.Label>}>
          {props.labelExtra}
        </Show>
        <Slider.ValueLabel />
      </div>
      <Slider.Track class="slider-track">
        <Slider.Fill class="slider-range" />
        <Slider.Thumb class="slider-thumb">
          <Slider.Input class="slider-input" />
        </Slider.Thumb>
      </Slider.Track>
    </Slider>
  )
}

export default function Stops() {
  const {
    treaty,
    stops,
    setStops,
    route,
    setRoute,
    loading,
    setLoading,
    error,
    setError,
    mapCenter,
    hillshadeEnabled,
    shadowRouteEnabled,
    shadowDateTime,
    showPOI,
    setRegenerateRoute,
  } = useApp()
  const [results, setResults] = createSignal<GeocodeResult[]>([])

  function showSearchPreview(lat: number, lng: number) {
    const map = (window as any).__map as maplibregl.Map | undefined
    if (!map) return
    hideSearchPreview()
    const geojson = {
      type: 'Feature' as const,
      properties: {},
      geometry: {
        type: 'Point' as const,
        coordinates: [lng, lat],
      },
    }
    if (!map.getSource('search-preview')) {
      map.addSource('search-preview', { type: 'geojson', data: geojson })
      map.addLayer({
        id: 'search-preview-circle',
        type: 'circle',
        source: 'search-preview',
        paint: {
          'circle-radius': 14,
          'circle-color': 'rgba(59, 130, 246, 0.2)',
          'circle-stroke-width': 3,
          'circle-stroke-color': 'rgba(59, 130, 246, 0.9)',
          'circle-blur': 0.3,
        },
      })
      map.addLayer({
        id: 'search-preview-dot',
        type: 'circle',
        source: 'search-preview',
        paint: {
          'circle-radius': 5,
          'circle-color': '#3b82f6',
        },
      })
    } else {
      ;(map.getSource('search-preview') as maplibregl.GeoJSONSource).setData(geojson)
    }
    map.flyTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 16), duration: 600 })
  }

  function hideSearchPreview() {
    const map = (window as any).__map as maplibregl.Map | undefined
    if (!map) return
    try {
      if (map.getSource('search-preview')) {
        map.removeLayer('search-preview-circle')
        map.removeLayer('search-preview-dot')
        map.removeSource('search-preview')
      }
    } catch (_) {}
  }
  const [elevCoeff, setElevCoeff] = createSignal<number[]>([DEFAULT_ELEVATION])
  const [roadAvoidCoeff, setRoadAvoidCoeff] = createSignal<number[]>([DEFAULT_ROAD_AVOIDANCE])
  const [cyclewayCoeff, setCyclewayCoeff] = createSignal<number[]>([DEFAULT_CYCLEWAY])


  const handleSearch = async (query: string) => {
    if (query.length < 3) { setResults([]); return }
    setError(null)
    try {
      // Geocode via BE — BE handles GPS detection (DD/DDM/DMS),
      // Photon fallback chain (local :2322 → photon.komoot.io),
      // and location bias from map center.
      const center = mapCenter()
      const queryParams: { q: string; lat?: string; lon?: string; zoom?: string } = { q: query }
      if (center) {
        queryParams.lat = String(center.lat)
        queryParams.lon = String(center.lon)
        queryParams.zoom = String(Math.round(center.zoom))
      }
      const { data, error } = await treaty.api.geocode.get({ $query: queryParams })
      if (error) {
        setError('Chyba při vyhledávání místa')
        setResults([])
        return
      }
      setResults((data ?? []) as GeocodeResult[])
    } catch (err) {
      console.error('Geocode error:', err)
      setError('Chyba při vyhledávání místa')
      setResults([])
    }
  }

  let searchInput: HTMLInputElement | undefined

  const handleSelect = (result: GeocodeResult | null) => {
    hideSearchPreview()
    if (!result) return
    setStops(prev => [...prev, { lat: result.lat, lng: result.lng, name: result.name }])
    setResults([])
    if (searchInput) searchInput.value = ''
  }

  const removeStop = (index: number) => {
    setStops(prev => prev.filter((_, i) => i !== index))
  }

  const moveStop = (index: number, dir: -1 | 1) => {
    setStops(prev => {
      const next = [...prev]
      const target = index + dir
      if (target < 0 || target >= next.length) return prev
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  const calculateRoute = async () => {
    setLoading(true)
    setError(null)
    try {
      const body: RouteRequest = {
        stops: stops(),
        elevationCoefficient: elevCoeff()[0] ?? DEFAULT_ELEVATION,
        roadAvoidanceCoefficient: 1 - (roadAvoidCoeff()[0] ?? DEFAULT_ROAD_AVOIDANCE),
        cyclewayCoefficient: cyclewayCoeff()[0] ?? DEFAULT_CYCLEWAY,
        showPOI: showPOI(),
        shadowDateTime: shadowRouteEnabled() ? shadowDateTime() : undefined,
      }
      const { data, error } = await treaty.api.route.post(body)
      if (error) {
        setError(`Chyba výpočtu trasy: ${error.status} ${error.value?.message || ''}`)
      } else if (data) {
        setRoute({ ...data, geometry: data.geometry as [number, number][] })
      }
    } catch (err) {
      console.error('Route error:', err)
      setError('Neočekávaná chyba při výpočtu trasy')
    } finally { setLoading(false) }
  }

  const canCompute = () => stops().length >= 2 && !loading()

  // Register route calculator in app context (once, after mount — not during render)
  onMount(() => setRegenerateRoute(() => calculateRoute))

  return (
    <aside class="panel">
      {/* Header */}
      <div class="panel-header">
        <h1>Vrstevnice</h1>

        <Show when={error()}>
          <div class="error-alert">
            <span class="error-message">{error()}</span>
            <Button class="btn-ghost-sm" onClick={() => setError(null)}>×</Button>
          </div>
        </Show>

        <Search
          triggerMode="focus"
          options={results()}
          onInputChange={handleSearch}
          onChange={handleSelect}
          optionValue="name"
          optionLabel="displayName"
          placeholder="Hledat místo..."
          debounceOptionsMillisecond={300}
          itemComponent={(props: SearchRootItemComponentProps<GeocodeResult>) => (
            <Search.Item item={props.item} class="search-item">
              <div
                class="search-item-inner"
                onmouseenter={() => showSearchPreview(props.item.rawValue.lat, props.item.rawValue.lng)}
                onmouseleave={() => hideSearchPreview()}
              >
                <Search.ItemLabel>
                  <div class="search-item-name">{props.item.rawValue.name}</div>
                  <div class="search-item-detail">{props.item.rawValue.displayName}</div>
                </Search.ItemLabel>
              </div>
            </Search.Item>
          )}
        >
          <Search.Control class="search-control" aria-label="Hledat místo">
            <Search.Input class="search-input" ref={searchInput} />
          </Search.Control>
          <Search.Portal>
            <Search.Content class="search-content" onCloseAutoFocus={e => e.preventDefault()}>
              <Search.Listbox />
            </Search.Content>
          </Search.Portal>
        </Search>
      </div>

      {/* Stop list */}
      <div class="panel-body">
        <Show
          when={stops().length > 0}
          fallback={<p class="stops-empty">Přidejte alespoň 2 zastávky</p>}
        >
          <For each={stops()}>
            {(stop, index) => {
              const isFirst = () => index() === 0
              const isLast = () => index() === stops().length - 1
              const badgeClass = () =>
                isFirst() ? 'start' : isLast() ? 'end' : 'mid'

              return (
                <div class="stop">
                  <span class={`stop-badge ${badgeClass()}`}>
                    {index() + 1}
                  </span>
                  <span class="stop-name">{stop.name}</span>
                  <div class="stop-actions">
                    <Show when={!isFirst()}>
                      <Tooltip openDelay={400}>
                        <Tooltip.Trigger as={Button} class="btn-ghost-sm" onClick={() => moveStop(index(), -1)}>↑</Tooltip.Trigger>
                        <Tooltip.Content class="tooltip">Nahoru</Tooltip.Content>
                      </Tooltip>
                    </Show>
                    <Show when={!isLast()}>
                      <Tooltip openDelay={400}>
                        <Tooltip.Trigger as={Button} class="btn-ghost-sm" onClick={() => moveStop(index(), 1)}>↓</Tooltip.Trigger>
                        <Tooltip.Content class="tooltip">Dolů</Tooltip.Content>
                      </Tooltip>
                    </Show>
                    <Tooltip openDelay={400}>
                      <Tooltip.Trigger as={Button} class="btn-danger-sm" onClick={() => removeStop(index())}>×</Tooltip.Trigger>
                      <Tooltip.Content class="tooltip">Odebrat</Tooltip.Content>
                    </Tooltip>
                  </div>
                </div>
              )
            }}
          </For>
        </Show>
      </div>

      {/* Footer controls */}
      <div class="panel-footer">
        <Show when={route()}>
          <div class="route-stats">
            <span class="route-stat">
              <span class="route-stat-value">{(route()!.distance).toFixed(1)}</span>
              <span class="route-stat-unit">km</span>
            </span>
            <span class="route-stat">
              <span class="route-stat-emoji">⬆️</span>
              <span class="route-stat-value">{Math.round(route()!.elevationGain)}</span>
              <span class="route-stat-unit">m</span>
            </span>
            <span class="route-stat">
              <span class="route-stat-emoji">⬇️</span>
              <span class="route-stat-value">{Math.round(route()!.elevationLoss)}</span>
              <span class="route-stat-unit">m</span>
            </span>
            <span class="route-stat">
              <span class="route-stat-emoji">⏱️</span>
              <span class="route-stat-value">{Math.round(route()!.duration / 60)}</span>
              <span class="route-stat-unit">min</span>
            </span>
          </div>
        </Show>

        <Show when={loading()}>
          <Progress value={undefined} class="progress-root">
            <Progress.Track class="progress-track" />
          </Progress>
        </Show>

        <LabeledSlider value={elevCoeff()} onChange={setElevCoeff} label="Vyhnout se kopcům" minValue={0} maxValue={1} step={0.05} />

        <LabeledSlider value={roadAvoidCoeff()} onChange={setRoadAvoidCoeff} label="Vyhnutí silnicím" minValue={0} maxValue={1} step={0.05} />

        <LabeledSlider value={cyclewayCoeff()} onChange={setCyclewayCoeff} label="Cyklostezky" minValue={0} maxValue={1} step={0.05} />



        <Separator />

        <Button
          class="btn btn-primary"
          disabled={!canCompute()}
          onClick={calculateRoute}
        >
          {loading() ? '⏳ Výpočet…' : route() ? 'Přegenerovat trasu' : 'Vytvořit trasu'}
        </Button>

        <Show when={route()}>
          <Button class="btn btn-ghost" onClick={() => setRoute(null)}>
            Zrušit trasu
          </Button>
          <Button class="btn btn-ghost btn-fit-overview" onClick={() => {
            (window as any).__fitRouteOverview?.()
          }}>
            ⊞ Přehled trasy
          </Button>
          <Button class="btn btn-ghost" onClick={() => downloadGPX(route()!)}>
            ↓ Stáhnout GPX
          </Button>
        </Show>
      </div>
    </aside>
  )
}
