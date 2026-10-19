import { For, Show } from 'solid-js';
import { Slider } from '@kobalte/core/slider';
import { BIKE_TYPES } from '@vrstevnice/shared';
import type { BikeType, BikeRecommendationSummary } from '@vrstevnice/shared';
import roadIcon from './assets/bikes/road.svg?url';
import gravelIcon from './assets/bikes/gravel.svg?url';
import mtbIcon from './assets/bikes/mtb.svg?url';
import freerideIcon from './assets/bikes/freeride.svg?url';

export const BIKE_LABELS: Record<BikeType, string> = {
  road: 'Silnice', gravel: 'Gravel', mtb: 'MTB', freeride: 'Freeride',
};
const BIKE_ICONS: Record<BikeType, string> = {
  road: roadIcon, gravel: gravelIcon, mtb: mtbIcon, freeride: freerideIcon,
};

function BikeIcon(props: { bike: BikeType }) {
  return (
    <img
      class="bike-icon"
      src={BIKE_ICONS[props.bike]}
      alt=""
      aria-hidden="true"
    />
  );
}

export default function BikeTypeSlider(props: {
  value: BikeType | null;
  onChange: (value: BikeType) => void;
  onChangeEnd?: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <Slider
      class="bike-slider"
      value={[props.value == null ? 0 : BIKE_TYPES.indexOf(props.value)]}
      minValue={0}
      maxValue={3}
      step={1}
      disabled={props.disabled}
      onChange={(values) => props.onChange(BIKE_TYPES[values[0]])}
      onChangeEnd={(values) => {
        props.onChange(BIKE_TYPES[values[0]]);
        props.onChangeEnd?.();
      }}
      getValueLabel={({ values }) => BIKE_LABELS[BIKE_TYPES[values[0]]]}
    >
      <div class="slider-label">
        <Slider.Label>{props.label}</Slider.Label>
        <span>{props.value == null ? 'Vyberte kolo' : BIKE_LABELS[props.value]}</span>
      </div>
      <Slider.Track class="bike-scale-track">
        <For each={BIKE_TYPES}>{(bike, index) => (
          <span
            class="bike-scale-dot"
            data-bike={bike}
            style={{ left: `${(index() / 3) * 100}%` }}
          />
        )}</For>
        <Slider.Thumb
          class="slider-thumb bike-slider-thumb"
          classList={{ unselected: props.value == null }}
        >
          <Slider.Input class="slider-input" />
        </Slider.Thumb>
      </Slider.Track>
      <div class="bike-scale-labels">
        <For each={BIKE_TYPES}>{(bike) => (
          <button
            type="button"
            class="bike-scale-choice"
            classList={{ selected: props.value === bike }}
            aria-pressed={props.value === bike}
            disabled={props.disabled}
            onClick={() => {
              props.onChange(bike);
              props.onChangeEnd?.();
            }}
          ><BikeIcon bike={bike} />{BIKE_LABELS[bike]}</button>
        )}</For>
      </div>
    </Slider>
  );
}

export function BikeRecommendationScale(props: {
  summary: BikeRecommendationSummary;
}) {
  return (
    <div class="bike-recommendation">
      <Show when={props.summary.minimum} fallback={<span>Typ kola zatím nikdo neuvedl.</span>}>
        {(minimum) => (
          <>
            <span>
              Minimum: <strong>{BIKE_LABELS[minimum()]}</strong> · {props.summary.total} doporučení
            </span>
            <div class="bike-scale-track" aria-hidden="true">
              <For each={BIKE_TYPES}>{(bike, index) => (
                <span
                  class="bike-scale-dot"
                  classList={{ selected: minimum() === bike }}
                  data-bike={bike}
                  style={{ left: `${(index() / 3) * 100}%` }}
                />
              )}</For>
            </div>
            <div class="bike-scale-labels">
              <For each={BIKE_TYPES}>{(bike) => (
                <span class="bike-scale-choice" classList={{ selected: minimum() === bike }}>
                  <BikeIcon bike={bike} />
                  {BIKE_LABELS[bike]}<span>{props.summary.counts[bike]}</span>
                </span>
              )}</For>
            </div>
            <span class="bike-recommendation-note">
              Minimum je medián hlasů. Vliv na plánování od 5 doporučení;
              silné potlačení od 10 při většinové shodě, že kolo nestačí.
            </span>
          </>
        )}
      </Show>
    </div>
  );
}
