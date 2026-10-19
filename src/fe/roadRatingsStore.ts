import { createRoot, createSignal, type Accessor } from 'solid-js';
import type {
  BikeType,
  RoadRatingAggregate,
  RoadRatingSubtype,
  RoadRatingType,
  RoadRatingComment,
} from '@vrstevnice/shared';
import type { FeatureCollection, LineString } from 'geojson';
import treaty from './api';

export interface RoadRatingSelection {
  wayId: number;
  name: string | null;
  type: RoadRatingAggregate['type'];
  counts: RoadRatingAggregate['counts'];
  commentsCount: number;
  bikeRecommendation: RoadRatingAggregate['bikeRecommendation'] | null;
  mine: RoadRatingAggregate['mine'];
}

const ctx = createRoot(() => {
  const [roadRatingMode, setRoadRatingModeSignal] = createSignal(false);
  const [roadRatingSelection, setRoadRatingSelection] = createSignal<
    RoadRatingSelection | null
  >(null);
  const [roadRatingRevision, setRoadRatingRevision] = createSignal(0);

  return {
    roadRatingMode,
    setRoadRatingMode: setRoadRatingModeSignal,
    roadRatingSelection,
    setRoadRatingSelection,
    roadRatingRevision,
    setRoadRatingRevision,
  };
});

export const roadRatingMode: Accessor<boolean> = ctx.roadRatingMode;

export function setRoadRatingMode(value: boolean): void {
  ctx.setRoadRatingMode(value);
}

export const roadRatingSelection: Accessor<RoadRatingSelection | null> = ctx.roadRatingSelection;

export function openRoadRatingModal(selection: RoadRatingSelection): void {
  ctx.setRoadRatingSelection(selection);
}

export function closeRoadRatingModal(): void {
  ctx.setRoadRatingSelection(null);
}

export const roadRatingRevision: Accessor<number> = ctx.roadRatingRevision;

export function refreshRoadRatings(): void {
  ctx.setRoadRatingRevision((revision) => revision + 1);
}

function errorMessage(error: object | string, fallback: string): string {
  if (typeof error === 'object' && error !== null) {
    const value = error as { status?: number; value?: object | string };
    if (typeof value.value === 'object' && value.value !== null && 'message' in value.value) {
      const { message } = value.value;
      if (typeof message === 'string' && message.length > 0) {
        return `${message}${value.status ? ` (${value.status})` : ''}`;
      }
    }
    if (typeof value.value === 'string' && value.value.length > 0) {
      return `${value.value}${value.status ? ` (${value.status})` : ''}`;
    }
    if (typeof value.status === 'number') return `${fallback} (${value.status})`;
  }
  return fallback;
}

export async function fetchRoadRatings(
  bounds: { minLng: number; minLat: number; maxLng: number; maxLat: number },
): Promise<RoadRatingAggregate[]> {
  const bbox = `${bounds.minLng},${bounds.minLat},${bounds.maxLng},${bounds.maxLat}`;
  const { data, error } = await treaty.api['road-ratings'].get({ $query: { bbox } });
  if (error) throw new Error(errorMessage(error, 'Načtení hodnocení cest selhalo'));
  return data ?? [];
}

export async function fetchRoadRatingRoads(
  bounds: { minLng: number; minLat: number; maxLng: number; maxLat: number },
): Promise<FeatureCollection<LineString, { osm_id: number; name: string | null }>> {
  const bbox = `${bounds.minLng},${bounds.minLat},${bounds.maxLng},${bounds.maxLat}`;
  const response = await fetch(`/api/road-rating-roads?bbox=${encodeURIComponent(bbox)}`);
  if (!response.ok) throw new Error('Načtení cest pro hodnocení selhalo');
  return response.json() as Promise<FeatureCollection<
    LineString,
    { osm_id: number; name: string | null }
  >>;
}

export async function fetchRoadRatingByWayId(wayId: number): Promise<RoadRatingAggregate | null> {
  const { data, error } = await treaty.api['road-ratings'][wayId].get();
  if (error) throw new Error(errorMessage(error, 'Načtení hodnocení cesty selhalo'));
  return data ?? null;
}

export async function fetchRoadRatingComments(
  wayId: number,
  offset: number,
): Promise<{ comments: RoadRatingComment[]; hasMore: boolean }> {
  const { data, error } = await treaty.api['road-ratings'][wayId].comments.get({
    $query: { offset: String(offset) },
  });
  if (error) throw new Error('Načtení komentářů selhalo');
  return {
    comments: data.comments.map((comment) => ({
      ...comment,
      subtypes: comment.subtypes as RoadRatingSubtype[],
    })),
    hasMore: data.hasMore,
  };
}

export async function saveRoadRating(input: {
  wayId: number;
  name?: string;
  type: RoadRatingType;
  subtypes: RoadRatingSubtype[];
  comment?: string;
  minimumBike?: BikeType;
}): Promise<RoadRatingAggregate> {
  const { data, error } = await treaty.api['road-ratings'].post(input);
  if (error) throw new Error(errorMessage(error, 'Uložení hodnocení cesty selhalo'));
  if (!data) throw new Error('Server nevrátil uložené hodnocení cesty');
  return data;
}

export async function deleteRoadRating(wayId: number): Promise<RoadRatingAggregate> {
  const { data, error } = await treaty.api['road-ratings'][wayId].delete();
  if (error) throw new Error(errorMessage(error, 'Zrušení hodnocení cesty selhalo'));
  if (!data) throw new Error('Server nevrátil zrušené hodnocení cesty');
  return data;
}
