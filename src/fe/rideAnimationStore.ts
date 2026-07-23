import { createSignal } from 'solid-js';
import { persistedSignal } from './persist';

interface RideAnimationState {
  /** Whether the animation is currently playing */
  playing: boolean;
  /** Animation speed multiplier (e.g. 10 = 10x real speed) */
  speed: number;
  /** Current distance along the route in meters (0 = start, totalDistance = end) */
  currentDistance: number;
  /** Elapsed simulated time in ms since animation start */
  elapsedMs: number;
  /** Computed datetime string for current position (set by the animation loop) */
  currentDateTime: string | null;
  /** Base datetime saved when animation started (from ShadowControls) */
  baseDateTime: string | null;
}

// Persisted speed preference — restored on reload
const [rideSpeed, setRideSpeed] = persistedSignal<number>(10, {
  name: 'vrstevnice.ride-speed',
});

const [rideAnimation, setRideAnimation] = createSignal<RideAnimationState>({
  playing: false,
  speed: rideSpeed(),
  currentDistance: 0,
  elapsedMs: 0,
  currentDateTime: null,
  baseDateTime: null,
});

function updateRideAnimation(partial: Partial<RideAnimationState>) {
  setRideAnimation((prev) => ({ ...prev, ...partial }));
  if (partial.speed !== undefined) setRideSpeed(partial.speed);
}

// Camera target — mutable ref, NOT a signal (avoid re-render in rAF)
// Map.tsx reads this in its own rAF loop to smoothly interpolate camera
interface CameraTarget {
  lng: number;
  lat: number;
  bearing: number;
  active: boolean;
  preZoom: number | null;
}

const cameraTarget: CameraTarget = {
  lng: 0,
  lat: 0,
  bearing: 0,
  active: false,
  preZoom: null,
};

function setCameraTarget(
  lng: number,
  lat: number,
  bearing: number,
  active: boolean,
  preZoom: number | null = null,
) {
  cameraTarget.lng = lng;
  cameraTarget.lat = lat;
  cameraTarget.bearing = bearing;
  cameraTarget.active = active;
  if (preZoom !== null) cameraTarget.preZoom = preZoom;
}

export {
  rideAnimation, setRideAnimation, updateRideAnimation, cameraTarget, setCameraTarget,
};
