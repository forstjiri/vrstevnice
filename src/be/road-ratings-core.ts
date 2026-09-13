import {
  ROAD_RATING_DEMOTE_SUBTYPES,
  ROAD_RATING_PREFER_SUBTYPES,
  ROAD_RATING_SUBTYPE_MULTIPLIERS,
} from '@vrstevnice/shared';
import type { RoadRatingSubtype, RoadRatingType } from '@vrstevnice/shared';

// Bump whenever the derivation of cached rated-road geometry changes
// (buffer/cap logic, group chaining, anchors...). Rows with an older
// version are rebuilt from the original OSM ways on BE startup.
export const RATED_ROAD_GEOMETRY_VERSION = 2;

export function medianOf(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function perUserMultiplier(
  _type: RoadRatingType,
  subtypes: RoadRatingSubtype[],
): number {
  return medianOf(subtypes.map((subtype) => ROAD_RATING_SUBTYPE_MULTIPLIERS[subtype]));
}

export function aggregateRatings(
  votes: { multiplier: number }[],
): { multiplier: number | null } {
  return { multiplier: votes.length > 0 ? medianOf(votes.map((vote) => vote.multiplier)) : null };
}

export function validateSubtypes(
  type: RoadRatingType,
  subtypes: string[],
): subtypes is RoadRatingSubtype[] {
  const allowed = type === 'prefer'
    ? ROAD_RATING_PREFER_SUBTYPES
    : ROAD_RATING_DEMOTE_SUBTYPES;
  return subtypes.length > 0
    && new Set(subtypes).size === subtypes.length
    && subtypes.every(
      (subtype): subtype is RoadRatingSubtype => (allowed as readonly string[]).includes(subtype),
    );
}

function roundedPoint(lng: number, lat: number): [number, number] {
  return [Number(lng.toFixed(6)), Number(lat.toFixed(6))];
}

export function buildBufferPolygon(
  line: [number, number][],
  // Kept small so that a rated way's polygon does not swallow neighboring
  // ways running close/parallel to it (OSM segments are often just a few
  // meters apart).
  bufferMeters = 8,
  // GraphHopper marks an edge as "in area" when the polygon merely
  // INTERSECTS the edge geometry (CustomWeightingHelper.in). Ways sharing
  // junction nodes with the rated way would get penalized if the polygon
  // reached those nodes, so the buffer is inset from both line ends.
  endInsetMeters = 12,
): [number, number][] {
  if (line.length === 0) return [];
  const earthMetersPerDegree = 111_320;
  const midpointLat = line.reduce((sum, [, lat]) => sum + lat, 0) / line.length;
  const cosLat = Math.max(0.01, Math.cos((midpointLat * Math.PI) / 180));
  const toMeters = ([lng, lat]: [number, number]): [number, number] => [
    lng * earthMetersPerDegree * cosLat,
    lat * earthMetersPerDegree,
  ];
  const origin = toMeters(line[0]);
  const points = line.map((point) => {
    const [x, y] = toMeters(point);
    return [x - origin[0], y - origin[1]] as [number, number];
  });

  // Trim both line ends by endInsetMeters so the polygon never reaches
  // junction nodes shared with neighboring ways.
  const cumDist: number[] = [0];
  for (let i = 1; i < points.length; i += 1) {
    const dx = points[i][0] - points[i - 1][0];
    const dy = points[i][1] - points[i - 1][1];
    cumDist.push(cumDist[i - 1] + Math.hypot(dx, dy));
  }
  const totalLength = cumDist[cumDist.length - 1];
  if (points.length > 1 && totalLength > 2) {
    const inset = Math.min(endInsetMeters, (totalLength - 2) / 2);
    const pointAt = (target: number): [number, number] => {
      for (let i = 1; i < points.length; i += 1) {
        if (cumDist[i] >= target) {
          const t = (target - cumDist[i - 1]) / (cumDist[i] - cumDist[i - 1] || 1);
          return [
            points[i - 1][0] + (points[i][0] - points[i - 1][0]) * t,
            points[i - 1][1] + (points[i][1] - points[i - 1][1]) * t,
          ];
        }
      }
      return points[points.length - 1];
    };
    const trimmed: [number, number][] = [pointAt(inset)];
    for (let i = 0; i < points.length; i += 1) {
      if (cumDist[i] > inset && cumDist[i] < totalLength - inset) trimmed.push(points[i]);
    }
    trimmed.push(pointAt(totalLength - inset));
    points.length = 0;
    points.push(...trimmed);
  }

  const directions: [number, number][] = points.map((point, index) => {
    const previous = points[Math.max(0, index - 1)];
    const next = points[Math.min(points.length - 1, index + 1)];
    const previousDx = point[0] - previous[0];
    const previousDy = point[1] - previous[1];
    const nextDx = next[0] - point[0];
    const nextDy = next[1] - point[1];
    const previousLength = Math.hypot(previousDx, previousDy);
    const nextLength = Math.hypot(nextDx, nextDy);
    const dx = (previousLength > 0 ? previousDx / previousLength : 0)
      + (nextLength > 0 ? nextDx / nextLength : 0);
    const dy = (previousLength > 0 ? previousDy / previousLength : 0)
      + (nextLength > 0 ? nextDy / nextLength : 0);
    const length = Math.hypot(dx, dy);
    return length > 0 ? [dx / length, dy / length] : [1, 0];
  });
  const left: [number, number][] = directions.map(([dx, dy], index) => {
    const nx = -dy;
    const ny = dx;
    return [
      points[index][0] + nx * bufferMeters,
      points[index][1] + ny * bufferMeters,
    ];
  });
  const right: [number, number][] = directions.map(([dx, dy], index) => {
    const nx = -dy;
    const ny = dx;
    return [
      points[index][0] - nx * bufferMeters,
      points[index][1] - ny * bufferMeters,
    ];
  });
  const toLngLat = ([x, y]: [number, number]): [number, number] => roundedPoint(
    line[0][0] + x / (earthMetersPerDegree * cosLat),
    line[0][1] + y / earthMetersPerDegree,
  );

  if (points.length === 1) {
    const ring: [number, number][] = [];
    for (let i = 0; i <= 8; i += 1) {
      const angle = (i / 8) * Math.PI * 2;
      ring.push(toLngLat([
        points[0][0] + Math.cos(angle) * bufferMeters,
        points[0][1] + Math.sin(angle) * bufferMeters,
      ]));
    }
    return ring;
  }

  // Butt cap (no end arcs): the ring connects the left side directly to the
  // right side at both endpoints. Semicircular caps would extend the polygon
  // past shared junction nodes and penalize neighboring ways (e.g. another
  // OSM segment of the same physical road) beyond the rated way itself.
  const ring = left.map(toLngLat);
  for (let i = right.length - 1; i >= 0; i -= 1) ring.push(toLngLat(right[i]));
  ring.push(ring[0]);
  return ring;
}

export function bucketizeRoads(
  roads: { wayId: number; multiplier: number }[],
): { multiplier: number; wayIds: number[] }[] {
  const buckets = new Map<number, number[]>();
  roads.forEach(({ wayId, multiplier }) => {
    const rounded = Math.round(multiplier * 100) / 100;
    const wayIds = buckets.get(rounded) ?? [];
    wayIds.push(wayId);
    buckets.set(rounded, wayIds);
  });
  return [...buckets.entries()].map(([multiplier, wayIds]) => ({ multiplier, wayIds }));
}

export function chainGeometryPieces(pieces: [number, number][][]): [number, number][][] {
  const endpointKey = (point: [number, number]) => `${point[0].toFixed(6)},${point[1].toFixed(6)}`;
  const remaining = pieces.map((piece) => [...piece]);
  const chains: [number, number][][] = [];
  while (remaining.length > 0) {
    const chain = remaining.shift()!;
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < remaining.length; i += 1) {
        const candidate = remaining[i];
        const start = endpointKey(chain[0]);
        const end = endpointKey(chain[chain.length - 1]);
        const joinsEndForward = endpointKey(candidate[0]) === end;
        const joinsEndBackward = endpointKey(candidate[candidate.length - 1]) === end;
        const joinsStartBackward = endpointKey(candidate[candidate.length - 1]) === start;
        const joinsStartForward = endpointKey(candidate[0]) === start;
        const joinsChain = joinsEndForward
          || joinsEndBackward
          || joinsStartBackward
          || joinsStartForward;
        if (joinsEndForward) {
          chain.push(...candidate.slice(1));
        } else if (joinsEndBackward) {
          chain.push(...candidate.slice(0, -1).reverse());
        } else if (joinsStartBackward) {
          chain.unshift(...candidate.slice(0, -1));
        } else if (joinsStartForward) {
          chain.unshift(...candidate.slice(1).reverse());
        }
        if (joinsChain) {
          remaining.splice(i, 1);
          changed = true;
          break;
        }
      }
    }
    chains.push(chain);
  }
  return chains;
}

