import type {
  ElevationPoint,
  JsonValue,
  POILocation,
  RoadClassSegment,
  RouteResponse,
  Stop,
  SurfaceSegment, RoadRatingBucket,
} from '@vrstevnice/shared';
import {
  haversineMeters, isValidOsmWayId, MAX_ROAD_RATING_MODEL_MEMBER_IDS,
} from '@vrstevnice/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GHCustomModelRule {
  if: string;
  multiply_by: string;
}

export interface GHCustomModel {
  priority: GHCustomModelRule[];
  distance_influence: number;
}

export interface GHPoint {
  point: [number, number]; // [lon, lat]
}

export interface GHRouteRequest {
  points: [number, number][]; // [[lon, lat], ...]
  profile: string;
  elevation: boolean;
  points_encoded: boolean;
  'ch.disable': boolean;
  details?: string[];
  custom_model?: GHCustomModel;
}

export interface GHPath {
  distance: number; // meters
  time: number; // milliseconds
  ascend: number; // meters
  descend: number; // meters
  points: {
    type: string;
    coordinates: [number, number, number][]; // [lon, lat, ele]
  };
  instructions: JsonValue[];
  details?: Record<string, JsonValue[]>;
}

export interface GHRouteResponse {
  paths: GHPath[];
  info?: { errors?: JsonValue[] };
}

