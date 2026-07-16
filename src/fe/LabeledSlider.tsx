import { Show, type JSX } from 'solid-js'
import { Slider } from '@kobalte/core/slider'

interface LabeledSliderProps {
  value: number
  onChange: (v: number) => void
  onChangeEnd?: () => void
  label: string
  minValue: number
  maxValue: number
  step: number
  labelExtra?: JSX.Element
  /** Custom value display; defaults to Slider.ValueLabel */
  valueDisplay?: JSX.Element
}

/**
 * Thin wrapper around Kobalte Slider that works with scalar values.
 * Encapsulates the number[] ↔ number conversion at the component boundary.
 */
export default function LabeledSlider(props: LabeledSliderProps) {
  return (
    <Slider
      value={[props.value]}
      onChange={(v) => props.onChange(v[0]!)}
      onChangeEnd={props.onChangeEnd}
      minValue={props.minValue}
      maxValue={props.maxValue}
      step={props.step}
    >
      <div class={`slider-label${props.labelExtra ? ' slider-label-experimental' : ''}`}>
        <Show when={props.labelExtra} fallback={<Slider.Label>{props.label}</Slider.Label>}>
          {props.labelExtra}
        </Show>
        <Show when={props.valueDisplay} fallback={<Slider.ValueLabel />}>
          {props.valueDisplay}
        </Show>
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