export function corridorBounds(
  stops: { lat: number; lng: number }[],
  padMeters = 10_000,
): { minLng: number; minLat: number; maxLng: number; maxLat: number } {
  if (stops.length === 0) {
    const padDegrees = padMeters / 111_320;
    return {
      minLng: -padDegrees, minLat: -padDegrees, maxLng: padDegrees, maxLat: padDegrees,
    };
  }
  const minLat = Math.min(...stops.map((stop) => stop.lat));
  const maxLat = Math.max(...stops.map((stop) => stop.lat));
  const minLng = Math.min(...stops.map((stop) => stop.lng));
  const maxLng = Math.max(...stops.map((stop) => stop.lng));
  const midLat = (minLat + maxLat) / 2;
  const lngPad = padMeters / (111_320 * Math.max(0.01, Math.cos((midLat * Math.PI) / 180)));
  const latPad = padMeters / 111_320;
  return {
    minLng: minLng - lngPad,
    minLat: minLat - latPad,
    maxLng: maxLng + lngPad,
    maxLat: maxLat + latPad,
  };
}

export interface AreasFeatureCollection {
  featureCollection: {
    type: 'FeatureCollection';
    features: {
      type: 'Feature';
      id: string;
      properties: Record<string, never>;
      geometry: { type: 'Polygon'; coordinates: number[][][] };
    }[];
  };
  areaToWayId: Map<string, number>;
}

