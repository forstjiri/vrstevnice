import {
  createSignal, For, Show, onMount,
} from 'solid-js';
import * as maplibregl from 'maplibre-gl';
import { Search } from '@kobalte/core/search';
import { Button } from '@kobalte/core/button';
import { Separator } from '@kobalte/core/separator';
import { Progress } from '@kobalte/core/progress';
import { Tooltip } from '@kobalte/core/tooltip';
import { ToggleButton } from '@kobalte/core/toggle-button';
import type { RouteRequest, GeocodeResult } from '@vrstevnice/shared';
import { detectAndParseGPS } from '@vrstevnice/shared';
import type { SearchRootItemComponentProps } from '@kobalte/core/search';
import treaty from './api';
import { downloadGPX } from './gpx';
import LabeledSlider from './LabeledSlider';
import {
  planner,
  setStops,
  removeStop,
  moveStop,
  setRoute,
  clearRoute,
  setLoading,
  setError,
  loading,
  error,
  setRegenerateFn,
  regenerateRoute,
  setElevation,
  setRoadAvoid,
  setCycleway,
  setShowPOI,
} from './appStore';
import { mapCamera } from './cameraStore';
import {
  mapControls,
  mapControlActions,
  shadowRouteActive,
  effectiveSunDateTime,
} from './mapControlsStore';

