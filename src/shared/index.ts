export type JsonValue = | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface PhotonFeature {
  properties?: {
    name?: string | null;
    street?: string | null;
    housenumber?: string | null;
    city?: string | null;
    postcode?: string | null;
    country?: string | null;
  };
  geometry?: {
    coordinates?: number[];
  };
}

export interface PhotonResponse {
  features?: PhotonFeature[];
}

export interface Stop {
  lat: number;
  lng: number;
  name: string;
}

export interface GeocodeResult {
  lat: number;
  lng: number;
  name: string;
  displayName: string;
}

export interface ElevationPoint {
  /** Cumulative distance from route start in meters */
  distance: number;
  /** Elevation in meters above sea level */
  elevation: number;
}

export interface SurfaceSegment {
  /** Index of the first coordinate point in the route geometry */
  from: number;
  /** Index of the last coordinate point in the route geometry */
  to: number;
  /** Surface type string from GraphHopper (e.g. "asphalt", "gravel", "unpaved") */
  surface: string;
}

export interface RoadClassSegment {
  /** Index of the first coordinate point in the route geometry */
  from: number;
  /** Index of the last coordinate point in the route geometry */
  to: number;
  /** Road class string from GraphHopper (e.g. "RESIDENTIAL", "SECONDARY", "TERTIARY") */
  roadClass: string;
}

export interface ShadowPoint {
  /** Cumulative distance from route start (meters) */
  distance: number;
  /** True = point is in shadow (blocked by vegetation/building) */
  shadow: boolean;
  /** Direct sunlight exposure: 0 = full shadow, 1 = full direct sun */
  sunExposure: number;
}

export interface POILocation {
  /** Latitude */
  lat: number;
  /** Longitude */
  lng: number;
  /** POI display name from Overpass/Photon */
  name: string;
  /** Amenity category: pub, bar, restaurant, cafe, or biergarten */
  type: string;
}

export interface RouteResponse {
  geometry: [number, number][];
  distance: number;
  duration: number;
  elevationGain: number;
  elevationLoss: number;
  /** Elevation profile sampled from GH coordinates [{distance, elevation}] */
  elevationProfile: ElevationPoint[];
  /** Surface type segments parsed from GraphHopper details */
  surfaceSegments: SurfaceSegment[];
  /** Road class segments parsed from GraphHopper details */
  roadClassSegments: RoadClassSegment[];
  /** Road environment segments parsed from GraphHopper (road, bridge, tunnel, ford) */
  roadEnvSegments: RoadClassSegment[];
  /** Shadow profile computed from DSM ray-tracing (optional, requires elevation service) */
  shadowProfile?: ShadowPoint[];
  /** Slope-scaled cumulative travel times for each elevation profile point (ms).
   *  Total matches GH duration; per-segment varies by slope. */
  slopeBasedTimes?: number[];
  /** POI locations (pubs, bars, restaurants) along the route */
  poiLocations: POILocation[];
  /** All discovered POIs for map display */
  allPOILocations: POILocation[];
}

export interface RouteRequest {
  stops: Stop[];
  elevationCoefficient: number;
  roadAvoidanceCoefficient: number;
  cyclewayCoefficient: number;
  /** Show POIs (pubs, bars, restaurants) along the route on the map */
  showPOI: boolean;
  /** Optional datetime used for terrain-based shadow profile computation */
  shadowDateTime?: string;
  /** Apply community road ratings to routing */
  useRoadRatings?: boolean;
}

export type RoadRatingType = 'prefer' | 'demote';
export type RoadRatingSubtype = 'nice' | 'safe' | 'fast' | 'dangerous' | 'unpassable'
  | 'bad_terrain';
export const ROAD_RATING_PREFER_SUBTYPES = [
  'nice', 'safe', 'fast',
] as const satisfies readonly RoadRatingSubtype[];
export const ROAD_RATING_DEMOTE_SUBTYPES = [
  'dangerous', 'unpassable', 'bad_terrain',
] as const satisfies readonly RoadRatingSubtype[];
export const ROAD_RATING_SUBTYPE_MULTIPLIERS: Record<RoadRatingSubtype, number> = {
  nice: 1.5,
  safe: 1.7,
  fast: 1.4,
  dangerous: 0.2,
  unpassable: 0.05,
  bad_terrain: 0.4,
};

export interface OSMRoadWay {
  osmId: number;
  name: string | null;
  coordinates: [number, number][];
}

/**
 * Valid OSM way ID for GraphHopper routing: positive safe integer fitting
 * GH's 31-bit `osm_way_id` encoded value. The parser throws on overflow at
 * import time; this guard keeps runtime inputs aligned with that limit.
 */
export const OSM_WAY_ID_MAX = 2 ** 31 - 1;