export interface GHRouteResult {
  distance: number; // meters (raw GH)
  duration: number; // milliseconds (raw GH)
  elevationGain: number; // meters
  elevationLoss: number; // meters
  geometry: [number, number, number][]; // [lon, lat, ele]
  surfaceSegments: SurfaceSegment[];
  roadClassSegments: RoadClassSegment[];
  roadEnvSegments: RoadClassSegment[]; // reuse same shape: { from, to, roadClass: string }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const GRAPHHOPPER_URL = (typeof process !== 'undefined' ? process.env?.GRAPHHOPPER_URL : undefined)
  || 'http://localhost:8989';

// ---------------------------------------------------------------------------
// Custom model builder
// ---------------------------------------------------------------------------

/**
 * Map the three frontend coefficients to GraphHopper `priority` rules.
 *
 * - roadAvoidanceCoefficient 0→1: penalize MOTORWAY+TRUNK (0.1→1.0),
 *   PRIMARY (0.2→1.0), SECONDARY (0.2→1.0), TERTIARY (0.5→1.0)
 * - elevationCoefficient 0→1: 0 = no ascent avoidance, 1 = avoid ascent.
 *   Two-tier system:
 *   (a) Constant steep penalty (always on, slider-independent):
 *       max_slope > 12% and max_slope < -12% → 0.8 (light penalty for
 *       very steep sections in both directions)
 *   (b) Slider-controlled uphill penalty:
 *       average_slope > 3% (0.7→1.0), > 6% (0.5→1.0), > 10% (0.3→1.0).
 *       GH slope values are SIGNED: positive = uphill, negative = downhill.
 *       average_slope > X matches only uphill edges.
 * - cyclewayCoefficient 0→1: boost CYCLEWAY priority (1.0→3.0), lower
 *   distance_influence (allow longer detours)
 * - distance_influence = base plus coefficient-dependent adjustments.
 *   Elevation does NOT reduce distance_influence.
 * @param roadRatingBuckets Optional community-rating priority buckets.
 */
export function buildCustomModel(
  elevationCoefficient: number,
  roadAvoidanceCoefficient: number,
  cyclewayCoefficient = 0,
  roadRatingBuckets?: RoadRatingBucket[],
): GHCustomModel {
  const roadRules: GHCustomModelRule[] = [
    {
      if: 'road_class == MOTORWAY || road_class == TRUNK',
      multiply_by: String(lerp(0.1, 1.0, roadAvoidanceCoefficient)),
    },
    {
      if: 'road_class == PRIMARY',
      multiply_by: String(lerp(0.2, 1.0, roadAvoidanceCoefficient)),
    },
    {
      if: 'road_class == SECONDARY',
      multiply_by: String(lerp(0.2, 1.0, roadAvoidanceCoefficient)),
    },
    {
      if: 'road_class == TERTIARY',
      multiply_by: String(lerp(0.5, 1.0, roadAvoidanceCoefficient)),
    },
  ];

  // Constant steep penalty (always on, both directions, slider-independent).
  // GH max_slope is SIGNED: positive = uphill, negative = downhill.
  const steepPenaltyRules: GHCustomModelRule[] = [
    {
      if: 'max_slope > 12',
      multiply_by: '0.8',
    },
    {
      if: 'max_slope < -12',
      multiply_by: '0.8',
    },
  ];

  // Slider-controlled uphill penalty. average_slope > X matches only uphill (positive slope).
  // At elevationCoefficient=0 all multipliers are 1.0 (no penalty).
  // At elevationCoefficient=1 multipliers reach their minimum (strongest penalty).
  const uphillRules: GHCustomModelRule[] = [
    {
      if: 'average_slope > 10',
      multiply_by: String(lerp(0.3, 1.0, 1 - elevationCoefficient)),
    },
    {
      if: 'average_slope > 6',
      multiply_by: String(lerp(0.5, 1.0, 1 - elevationCoefficient)),
    },
    {
      if: 'average_slope > 3',
      multiply_by: String(lerp(0.7, 1.0, 1 - elevationCoefficient)),
    },
  ];

  const cyclewayRules: GHCustomModelRule[] = [
    {
      if: 'road_class == CYCLEWAY',
      multiply_by: String(lerp(1.0, 3.0, cyclewayCoefficient)),
    },
    {
      if: 'cycleway != NO',
      multiply_by: String(lerp(1.0, 1.5, cyclewayCoefficient)),
    },
  ];

  const distanceInfluence = Math.max(
    30,
    70 + (1 - roadAvoidanceCoefficient) * 30 - cyclewayCoefficient * 30,
  );

  // Exact per-way community penalties via the osm_way_id encoded value —
  // no polygon areas, no neighbor bleed. Malformed IDs are a data error:
  // they must surface, not silently disappear from the model.
  const ratingRules = (roadRatingBuckets ?? []).map((bucket) => {
    const invalid = bucket.wayIds.filter((id) => !isValidOsmWayId(id));
    if (invalid.length > 0) {
      throw new Error(`Invalid OSM way IDs in rating bucket: ${invalid.join(', ')}`);
    }
    if (bucket.wayIds.length === 0) {
      throw new Error('Rating bucket without any OSM way IDs');
    }
    if (
      !Number.isFinite(bucket.multiplier)
      || bucket.multiplier < 0.05
      || bucket.multiplier > 1.7
    ) {
      throw new Error(`Invalid road-rating multiplier: ${bucket.multiplier}`);
    }
    return {
      if: bucket.wayIds.map((id) => `osm_way_id == ${id}`).join(' || '),
      multiply_by: String(bucket.multiplier),
    };
  });
  const ratingMemberCount = ratingRules.reduce(
    (count, _rule, index) => count + (roadRatingBuckets?.[index].wayIds.length ?? 0),
    0,
  );
  if (ratingMemberCount > MAX_ROAD_RATING_MODEL_MEMBER_IDS) {
    throw new Error(
      `Road-rating custom model exceeds the ${MAX_ROAD_RATING_MODEL_MEMBER_IDS}-member limit`,
    );
  }

  return {
    priority: [
      ...roadRules,
      ...steepPenaltyRules,
      ...uphillRules,
      ...cyclewayRules,
      ...ratingRules,
    ],
    distance_influence: distanceInfluence,
  };
}

// ---------------------------------------------------------------------------
// Route fetcher
// ---------------------------------------------------------------------------

/**
 * POST to GraphHopper /route and return a typed GHRouteResult.
 *
 * - `ch.disable: true` (required for custom models)
 * - `points_encoded: false` for raw [lon, lat, ele] coordinates
 * - `elevation: true` for ascend/descend
 * - `profile: 'bike'`
 */
export async function fetchRouteFromGH(
  stops: Stop[],
  customModel: GHCustomModel,
): Promise<GHRouteResult> {
  const url = `${GRAPHHOPPER_URL}/route`;

  // GH points input is [[lon, lat], ...] — stops have {lat, lng}
  const points: [number, number][] = stops.map((s) => [s.lng, s.lat]);

  const body: GHRouteRequest = {
    points,
    profile: 'bike',
    elevation: true,
    points_encoded: false,
    'ch.disable': true,
    details: ['surface', 'road_class', 'road_environment'],
    custom_model: customModel,
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const message = `GraphHopper fetch failed: ${GRAPHHOPPER_URL} — ${(err as Error).message}`;
    process.stderr.write(`${message}\n`);
    throw new Error(`Could not connect to GraphHopper at ${GRAPHHOPPER_URL}`);
  }

  if (!res.ok) {
    const text = await res.text();
    process.stderr.write(`GraphHopper error: ${res.status} ${GRAPHHOPPER_URL} — ${text}\n`);
    throw new Error(`GraphHopper returned ${res.status}: ${text}`);
  }

  const data: GHRouteResponse = await res.json();

  if (data.info?.errors?.length) {
    throw new Error(`GraphHopper routing errors: ${JSON.stringify(data.info.errors)}`);
  }

  const path = data.paths?.[0];
  if (!path) {
    throw new Error('No route found by GraphHopper');
  }

  const surfaceSegments = parseDetailTriples(path.details, 'surface').map(
    ([from, to, surface]) => ({ from, to, surface }),
  );
  const roadClassSegments = parseDetailTriples(path.details, 'road_class').map(
    ([from, to, roadClass]) => ({ from, to, roadClass }),
  );
  const roadEnvSegments = parseDetailTriples(path.details, 'road_environment').map(
    ([from, to, env]) => ({ from, to, roadClass: env }),
  );

  return {
    distance: path.distance,
    duration: path.time,
    elevationGain: path.ascend,
    elevationLoss: path.descend,
    geometry: path.points.coordinates,
    surfaceSegments,
    roadClassSegments,
    roadEnvSegments,
  };
}

// ---------------------------------------------------------------------------
// Detail segment parser
// ---------------------------------------------------------------------------

/**
 * Parse GraphHopper `details[key]` triples into [from, to, value] tuples.
 * Each triple represents a segment [from, to] (geometry indices) with a string value.
 */
type DetailTriple = [number, number, string];

function isDetailTriple(value: JsonValue): value is DetailTriple {
  return Array.isArray(value)
    && value.length >= 3
    && typeof value[0] === 'number'
    && typeof value[1] === 'number'
    && typeof value[2] === 'string';
}

function parseDetailTriples(
  details: Record<string, JsonValue[]> | null | undefined,
  key: string,
): [number, number, string][] {
  const raw = details?.[key];
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const result: [number, number, string][] = [];
  raw.forEach((entry) => {
    if (isDetailTriple(entry)) result.push([entry[0], entry[1], entry[2]]);
  });
  return result;
}

/** Parse GraphHopper `details.surface` triples into SurfaceSegment[]. */
export const parseSurfaceSegments = (
  details: Record<string, JsonValue[]> | null | undefined,
): SurfaceSegment[] => parseDetailTriples(details, 'surface').map(([from, to, surface]) => ({
  from,
  to,
  surface,
}));

/** Parse GraphHopper `details.road_class` triples into RoadClassSegment[]. */
export const parseRoadClassSegments = (
  details: Record<string, JsonValue[]> | null | undefined,
): RoadClassSegment[] => parseDetailTriples(details, 'road_class').map(([from, to, roadClass]) => ({
  from,
  to,
  roadClass,
}));

// ---------------------------------------------------------------------------
// Coordinate converter
// ---------------------------------------------------------------------------

/**
 * Swap GH [lon, lat, ele] → Leaflet [lat, lng][] (drops elevation).
 */
export function convertGHGeometryToLeaflet(coords: [number, number, number][]): [number, number][] {
  return coords.map(([lon, lat]) => [lat, lon]);
}

// ---------------------------------------------------------------------------
// Unit converter
// ---------------------------------------------------------------------------

/**
 * Convert a GHRouteResult to the app's RouteResponse contract.
 * - distance: meters → kilometers
 * - duration: milliseconds → seconds
 * - geometry: swapped for Leaflet
 */
export function convertGHToRouteResponse(ghResult: GHRouteResult): RouteResponse {
  const rawProfile = computeElevationProfile(ghResult.geometry);
  const smoothedProfile = smoothElevationProfile(rawProfile);
  const { gain, loss } = computeElevationGainLoss(smoothedProfile);

  return {
    geometry: convertGHGeometryToLeaflet(ghResult.geometry),
    distance: Math.round(ghResult.distance / 100) / 10, // meters → km, 1 decimal
    duration: Math.round(ghResult.duration / 1000), // ms → seconds
    elevationGain: gain,
    elevationLoss: loss,
    elevationProfile: smoothedProfile,
    surfaceSegments: ghResult.surfaceSegments,
    roadClassSegments: ghResult.roadClassSegments,
    roadEnvSegments: ghResult.roadEnvSegments ?? [],
    poiLocations: [],
    allPOILocations: [],
    slopeBasedTimes: computeSlopeCumulativeTimes(smoothedProfile, ghResult.duration),
  };
}

// ---------------------------------------------------------------------------
// Elevation profile
// ---------------------------------------------------------------------------

/**
 * Compute cumulative-distance elevation profile from GH [lon, lat, ele] coordinates.
 *
 * Returns an array of {distance, elevation} points where distance is cumulative
 * haversine distance in meters from the start of the route.
 * Points with NaN/undefined elevation are excluded.
 */
export function computeElevationProfile(
  coords: [number, number, number | null | undefined][],
): ElevationPoint[] {
  const profile: ElevationPoint[] = [];
  let cumulativeDistance = 0;

  for (let i = 0; i < coords.length; i += 1) {
    const [lon, lat, ele] = coords[i];

    // Skip coordinates with missing or invalid elevation
    if (ele != null && Number.isFinite(ele)) {
      if (i > 0) {
        const [prevLon, prevLat] = coords[i - 1];
        cumulativeDistance += haversineMeters(prevLat, prevLon, lat, lon);
      }
      profile.push({ distance: cumulativeDistance, elevation: ele });
    }
  }

  return profile;
}

/**
 * Smooth an elevation profile using a distance-based moving average.
 *
 * SRTM DEM data (used by GraphHopper) contains pixel-level jitter that inflates
 * the apparent roughness of terrain. A ~100m symmetric window removes most of
 * this noise while preserving real climbs and descents.
 *
 * Only elevation values are averaged — distances are left untouched.
 */
export function smoothElevationProfile(
  profile: ElevationPoint[],
  halfWindowM = 50,
): ElevationPoint[] {
  if (profile.length < 3) return profile.map((p) => ({ ...p }));

  const smoothed: ElevationPoint[] = [];
  for (let i = 0; i < profile.length; i += 1) {
    let sum = 0;
    let count = 0;
    for (let j = i; j >= 0 && profile[i].distance - profile[j].distance <= halfWindowM; j -= 1) {
      sum += profile[j].elevation;
      count += 1;
    }
    for (
      let j = i + 1;
      j < profile.length && profile[j].distance - profile[i].distance <= halfWindowM;
      j += 1
    ) {
      sum += profile[j].elevation;
      count += 1;
    }
    smoothed.push({
      distance: profile[i].distance,
      elevation: Math.round(sum / count),
    });
  }
  return smoothed;
}

/**
 * Compute total ascent and descent from an elevation profile.
 *
 * Uses a minimum-delta threshold: only elevation changes exceeding `minDeltaM`
 * (measured from the last counted point, not the immediately preceding point)
 * are accumulated. This filters out residual DEM noise that survives smoothing.
 *
 * Without this, consecutive sub-threshold jitter would still inflate totals.
 */
export function computeElevationGainLoss(
  profile: ElevationPoint[],
  minDeltaM = 1.5,
): { gain: number; loss: number } {
  if (profile.length < 2) return { gain: 0, loss: 0 };

  let gain = 0;
  let loss = 0;
  let lastCounted = profile[0].elevation;

  for (let i = 1; i < profile.length; i += 1) {
    const delta = profile[i].elevation - lastCounted;
    if (delta > minDeltaM) {
      gain += delta;
      lastCounted = profile[i].elevation;
    } else if (delta < -minDeltaM) {
      loss += -delta;
      lastCounted = profile[i].elevation;
    }
    // Sub-threshold: don't update lastCounted — accumulate until a real feature emerges
  }

  return { gain: Math.round(gain), loss: Math.round(loss) };
}

// ---------------------------------------------------------------------------
// Slope-based cumulative travel time
// ---------------------------------------------------------------------------

/**
 * Convert slope percentage to estimated cycling speed (km/h).
 *
 * Uses a simple power-law model:
 * - Uphill: speed decreases exponentially with steepness
 * - Downhill: speed increases moderately, capped at MAX_SPEED_KMH
 * - Flat: BASE_SPEED_KMH
 *
 * Clamped to [MIN_SPEED_KMH, MAX_SPEED_KMH].
 */
export function slopeSpeedKmh(slopePct: number): number {
  const climb = Math.max(0, slopePct);
  const descent = Math.max(0, -slopePct);
  const speed = 20 * Math.max(0, 1 - 0.04 * climb) ** 1.5 * (1 + 0.02 * descent) ** 1.2;
  return Math.max(5, Math.min(45, speed));
}

/**
 * Compute slope-based cumulative travel times for each elevation profile point.
 *
 * For each segment between consecutive profile points:
 *   1. Calculate slope percentage from elevation change / distance
 *   2. Estimate speed via slopeSpeedKmh()
 *   3. Compute raw segment travel time
 *
 * Raw times are then scaled so that total = totalDurationMs (matching GH duration).
 * This preserves per-segment speed variation while keeping total time consistent
 * with GraphHopper's slope-aware routing engine.
 *
 * @param profile Elevation profile points (distance in meters, elevation in meters)
 * @param totalDurationMs GH route duration in milliseconds (slope-aware total)
 * @returns Array of cumulative times in ms for each profile point; first element is 0
 */
export function computeSlopeCumulativeTimes(
  profile: ElevationPoint[],
  totalDurationMs: number,
): number[] {
  if (profile.length < 2 || totalDurationMs <= 0) {
    // Degenerate case: return evenly spaced times
    return profile.map((_, i) => (totalDurationMs * i) / Math.max(1, profile.length - 1));
  }

  // Phase 1: raw times from slope model
  const rawTimes = [0];
  for (let i = 1; i < profile.length; i += 1) {
    const dist = profile[i].distance - profile[i - 1].distance; // meters
    const eleDelta = profile[i].elevation - profile[i - 1].elevation;
    const slopePct = dist > 0 ? (eleDelta / dist) * 100 : 0;
    const speedMs = (slopeSpeedKmh(slopePct) * 1000) / 3600; // km/h → m/s
    const segTimeMs = (dist / speedMs) * 1000; // seconds → ms
    rawTimes.push(rawTimes[i - 1] + segTimeMs);
  }

  // Phase 2: scale to match GH duration
  const rawTotal = rawTimes[rawTimes.length - 1];
  if (rawTotal <= 0) {
    return profile.map((_, i) => (totalDurationMs * i) / (profile.length - 1));
  }
  const scale = totalDurationMs / rawTotal;

  return rawTimes.map((t) => t * scale);
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Ascent guard
// ---------------------------------------------------------------------------

/**
 * Post-hoc ascent guard: given two GHRouteResults, return the one whose
 * RECOMPUTED elevation gain (after smoothing + min-delta threshold) is lower.
 *
 * This is necessary because GraphHopper's raw `ascend` and the app's
 * recomputed `elevationGain` (100 m smoothed + 1.5 m min-delta) can diverge,
 * causing a raw-based guard to pick the wrong route.
 *
 * @returns the GHRouteResult with lower recomputed elevationGain
 */
export function applyAscentGuard(
  elevResult: GHRouteResult,
  baseResult: GHRouteResult,
): GHRouteResult {
  const elevGain = computeElevationGainLoss(
    smoothElevationProfile(computeElevationProfile(elevResult.geometry)),
  ).gain;
  const baseGain = computeElevationGainLoss(
    smoothElevationProfile(computeElevationProfile(baseResult.geometry)),
  ).gain;
  return elevGain <= baseGain ? elevResult : baseResult;
}

// ---------------------------------------------------------------------------
// POI helpers
// ---------------------------------------------------------------------------

const DEFAULT_DEDUP_DISTANCE = 100; // meters

/**
 * Sample route geometry at regular distance intervals.
 *
 * Input is Leaflet [lat, lng] format. Returns sample points in the same format.
 * @param maxSamples Cap on number of sample points (default 8).
 */
export function sampleRouteGeometry(
  geometry: [number, number][],
  interval: number,
  maxSamples = 8,
): [number, number][] {
  if (geometry.length < 2) return [];

  const points: [number, number][] = [geometry[0]];
  let distSinceLast = 0;

  for (let i = 1; i < geometry.length; i += 1) {
    const [prevLat, prevLng] = geometry[i - 1];
    const [curLat, curLng] = geometry[i];
    const segDist = haversineMeters(prevLat, prevLng, curLat, curLng);

    distSinceLast += segDist;

    while (distSinceLast >= interval && points.length < maxSamples) {
      const overshoot = distSinceLast - interval;
      const fraction = 1 - overshoot / segDist;
      const interpLat = prevLat + (curLat - prevLat) * fraction;
      const interpLng = prevLng + (curLng - prevLng) * fraction;
      points.push([interpLat, interpLng]);
      distSinceLast = overshoot;
    }
  }

  return points;
}

/**
 * Deduplicate POIs by proximity — keeps the first occurrence within minDistance.
 */
export function deduplicatePOIs(
  pois: POILocation[],
  minDistance = DEFAULT_DEDUP_DISTANCE,
): POILocation[] {
  const accepted: POILocation[] = [];

  pois.forEach((poi) => {
    const isDuplicate = accepted.some(
      (a) => haversineMeters(a.lat, a.lng, poi.lat, poi.lng) < minDistance,
    );
    if (!isDuplicate) {
      accepted.push(poi);
    }
  });

  return accepted;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lerp(a: number, b: number, t: number): number {
  return Math.max(0.01, a + (b - a) * t);
}
