import { Show } from 'solid-js'
import { Slider } from '@kobalte/core/slider'
import {
  mapControls,
  setMapControls,
  effectiveSunMinutes,
  formatMinutes,
} from './mapControlsStore'
import { useApp } from './App'

/**
 * Advanced sliders panel for terrain/shadow fine-tuning.
 * Toggle state lives in mapControlsStore; toggles themselves
 * are rendered in Map.tsx toolbar and Stops.tsx panel.
 */
export default function ShadowControls(props: { webglFailed: () => boolean }) {
  const { route, loading, shadowRouteEnabled, regenerateRoute } = useApp()

  function maybeRegenerate() {
    if (!route() || loading()) return
    setTimeout(() => {
      if (!route() || loading() || !shadowRouteEnabled()) return
      void regenerateRoute()()
    }, 0)
  }

  return (
    <div class="shadow-controls">
      <Show when={!props.webglFailed()}>
        <div class="shadow-controls-body">
          <Show when={mapControls.hillshadeOn}>
            <Slider
              value={effectiveSunMinutes()}
              onChange={(v) => setMapControls('sunMinutes', v)}
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
              value={mapControls.hillshadeExaggeration}
              onChange={(v) => setMapControls('hillshadeExaggeration', v)}
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

          <Show when={mapControls.terrainOn}>
            <Slider
              value={mapControls.exaggeration}
              onChange={(v) => setMapControls('exaggeration', v)}
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
        </div>
      </Show>

      <Show when={props.webglFailed()}>
        <p class="shadow-webgl-warning">
          WebGL není dostupný. 3D terén a stíny vyžadují hardwarovou akceleraci.
        </p>
      </Show>
    </div>
  )
}
