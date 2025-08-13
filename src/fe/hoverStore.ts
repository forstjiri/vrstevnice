import { createRoot, createSignal } from 'solid-js';

interface HoveredPoint {
  distance: number;
  elevation: number;
}

const [hoveredPoint, setHoveredPoint] = createRoot(() => createSignal<HoveredPoint | null>(null));

export { hoveredPoint, setHoveredPoint };