export default function Stops() {
  const [results, setResults] = createSignal<GeocodeResult[]>([]);

  function showResultPreview(result: GeocodeResult) {
    showSearchPreview(result.lat, result.lng);
  }

  function showSearchPreview(lat: number, lng: number) {
    const map = window.__map;
    if (!map) return;
    hideSearchPreview();
    const geojson = {
      type: 'Feature' as const,
      properties: {},
      geometry: {
        type: 'Point' as const,
        coordinates: [lng, lat],
      },
    };
    if (!map.getSource('search-preview')) {
      map.addSource('search-preview', { type: 'geojson', data: geojson });
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
      });
      map.addLayer({
        id: 'search-preview-dot',
        type: 'circle',
        source: 'search-preview',
        paint: {
          'circle-radius': 5,
          'circle-color': '#3b82f6',
        },
      });
    } else {
      (map.getSource('search-preview') as maplibregl.GeoJSONSource).setData(geojson);
    }
    map.flyTo({
      center: [lng, lat],
      zoom: Math.max(map.getZoom(), 16),
      duration: 600,
    });
  }

  function hideSearchPreview() {
    const map = window.__map;
    if (!map) return;
    try {
      if (map.getSource('search-preview')) {
        map.removeLayer('search-preview-circle');
        map.removeLayer('search-preview-dot');
        map.removeSource('search-preview');
      }
    } catch {}
  }
  const handleSearch = async (query: string) => {
    if (query.length < 3) {
      setResults([]);
      return;
    }
    setError(null);
    try {
      // Geocode via BE — BE handles GPS detection (DD/DDM/DMS),
      // Photon fallback chain (local :2322 → photon.komoot.io),
      // and location bias from map center.
      const center = mapCamera();
      const queryParams: {
        q: string;
        lat?: string;
        lon?: string;
        zoom?: string;
      } = { q: query };
      if (center) {
        queryParams.lat = String(center.lat);
        queryParams.lon = String(center.lon);
        queryParams.zoom = String(Math.round(center.zoom));
      }
      const { data, error: geocodeError } = await treaty.api.geocode.get({
        $query: queryParams,
      });
      if (geocodeError) {
        setError('Chyba při vyhledávání místa');
        setResults([]);
        return;
      }
      setResults((data ?? []) as GeocodeResult[]);
    } catch {
      setError('Chyba při vyhledávání místa');
      setResults([]);
    }
  };

  let searchInput: HTMLInputElement | undefined;

  const handleSelect = (result: GeocodeResult | null) => {
    hideSearchPreview();
    if (!result) return;
    setStops([...planner.stops, { lat: result.lat, lng: result.lng, name: result.name }]);
    setResults([]);
    if (searchInput) searchInput.value = '';
  };

  const calculateRoute = async () => {
    setLoading(true);
    setError(null);
    try {
      const body: RouteRequest = {
        stops: planner.stops,
        elevationCoefficient: planner.elevation,
        roadAvoidanceCoefficient: 1 - planner.roadAvoid,
        cyclewayCoefficient: planner.cycleway,
        showPOI: planner.showPOI,
        shadowDateTime: shadowRouteActive() ? effectiveSunDateTime() : undefined,
      };
      const { data, error: routeError } = await treaty.api.route.post(body);
      if (routeError) {
        setError(`Chyba výpočtu trasy: ${routeError.status} ${routeError.value?.message || ''}`);
      } else if (data) {
        setRoute({ ...data, geometry: data.geometry as [number, number][] });
      }
    } catch {
      setError('Neočekávaná chyba při výpočtu trasy');
    } finally {
      setLoading(false);
    }
  };

  const canCompute = () => planner.stops.length >= 2 && !loading();
  const routeButtonLabel = () => {
    if (loading()) return '⏳ Výpočet…';
    return planner.route ? 'Přegenerovat trasu' : 'Vytvořit trasu';
  };

  // Register route calculator (once, after mount — not during render)
  onMount(() => setRegenerateFn(() => calculateRoute));

  return (
    <div class="sheet-content">
      {/* Header */}
      <div class="sheet-header">
        <h1>Vrstevnice</h1>

        <Show when={error()}>
          <div class="error-alert">
            <span class="error-message">{error()}</span>
            <Button class="btn-ghost-sm" onClick={() => setError(null)}>
              ×
            </Button>
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
                onMouseEnter={() => showResultPreview(props.item.rawValue)}
                onMouseLeave={() => hideSearchPreview()}
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
            <Search.Input
              class="search-input"
              ref={searchInput}
              onKeyDown={(e: KeyboardEvent) => {
                if (e.key === 'Enter') {
                  const text = (e.target as HTMLInputElement).value.trim();
                  if (text) {
                    const gps = detectAndParseGPS(text);
                    if (gps) {
                      e.preventDefault();
                      setStops([
                        ...planner.stops,
                        { lat: gps.lat, lng: gps.lng, name: `${gps.lat}, ${gps.lng}` },
                      ]);
                      setResults([]);
                      (e.target as HTMLInputElement).value = '';
                    }
                  }
                }
              }}
            />
          </Search.Control>
          <Search.Portal>
            <Search.Content class="search-content" onCloseAutoFocus={(e) => e.preventDefault()}>
              <Search.Listbox />
            </Search.Content>
          </Search.Portal>
        </Search>
      </div>

      {/* Stop list */}
      <div class="sheet-body">
        <Show
          when={planner.stops.length > 0}
          fallback={<p class="stops-empty">Přidejte alespoň 2 zastávky</p>}
        >
          <For each={planner.stops}>
            {(stop, index) => {
              const isFirst = () => index() === 0;
              const isLast = () => index() === planner.stops.length - 1;
              const badgeClass = () => {
                if (isFirst()) return 'start';
                return isLast() ? 'end' : 'mid';
              };

              return (
                <div class="stop">
                  <span class={`stop-badge ${badgeClass()}`}>{index() + 1}</span>
                  <span class="stop-name">{stop.name}</span>
                  <div class="stop-actions">
                    <Show when={!isFirst()}>
                      <Tooltip openDelay={400}>
                        <Tooltip.Trigger
                          as={Button}
                          class="btn-ghost-sm"
                          onClick={() => moveStop(index(), -1)}
                        >
                          ↑
                        </Tooltip.Trigger>
                        <Tooltip.Content class="tooltip">Nahoru</Tooltip.Content>
                      </Tooltip>
                    </Show>
                    <Show when={!isLast()}>
                      <Tooltip openDelay={400}>
                        <Tooltip.Trigger
                          as={Button}
                          class="btn-ghost-sm"
                          onClick={() => moveStop(index(), 1)}
                        >
                          ↓
                        </Tooltip.Trigger>
                        <Tooltip.Content class="tooltip">Dolů</Tooltip.Content>
                      </Tooltip>
                    </Show>
                    <Tooltip openDelay={400}>
                      <Tooltip.Trigger
                        as={Button}
                        class="btn-danger-sm"
                        onClick={() => removeStop(index())}
                      >
                        ×
                      </Tooltip.Trigger>
                      <Tooltip.Content class="tooltip">Odebrat</Tooltip.Content>
                    </Tooltip>
                  </div>
                </div>
              );
            }}
          </For>
        </Show>
      </div>

      <div class="sheet-footer">
        <Show when={planner.route}>
          <div class="route-stats">
            <span class="route-stat">
              <span class="route-stat-value">{planner.route!.distance.toFixed(1)}</span>
              <span class="route-stat-unit">km</span>
            </span>
            <span class="route-stat">
              <span class="route-stat-emoji">⬆️</span>
              <span class="route-stat-value">{Math.round(planner.route!.elevationGain)}</span>
              <span class="route-stat-unit">m</span>
            </span>
            <span class="route-stat">
              <span class="route-stat-emoji">⬇️</span>
              <span class="route-stat-value">{Math.round(planner.route!.elevationLoss)}</span>
              <span class="route-stat-unit">m</span>
            </span>
            <span class="route-stat">
              <span class="route-stat-emoji">⏱️</span>
              <span class="route-stat-value">{Math.round(planner.route!.duration / 60)}</span>
              <span class="route-stat-unit">min</span>
            </span>
          </div>
        </Show>

        <Show when={loading()}>
          <Progress value={undefined} class="progress-root">
            <Progress.Track class="progress-track" />
          </Progress>
        </Show>

        <div class="sheet-toggles">
          <ToggleButton
            class="btn-toggle btn-toggle-label"
            pressed={planner.showPOI}
            onChange={setShowPOI}
          >
            🍻 Občerstvení na cestě
          </ToggleButton>
          <ToggleButton
            class="btn-toggle btn-toggle-label"
            pressed={mapControls.shadowRouteOn}
            onChange={(p) => {
              mapControlActions.setShadowRouteOn(p);
              if (!planner.route || loading()) return;
              setTimeout(() => {
                if (!planner.route || loading() || !shadowRouteActive()) return;
                regenerateRoute();
              }, 0);
            }}
          >
            ☀️ Slunce na trase
          </ToggleButton>
        </div>

        <LabeledSlider
          value={planner.elevation}
          onChange={setElevation}
          label="Vyhnout se stoupání"
          minValue={0}
          maxValue={1}
          step={0.05}
        />

        <LabeledSlider
          value={planner.roadAvoid}
          onChange={setRoadAvoid}
          label="Vyhnutí silnicím"
          minValue={0}
          maxValue={1}
          step={0.05}
        />

        <LabeledSlider
          value={planner.cycleway}
          onChange={setCycleway}
          label="Cyklostezky"
          minValue={0}
          maxValue={1}
          step={0.05}
        />
      </div>

      <Separator />

      <div class="button-wrap">
        <Button class="btn btn-primary" disabled={!canCompute()} onClick={calculateRoute}>
          {routeButtonLabel()}
        </Button>

        <Show when={planner.route}>
          <Button class="btn btn-ghost" onClick={() => clearRoute()}>
            Zrušit trasu
          </Button>
          <Button
            class="btn btn-ghost btn-fit-overview"
            onClick={() => {
              window.__fitRouteOverview?.();
            }}
          >
            ⊞ Přehled trasy
          </Button>
          <Button class="btn btn-ghost" onClick={() => downloadGPX(planner.route!)}>
            ↓ Stáhnout GPX
          </Button>
        </Show>
      </div>
    </div>
  );
}
