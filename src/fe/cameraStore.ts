import { createRoot } from 'solid-js';
import { persistedSignal } from './persist';

export interface MapCamera {
  lat: number;
  lon: number;
  zoom: number;
  bearing: number;
  pitch: number;
}

export const [mapCamera, setMapCamera] = createRoot(() => persistedSignal<MapCamera | null>(null, {
  name: 'vrstevnice.map-camera',
}));