export function isValidOsmWayId(value: number): value is number {
  return Number.isSafeInteger(value) && value > 0 && value <= OSM_WAY_ID_MAX;
}

/** Community penalty bucket: all OSM ways sharing one aggregate multiplier. */
export interface RoadRatingBucket {
  multiplier: number;
  wayIds: number[];
}

/** Conservative cap keeping the generated GH custom-model payload well below its limits. */
export const MAX_ROAD_RATING_MODEL_MEMBER_IDS = 500;

/**
 * A named street may consist of several OSM ways. Join only members that
 * share the exact name and an endpoint, so equal street names in other towns
 * never become one rating target. Unnamed ways deliberately stay independent.
 */
export function connectedRoadWayGroup(
  wayId: number,
  roads: OSMRoadWay[],
): OSMRoadWay[] {
  const selected = roads.find((road) => road.osmId === wayId);
  if (!selected || !selected.name) return selected ? [selected] : [];
  const candidates = roads.filter((road) => road.name === selected.name);
  const byEndpoint = new Map<string, OSMRoadWay[]>();
  candidates.forEach((road) => {
    [road.coordinates[0], road.coordinates.at(-1)!].forEach((endpoint) => {
      const key = endpoint.join(',');
      byEndpoint.set(key, [...(byEndpoint.get(key) ?? []), road]);
    });
  });
  const connected = new Map<number, OSMRoadWay>();
  const pending = [selected];
  while (pending.length > 0) {
    const road = pending.pop()!;
    if (!connected.has(road.osmId)) {
      connected.set(road.osmId, road);
      [road.coordinates[0], road.coordinates.at(-1)!].forEach((endpoint) => {
        (byEndpoint.get(endpoint.join(',')) ?? []).forEach((next) => pending.push(next));
      });
    }
  }
  return [...connected.values()];
}

export interface RoadRatingAggregate {
  wayId: number;
  name: string | null;
  lat: number;
  lng: number;
  multiplier: number | null;
  type: RoadRatingType | null;
  counts: {
    total: number;
    prefer: number;
    demote: number;
    subtypes: Record<RoadRatingSubtype, number>;
  };
  commentsCount: number;
  mine: { type: RoadRatingType; subtypes: RoadRatingSubtype[]; comment: string | null } | null;
}

export interface RoadRatingComment {
  type: RoadRatingType;
  subtypes: RoadRatingSubtype[];
  comment: string;
  updatedAt: string;
}

// --- Geo utilities ---

export const EARTH_RADIUS_M = 6_371_000;

/**
 * Haversine distance between two lat/lon points in meters.
 */
export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Pre-compute cumulative haversine distances for each geometry point. */
export function computeGeometryDistances(geometry: [number, number][]): number[] {
  const distances = [0];
  for (let i = 1; i < geometry.length; i += 1) {
    distances.push(
      distances[i - 1]
        + haversineMeters(geometry[i - 1][0], geometry[i - 1][1], geometry[i][0], geometry[i][1]),
    );
  }
  return distances;
}

/**
 * Interpolate [lat, lng] position at a given cumulative distance along geometry.
 * Requires pre-computed distances from computeGeometryDistances().
 */
export function findPositionAtDistance(
  geometry: [number, number][],
  geometryDistances: number[],
  targetDistance: number,
): [number, number] | null {
  if (geometry.length === 0) return null;
  if (geometry.length === 1) return geometry[0];
  if (targetDistance >= geometryDistances[geometryDistances.length - 1]) {
    return geometry[geometry.length - 1];
  }
  let lo = 0;
  let hi = geometryDistances.length - 1;
  while (lo < hi - 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (geometryDistances[mid] <= targetDistance) lo = mid;
    else hi = mid;
  }
  const segStart = geometryDistances[lo];
  const segEnd = geometryDistances[hi];
  const t = segEnd > segStart ? (targetDistance - segStart) / (segEnd - segStart) : 0;
  return [
    geometry[lo][0] + (geometry[hi][0] - geometry[lo][0]) * t,
    geometry[lo][1] + (geometry[hi][1] - geometry[lo][1]) * t,
  ];
}

/**
 * Compute bearing in degrees (0=north, 90=east) between two [lat, lng] points.
 */
export function computeBearing(from: [number, number], to: [number, number]): number {
  const toRad = Math.PI / 180;
  const toDeg = 180 / Math.PI;
  const lat1 = from[0] * toRad;
  const lat2 = to[0] * toRad;
  const dLng = (to[1] - from[1]) * toRad;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(y, x) * toDeg + 360) % 360;
}

export function parseLocalDateTime(value: string): Date | null {
  if (!value) return null;
  const [datePart, timePart] = value.split('T');
  if (!datePart || !timePart) return null;
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute] = timePart.split(':').map(Number);
  if ([year, month, day, hour, minute].some((n) => Number.isNaN(n))) return null;
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

