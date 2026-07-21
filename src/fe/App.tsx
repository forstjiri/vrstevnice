import { createEffect, Show } from 'solid-js'
import { Badge } from '@kobalte/core/badge'
import { Button } from '@kobalte/core/button'
import { Tabs } from '@kobalte/core/tabs'
import Map from './Map'
import Stops from './Stops'
import ElevationChart from './ElevationChart'
import ShadowControls from './ShadowControls'
import { mapControls } from './mapControlsStore'
import { planner, sheetOpen, setSheetOpen, activeTab, setActiveTab } from './appStore'

export default function App() {
  const hasTerrainItems = () => mapControls.terrainOn || mapControls.hillshadeOn
  const isDesktop = () => window.matchMedia('(min-width: 801px)').matches
  let panel: HTMLElement | undefined
  let opener = 'planner'
  let initialized = false

  // Fallback to planner when route disappears
  createEffect(() => {
    if (!planner.route && activeTab() === 'chart') setActiveTab('planner')
    if (!hasTerrainItems() && activeTab() === 'terrain') setActiveTab('planner')
  })

  createEffect(() => {
    const open = sheetOpen()
    if (!initialized) { initialized = true; return }
    if (isDesktop()) return
    requestAnimationFrame(() => {
      if (open) panel?.querySelector<HTMLElement>('.search-input, .sheet-close')?.focus()
      else panel?.querySelector<HTMLElement>(`[data-panel-tab="${opener}"]`)?.focus()
    })
  })

  function selectTab(tab: 'planner' | 'terrain' | 'chart', el?: HTMLElement) {
    if (isDesktop()) return
    if (el) opener = tab
    if (activeTab() === tab) {
      setSheetOpen((v) => !v)
    } else setSheetOpen(true)
  }

  return (
    <>
      <Map />
      <aside ref={panel} class={`workspace ${sheetOpen() ? 'workspace-is-open' : 'workspace-is-closed'}`} aria-label="Plánovač trasy">
        <Tabs class="workspace-tabs" value={activeTab()} onChange={(tab) => setActiveTab(tab as 'planner' | 'terrain' | 'chart')}>
          <Tabs.List class="workspace-tab-list" aria-label="Nástroje plánovače">
            <Tabs.Trigger class="workspace-tab" value="planner" data-panel-tab="planner" onClick={(e) => selectTab('planner', e.currentTarget)}>
              🗺️ Trasa <Show when={planner.stops.length > 0}><Badge class="badge badge-tab" textValue={`${planner.stops.length} zastávky`}>{planner.stops.length}</Badge></Show>
            </Tabs.Trigger>
            <Show when={hasTerrainItems()}><Tabs.Trigger class="workspace-tab" value="terrain" data-panel-tab="terrain" onClick={(e) => selectTab('terrain', e.currentTarget)}>🏔️ Terén</Tabs.Trigger></Show>
            <Show when={planner.route}><Tabs.Trigger class="workspace-tab" value="chart" data-panel-tab="chart" onClick={(e) => selectTab('chart', e.currentTarget)}>📊 Graf</Tabs.Trigger></Show>
          </Tabs.List>
          <Button
            class="btn btn-icon-circle sheet-close"
            onClick={() => setSheetOpen(false)}
            aria-label="Zavřít panel"
          >
            ×
          </Button>
          <Tabs.Content class="workspace-tab-panel" value="planner"><Stops /></Tabs.Content>
          <Show when={hasTerrainItems()}><Tabs.Content class="workspace-tab-panel" value="terrain"><ShadowControls /></Tabs.Content></Show>
          <Show when={planner.route}><Tabs.Content class="workspace-tab-panel" value="chart"><ElevationChart /></Tabs.Content></Show>
        </Tabs>
      </aside>
    </>
  )
}
