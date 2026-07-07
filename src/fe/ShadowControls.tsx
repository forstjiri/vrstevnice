import { createSignal, Show, createEffect, untrack, createMemo } from 'solid-js'
import { Slider } from '@kobalte/core/slider'
import { Checkbox } from '@kobalte/core/checkbox'
import { Separator } from '@kobalte/core/separator'
import { rideAnimation, updateRideAnimation } from './rideAnimationStore'
import { formatLocalDate as formatLocalDateShared, parseLocalDateTime as parseLocalDateTimeShared } from '@vrstevnice/shared'
import { useApp } from './App'

export interface ShadowControlCallbacks {
  setTerrain: (enabled: boolean) => void
  setTerrainExaggeration: (v: number) => void
  setHillshade: (enabled: boolean) => void
  setHillshadeExaggeration: (v: number) => void
  setSunDateTime: (value: string) => void
  setContours: (enabled: boolean) => void
  getMap: () => any
}

interface ShadowControlsProps extends ShadowControlCallbacks {
  mapReady: () => boolean
  webglFailed: () => boolean
}

export default function ShadowControls(props: ShadowControlsProps) {
  const { setHillshadeEnabled, setShadowRouteEnabled, setShadowDateTime, showPOI, setShowPOI, regenerateRoute, loading, route, shadowRouteEnabled } = useApp()
  const [terrainOn, setTerrainOn] = createSignal(false)
  const [hillshadeOn, setHillshadeOn] = createSignal(false)
  const [shadowRouteOn, setShadowRouteOn] = createSignal(false)
  const [contoursOn, setContoursOn] = createSignal(true)
  const [hillshadeExaggeration, setHillshadeExaggeration] = createSignal<number[]>([1])
  const [exaggeration, setExaggeration] = createSignal<number[]>([1.5])
  const now = new Date()
  const [sunDate, setSunDate] = createSignal(formatLocalDate(now))
  const [sunMinutes, setSunMinutes] = createSignal<number[]>([now.getHours() * 60 + now.getMinutes()])

  /**
   * Re-fetch the route so BE recomputes the time-progressive shadowProfile.
   * Deferred via setTimeout(0) so derived signals (shadowRouteEnabled,
   * shadowDateTime) settle before calculateRoute reads them.
   */
  function maybeRegenerate() {
    if (!route() || loading()) return
    setTimeout(() => {
      if (!route() || loading() || !shadowRouteEnabled()) return
      void regenerateRoute()()
    }, 0)
  }
  const [collapsed, setCollapsed] = createSignal(false)

  const animatedSunDateTime = createMemo(() => {
    if (!hillshadeOn()) return null
    const anim = rideAnimation()
    if (!anim.playing || !anim.baseDateTime) return null
    const base = parseLocalDateTimeShared(anim.baseDateTime)
    if (!base) return null
    return new Date(base.getTime() + anim.elapsedMs)
  })

  const effectiveSunDate = createMemo(() => {
    const animated = animatedSunDateTime()
    return animated ? formatLocalDateShared(animated) : sunDate()
  })

  const effectiveSunMinutes = createMemo<number[]>(() => {
    const animated = animatedSunDateTime()
    return animated ? [animated.getHours() * 60 + animated.getMinutes()] : sunMinutes()
  })

  // ── Terrain toggle ──
  createEffect(() => {
    if (!props.mapReady()) return
    try { props.setTerrain(terrainOn()) } catch (_) {}
  })

  // ── Terrain exaggeration ──
  createEffect(() => {
    if (!props.mapReady()) return
    try { props.setTerrainExaggeration(exaggeration()[0]) } catch (_) {}
  })

  // ── Hillshade toggle ──
  createEffect(() => {
    if (!props.mapReady()) return
    try { props.setHillshade(hillshadeOn()) } catch (_) {}
  })

  createEffect(() => {
    setHillshadeEnabled(terrainOn() && hillshadeOn())
  })

  createEffect(() => {
    setShadowRouteEnabled(terrainOn() && hillshadeOn() && shadowRouteOn())
  })

  // ── Hillshade exaggeration ──
  createEffect(() => {
    if (!props.mapReady()) return
    try { props.setHillshadeExaggeration(hillshadeExaggeration()[0]) } catch (_) {}
  })

  // ── Sun datetime ──
  createEffect(() => {
    if (!props.mapReady()) return
    const dtStr = composeLocalDateTime(effectiveSunDate(), effectiveSunMinutes()[0])
    try { props.setSunDateTime(dtStr) } catch (_) {}
    setShadowDateTime(dtStr)
    untrack(() => {
      if (!rideAnimation().playing || !hillshadeOn()) {
        updateRideAnimation({ currentDateTime: dtStr })
      }
    })
  })

  // ── Contour lines toggle ──
  createEffect(() => {
    if (!props.mapReady()) return
    try { props.setContours(contoursOn()) } catch (_) {}
  })

  return (
    <div class={`shadow-controls${collapsed() ? ' shadow-controls-collapsed' : ''}`}>
      <div class="shadow-controls-header" onClick={() => setCollapsed(!collapsed())}>
        <span class="shadow-controls-title">Terén</span>
        <span class="shadow-controls-toggle">{collapsed() ? '▸' : '▾'}</span>
      </div>
      <Show when={!collapsed()}>
        <div class="shadow-controls-body">
          <Show when={!props.webglFailed()}>
            <div class="shadow-control-row">
              <Checkbox checked={terrainOn()} onChange={setTerrainOn} class="shadow-checkbox">
                <Checkbox.Input class="shadow-checkbox-input" />
                <Checkbox.Control class="shadow-checkbox-control" />
                <Checkbox.Label class="shadow-checkbox-label">3D terén</Checkbox.Label>
              </Checkbox>
            </div>

            <Show when={terrainOn()}>
              <div class="shadow-control-row">
                <Checkbox checked={hillshadeOn()} onChange={(v) => { setHillshadeOn(v); maybeRegenerate() }} class="shadow-checkbox">
                  <Checkbox.Input class="shadow-checkbox-input" />
                  <Checkbox.Control class="shadow-checkbox-control" />
                  <Checkbox.Label class="shadow-checkbox-label">Stínování svahů</Checkbox.Label>
                </Checkbox>
              </div>

              <Show when={hillshadeOn()}>
                <div class="shadow-control-row">
                  <Checkbox checked={shadowRouteOn()} onChange={(v) => { setShadowRouteOn(v); maybeRegenerate() }} class="shadow-checkbox">
                    <Checkbox.Input class="shadow-checkbox-input" />
                    <Checkbox.Control class="shadow-checkbox-control" />
                    <Checkbox.Label class="shadow-checkbox-label">Při výpočtu trasy řešit stín 🐢</Checkbox.Label>
                  </Checkbox>
                </div>
              </Show>
            </Show>

            <div class="shadow-control-row">
              <Checkbox checked={showPOI()} onChange={setShowPOI} class="shadow-checkbox">
                <Checkbox.Input class="shadow-checkbox-input" />
                <Checkbox.Control class="shadow-checkbox-control" />
                <Checkbox.Label class="shadow-checkbox-label">Zobrazit občerstvení po cestě</Checkbox.Label>
              </Checkbox>
            </div>

            <div class="shadow-control-row">
              <Checkbox checked={contoursOn()} onChange={setContoursOn} class="shadow-checkbox">
                <Checkbox.Input class="shadow-checkbox-input" />
                <Checkbox.Control class="shadow-checkbox-control" />
                <Checkbox.Label class="shadow-checkbox-label">Vrstevnice</Checkbox.Label>
              </Checkbox>
            </div>

            <Separator />

            <div class="shadow-control-row shadow-control-row-datetime">
              <label class="shadow-datetime-label" for="shadow-date">
                Datum
              </label>
              <input
                id="shadow-date"
                class="shadow-datetime-input"
                type="date"
                value={effectiveSunDate()}
                onInput={(e) => { setSunDate(e.currentTarget.value); maybeRegenerate() }}
              />
            </div>

            <Show when={hillshadeOn()}>
              <Slider
                value={effectiveSunMinutes()}
                onChange={setSunMinutes}
                onChangeEnd={maybeRegenerate}
                minValue={0}
                maxValue={1439}
                step={15}
              >
                <div class="slider-label">
                  <Slider.Label>Čas</Slider.Label>
                  <span class="slider-value">{formatMinutes(effectiveSunMinutes()[0])}</span>
                </div>
                <Slider.Track class="slider-track">
                  <Slider.Fill class="slider-range" />
                  <Slider.Thumb class="slider-thumb">
                    <Slider.Input class="slider-input" />
                  </Slider.Thumb>
                </Slider.Track>
              </Slider>

              <Slider
                value={hillshadeExaggeration()}
                onChange={setHillshadeExaggeration}
                minValue={0}
                maxValue={3}
                step={0.05}
              >
                <div class="slider-label">
                  <Slider.Label>Intenzita stínování</Slider.Label>
                  <Slider.ValueLabel />
                </div>
                <Slider.Track class="slider-track">
                  <Slider.Fill class="slider-range" />
                  <Slider.Thumb class="slider-thumb">
                    <Slider.Input class="slider-input" />
                  </Slider.Thumb>
                </Slider.Track>
              </Slider>
            </Show>

            <Show when={terrainOn()}>
              <Slider
                value={exaggeration()}
                onChange={setExaggeration}
                minValue={0.5}
                maxValue={3}
                step={0.1}
              >
                <div class="slider-label">
                  <Slider.Label>Přesvěcení terénu</Slider.Label>
                  <Slider.ValueLabel />
                </div>
                <Slider.Track class="slider-track">
                  <Slider.Fill class="slider-range" />
                  <Slider.Thumb class="slider-thumb">
                    <Slider.Input class="slider-input" />
                  </Slider.Thumb>
                </Slider.Track>
              </Slider>
            </Show>
          </Show>

          <Show when={props.webglFailed()}>
            <p class="shadow-webgl-warning">
              WebGL není dostupný. 3D terén a stíny vyžadují hardwarovou akceleraci.
            </p>
          </Show>
        </div>
      </Show>
    </div>
  )
}

const formatLocalDate = formatLocalDateShared

function formatMinutes(totalMinutes: number): string {
  const minutes = ((Math.round(totalMinutes) % 1440) + 1440) % 1440
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(hours)}:${pad(mins)}`
}

function composeLocalDateTime(date: string, totalMinutes: number): string {
  const minutes = ((Math.round(totalMinutes) % 1440) + 1440) % 1440
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date}T${pad(hours)}:${pad(mins)}`
}