export function formatLocalDateTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const datePart = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const timePart = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return `${datePart}T${timePart}`;
}

export function formatLocalDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// ── Geocode helpers (shared between FE and BE) ──

/** Map a Photon GeoJSON Feature to a GeocodeResult. GeoJSON [lon,lat] → [lat,lng]. */
export function mapPhotonFeature(feature: PhotonFeature): GeocodeResult {
  const props = feature.properties ?? {};
  const coordinates = feature.geometry?.coordinates ?? [0, 0];
  return {
    lat: coordinates[1] ?? 0,
    lng: coordinates[0] ?? 0,
    name: props.name || props.street || 'Unknown',
    displayName:
      [props.name, props.street, props.housenumber, props.city, props.postcode, props.country]
        .filter((v) => v != null && v !== '')
        .join(', ') || 'Unknown location',
  };
}

// ── GPS coordinate parsing (shared between FE and BE) ──

export interface GpsCoord {
  lat: number;
  lng: number;
}

function normalizeGpsInput(input: string): string {
  return input
    .replace(/%C2%B0/gi, '°')
    .replace(/%2C/gi, ',')
    .replace(/%27/gi, "'")
    .replace(/%22/gi, '"')
    .replace(/%20/gi, ' ')
    .replace(/%09/gi, ' ')
    .replace(/%0A/gi, ' ')
    .replace(/%0D/gi, ' ')
    .replace(/\+/g, ' ')
    .replace(/″/g, '"')
    .replace(/′/g, "'");
}

function parseDmsPart(s: string): number {
  const dmsPattern = String.raw`^\s*(-?\d+(?:\.\d+)?)\s*°\s*(\d+(?:\.\d+)?)\s*'\s*${
    String.raw`(\d+(?:\.\d+)?)\s*(?:["″]|'')\s*([NSEWnsew])\s*$`
  }`;
  let m = s.match(new RegExp(dmsPattern));
  if (m) {
    const r = parseFloat(m[1]) + parseFloat(m[2]) / 60 + parseFloat(m[3]) / 3600;
    return m[4].toUpperCase() === 'S' || m[4].toUpperCase() === 'W' ? -r : r;
  }
  m = s.match(/^\s*(-?\d+(?:\.\d+)?)\s*°\s*(\d+(?:\.\d+)?)\s*['′]\s*([NSEWnsew])\s*$/);
  if (m) {
    const r = parseFloat(m[1]) + parseFloat(m[2]) / 60;
    return m[3].toUpperCase() === 'S' || m[3].toUpperCase() === 'W' ? -r : r;
  }
  return NaN;
}

/** Detect and parse GPS coordinates (DD/DDM/DMS). Returns null if not GPS. */
export function detectAndParseGPS(input: string): GpsCoord | null {
  if (!input || input.trim().length === 0) return null;
  const normalized = normalizeGpsInput(input.trim());
  const parts = normalized.split(/[\s,]+/).filter((p) => p.length > 0);

  if (parts.length >= 2 && parts[0].includes('°')) {
    let part1End = 1;
    for (let i = 1; i < parts.length; i += 1) {
      if (parts[i].includes('°')) {
        part1End = i;
        break;
      }
      part1End = i + 1;
    }
    const part1 = parts.slice(0, part1End).join(' ');
    const part2 = parts.slice(part1End).join(' ');
    if (part1.length > 0 && part2.length > 0) {
      const v1 = parseDmsPart(part1);
      const v2 = parseDmsPart(part2);
      if (!Number.isNaN(v1) && !Number.isNaN(v2)) {
        const dir1 = part1.toUpperCase();
        const isLat1 = dir1.includes('N') || dir1.includes('S');
        const lat = isLat1 ? v1 : v2;
        const lng = isLat1 ? v2 : v1;
        if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
      }
    }
  }

  const ddMatch = normalized.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (ddMatch) {
    const a = parseFloat(ddMatch[1]);
    const b = parseFloat(ddMatch[2]);
    if (Math.abs(a) <= 90 && Math.abs(b) <= 180) return { lat: a, lng: b };
  }

  const ddSuffixMatch = normalized.match(
    /^\s*(-?\d+(?:\.\d+)?)\s*([NSEWnsew])\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*([NSEWnsew])\s*$/,
  );
  if (ddSuffixMatch) {
    let lat = parseFloat(ddSuffixMatch[1]);
    let lng = parseFloat(ddSuffixMatch[3]);
    if (ddSuffixMatch[2].toUpperCase() === 'S') lat = -lat;
    if (ddSuffixMatch[4].toUpperCase() === 'W') lng = -lng;
    if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
  }

  return null;
}