export interface VotedRoadGeometry {
  wayId: number;
  multiplier: number;
  geometry: [number, number][][];
}

export interface RoadRatingModelParts {
  areas: AreasFeatureCollection['featureCollection'];
  buckets: { multiplier: number; areaIds: string[] }[];
}

export function buildAreasFeatureCollection(
  polygonsByWayId: Map<number, [number, number][][]>,
  idPrefix = 'rr',
): AreasFeatureCollection {
  const features: AreasFeatureCollection['featureCollection']['features'] = [];
  const areaToWayId = new Map<string, number>();
  polygonsByWayId.forEach((rings, wayId) => {
    rings.forEach((ring, subIndex) => {
      const id = `${idPrefix}${wayId}_${subIndex}`;
      features.push({
        type: 'Feature',
        id,
        properties: {},
        geometry: { type: 'Polygon', coordinates: [ring] },
      });
      areaToWayId.set(id, wayId);
    });
  });
  return { featureCollection: { type: 'FeatureCollection', features }, areaToWayId };
}

export function buildRoadRatingModelParts(
  roads: VotedRoadGeometry[],
): RoadRatingModelParts {
  const polygonsByWayId = new Map<number, [number, number][][]>();
  roads.forEach((road) => {
    const rings = road.geometry
      .map((line) => buildBufferPolygon(line))
      .filter((ring) => ring.length >= 4);
    if (rings.length > 0) polygonsByWayId.set(road.wayId, rings);
  });
  const areas = buildAreasFeatureCollection(polygonsByWayId);
  const buckets = bucketizeRoads(roads).map((bucket) => ({
    multiplier: bucket.multiplier,
    areaIds: [...areas.areaToWayId.entries()]
      .filter(([, wayId]) => bucket.wayIds.includes(wayId))
      .map(([areaId]) => areaId),
  })).filter((bucket) => bucket.areaIds.length > 0);
  return { areas: areas.featureCollection, buckets };
}

export interface RatingThrottleResult {
  ok: boolean;
  retryAfterSec: number;
}

export function createRatingThrottle(
  now: () => number = () => Date.now(),
): (ip: string) => RatingThrottleResult {
  const timestampsByIp = new Map<string, number[]>();
  return (ip: string): RatingThrottleResult => {
    const currentTime = now();
    const timestamps = (timestampsByIp.get(ip) ?? [])
      .filter((timestamp) => timestamp > currentTime - 3_600_000);
    const minuteTimestamps = timestamps.filter((timestamp) => timestamp > currentTime - 60_000);
    if (minuteTimestamps.length >= 5 || timestamps.length >= 60) {
      const candidates = [
        minuteTimestamps.length >= 5
          ? minuteTimestamps[minuteTimestamps.length - 4] + 60_000
          : Infinity,
        timestamps.length >= 60 ? timestamps[0] + 3_600_000 : Infinity,
      ];
      const retryAfterSec = Math.max(1, Math.ceil((Math.min(...candidates) - currentTime) / 1000));
      timestampsByIp.set(ip, timestamps);
      return { ok: false, retryAfterSec };
    }
    timestamps.push(currentTime);
    timestampsByIp.set(ip, timestamps);
    return { ok: true, retryAfterSec: 0 };
  };
}
