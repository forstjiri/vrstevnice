import { createStore } from 'solid-js/store'
import { createMemo, createEffect, untrack } from 'solid-js'
import { formatLocalDate, parseLocalDateTime } from '@vrstevnice/shared'
import { rideAnimation, updateRideAnimation } from './rideAnimationStore'

const now = new Date()

// ── Store ──

export const [mapControls, setMapControls] = createStore({
  terrainOn: false,
  hillshadeOn: false,
  contoursOn: true,
  shadowRouteOn: false,
  hillshadeExaggeration: [1] as number[],
  exaggeration: [1.5] as number[],
  sunDate: formatLocalDate(now),
  sunMinutes: [now.getHours() * 60 + now.getMinutes()] as number[],
})

// ── Derived: ride animation sync ──

const animatedSunDateTime = createMemo(() => {
  if (!mapControls.hillshadeOn) return null
  const anim = rideAnimation()
  if (!anim.playing || !anim.baseDateTime) return null
  const base = parseLocalDateTime(anim.baseDateTime)
  if (!base) return null
  return new Date(base.getTime() + anim.elapsedMs)
})

export const effectiveSunDate = createMemo(() => {
  const animated = animatedSunDateTime()
  return animated ? formatLocalDate(animated) : mapControls.sunDate
})

export const effectiveSunMinutes = createMemo<number[]>(() => {
  const animated = animatedSunDateTime()
  return animated ? [animated.getHours() * 60 + animated.getMinutes()] : mapControls.sunMinutes
})

// ── Helpers ──

export function formatMinutes(totalMinutes: number): string {
  const minutes = ((Math.round(totalMinutes) % 1440) + 1440) % 1440
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(hours)}:${pad(mins)}`
}

export function composeLocalDateTime(date: string, totalMinutes: number): string {
  const minutes = ((Math.round(totalMinutes) % 1440) + 1440) % 1440
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date}T${pad(hours)}:${pad(mins)}`
}

// ── Map wiring: bridge store → MapLibre mutable state ──

export interface MapWiringDeps {
  mapReady: () => boolean
  onTerrain: (enabled: boolean) => void
  onTerrainExaggeration: (v: number) => void
  onHillshade: (enabled: boolean) => void
  onHillshadeIntensity: (v: number) => void
  onSunDateTime: (value: string) => void
  onContours: (enabled: boolean) => void
  setHillshadeEnabledCtx: (v: boolean) => void
  setShadowRouteEnabledCtx: (v: boolean) => void
  setShadowDateTimeCtx: (v: string) => void
}

export function wireMapControls(deps: MapWiringDeps) {
  createEffect(() => {
    if (!deps.mapReady()) return
    deps.onTerrain(mapControls.terrainOn)
  })

  createEffect(() => {
    if (!deps.mapReady()) return
    deps.onTerrainExaggeration(mapControls.exaggeration[0])
  })

  createEffect(() => {
    if (!deps.mapReady()) return
    deps.onHillshade(mapControls.hillshadeOn)
  })

  createEffect(() => {
    deps.setHillshadeEnabledCtx(mapControls.terrainOn && mapControls.hillshadeOn)
  })

  createEffect(() => {
    deps.setShadowRouteEnabledCtx(mapControls.terrainOn && mapControls.hillshadeOn && mapControls.shadowRouteOn)
  })

  createEffect(() => {
    if (!deps.mapReady()) return
    deps.onHillshadeIntensity(mapControls.hillshadeExaggeration[0])
  })

  createEffect(() => {
    if (!deps.mapReady()) return
    const dtStr = composeLocalDateTime(effectiveSunDate(), effectiveSunMinutes()[0])
    deps.onSunDateTime(dtStr)
    deps.setShadowDateTimeCtx(dtStr)
    untrack(() => {
      if (!rideAnimation().playing || !mapControls.hillshadeOn) {
        updateRideAnimation({ currentDateTime: dtStr })
      }
    })
  })

  createEffect(() => {
    if (!deps.mapReady()) return
    deps.onContours(mapControls.contoursOn)
  })
}
