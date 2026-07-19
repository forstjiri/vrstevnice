import { createEffect, Show } from 'solid-js'
import { Badge } from '@kobalte/core/badge'
import { Button } from '@kobalte/core/button'
import { ToggleButton } from '@kobalte/core/toggle-button'
import Map from './Map'
import Stops from './Stops'
import ElevationChart from './ElevationChart'
import ShadowControls from './ShadowControls'
import { mapControls } from './mapControlsStore'
import { planner, sheetOpen, setSheetOpen, activeTab, setActiveTab } from './appStore'

export default function App() {
  const hasTerrainItems = () => mapControls.terrainOn || mapControls.hillshadeOn

  // Fallback to planner when route disappears
  createEffect(() => {
    if (!planner.route && activeTab() === 'chart') setActiveTab('planner')
    if (!hasTerrainItems() && activeTab() === 'terrain') setActiveTab('planner')
  })

  function selectTab(tab: 'planner' | 'terrain' | 'chart') {
    if (activeTab() === tab) {
      setSheetOpen((v) => !v)
    } else {
      setActiveTab(tab)
      setSheetOpen(true)
    }
  }

  return (
    <>
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
            <Show when={planner.stops.length > 0}>
              &nbsp;
              <Badge class="badge badge-tab" textValue={`${planner.stops.length} zastávky`}>
                {planner.stops.length}
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
          <Show when={planner.route}>
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
    </>
  )
}
