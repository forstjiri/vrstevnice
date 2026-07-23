import { createSignal } from 'solid-js';

interface HoveredPoint {
  distance: number;
  elevation: number;
}

const [hoveredPoint, setHoveredPoint] = createSignal<HoveredPoint | null>(null);

export { hoveredPoint, setHoveredPoint };
