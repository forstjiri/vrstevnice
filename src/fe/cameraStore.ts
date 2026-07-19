import { persistedSignal } from './persist'

export interface MapCamera {
  lat: number
  lon: number
  zoom: number
  bearing: number
  pitch: number
}

export const [mapCamera, setMapCamera] = persistedSignal<MapCamera | null>(
  null,
  { name: 'vrstevnice.map-camera' },
)
