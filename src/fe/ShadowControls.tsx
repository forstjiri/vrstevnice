import { Show } from 'solid-js';
import {
  mapControls,
  mapControlActions,
  shadowRouteActive,
  effectiveSunDate,
  effectiveSunMinutes,
  formatMinutes,
} from './mapControlsStore';
import LabeledSlider from './LabeledSlider';
import { planner, loading, regenerateRoute } from './appStore';

/**
 * Advanced sliders panel for terrain/shadow fine-tuning.
 * Toggle state lives in mapControlsStore; toggles themselves
 * are rendered in Map.tsx toolbar and Stops.tsx panel.
 */
export default function ShadowControls() {
  const route = () => planner.route;

  function maybeRegenerate() {
    if (!route() || loading()) return;
    setTimeout(() => {
      if (!route() || loading() || !shadowRouteActive()) return;
      regenerateRoute();
    }, 0);
  }

  return (
    <div class="sheet-content">
      <div class="sheet-header">
        <h1>Terén</h1>
      </div>
      <div class="sheet-body shadow-controls-body">
        <Show when={mapControls.hillshadeOn}>
          <div class="shadow-control-row shadow-control-row-datetime">
            <label class="shadow-datetime-label" for="shadow-date">
              Datum
            </label>
            <input
              id="shadow-date"
              class="shadow-datetime-input"
              type="date"
              value={effectiveSunDate()}
              onInput={(e) => {
                mapControlActions.setSunDate(e.currentTarget.value);
                maybeRegenerate();
              }}
            />
          </div>

          <LabeledSlider
            label="Čas"
            value={effectiveSunMinutes()}
            onChange={mapControlActions.setSunMinutes}
            onChangeEnd={maybeRegenerate}
            minValue={0}
            maxValue={1439}
            step={15}
            valueDisplay={<span class="slider-value">{formatMinutes(effectiveSunMinutes())}</span>}
          />

          <LabeledSlider
            label="Intenzita stínování"
            value={mapControls.hillshadeIntensity}
            onChange={mapControlActions.setHillshadeIntensity}
            minValue={0.2}
            maxValue={1}
            step={0.05}
          />
        </Show>

        <Show when={mapControls.terrainOn}>
          <LabeledSlider
            label="Přesvěcení terénu"
            value={mapControls.terrainExaggeration}
            onChange={mapControlActions.setTerrainExaggeration}
            minValue={0.5}
            maxValue={3}
            step={0.1}
          />
        </Show>
      </div>
    </div>
  );
}
