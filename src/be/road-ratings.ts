import { Database } from 'bun:sqlite';
import {
  and, asc, eq, gte, inArray, lte, sql,
} from 'drizzle-orm';
import type {
  RoadRatingAggregate,
  RoadRatingSubtype,
  RoadRatingType,
  Stop,
  OSMRoadWay,
} from '@vrstevnice/shared';
import {
  connectedRoadWayGroup,
  ROAD_RATING_DEMOTE_SUBTYPES,
  ROAD_RATING_PREFER_SUBTYPES,
} from '@vrstevnice/shared';
import { resolve } from 'node:path';
import {
  aggregateRatings, corridorBounds, medianOf, perUserMultiplier,
} from './road-ratings-core';
import { db, ratedRoads, roadRatings } from './db';

const PROJECT_ROOT = resolve(import.meta.dir, '..', '..');
const ROAD_INDEX_PATH = resolve(PROJECT_ROOT, 'data', 'road-rating-roads.sqlite');
const RATING_SUBTYPES: RoadRatingSubtype[] = [
  ...ROAD_RATING_PREFER_SUBTYPES,
  ...ROAD_RATING_DEMOTE_SUBTYPES,
];
const EMPTY_SUBTYPE_COUNTS = (): Record<RoadRatingSubtype, number> => ({
  nice: 0,
  safe: 0,
  fast: 0,
  dangerous: 0,
  unpassable: 0,
  bad_terrain: 0,
});

let roadIndex: Database | null | undefined;

export class RoadGeometryNotFoundError extends Error {
  constructor(wayId: number) {
    super(`Road geometry not found for way ${wayId}`);
    this.name = 'RoadGeometryNotFoundError';
  }
}

const ROAD_INDEX_UNAVAILABLE = 'RoadRatingRoadIndexUnavailableError';

export function isRoadRatingRoadIndexUnavailable(error: Error): boolean {
  return error.name === ROAD_INDEX_UNAVAILABLE;
}

function roadIndexUnavailableError(): Error {
  const error = new Error('Road rating road index is unavailable');
  error.name = ROAD_INDEX_UNAVAILABLE;
  return error;
}

function getRoadIndex(): Database {
  if (roadIndex) return roadIndex;
  if (roadIndex === null) throw roadIndexUnavailableError();
  try {
    roadIndex = new Database(ROAD_INDEX_PATH, { readonly: true });
  } catch {
    roadIndex = null;
    throw roadIndexUnavailableError();
  }
  return roadIndex;
}

interface RoadIndexRow {
  osm_id: number;
  name: string | null;
  geometry: string;
}

interface RoadGroup {
  wayId: number;
  name: string | null;
  lines: [number, number][][];
}

function roadIndexRow(wayId: number): RoadIndexRow | null {
  const index = getRoadIndex();
  return index.query('SELECT osm_id, name, geometry FROM roads WHERE osm_id = ?').get(wayId) as
    | RoadIndexRow
    | null;
}

function indexLine(geometry: string): [number, number][] {
  return (JSON.parse(geometry) as GeoJSON.LineString).coordinates as [number, number][];
}

function resolveRoadGroup(wayId: number): RoadGroup | null {
  const selected = roadIndexRow(wayId);
  if (!selected) return null;
  const selectedLine = indexLine(selected.geometry);
  if (!selected.name || selectedLine.length < 2) {
    return { wayId, name: selected.name, lines: [selectedLine] };
  }
  const index = getRoadIndex();
  const sameNamed = index.query(
    'SELECT osm_id, name, geometry FROM roads WHERE name = ?',
  ).all(selected.name) as RoadIndexRow[];
  const roads: OSMRoadWay[] = sameNamed.map((road) => ({
    osmId: road.osm_id,
    name: road.name,
    coordinates: indexLine(road.geometry),
  })).filter((road) => road.coordinates.length >= 2);
  const members = connectedRoadWayGroup(wayId, roads);
  if (members.length === 0) return null;
  return {
    wayId: Math.min(...members.map((road) => road.osmId)),
    name: selected.name,
    lines: members.map((road) => road.coordinates),
  };
}

export function getRoadRatingFeaturesInBbox(
  bbox: { minLng: number; minLat: number; maxLng: number; maxLat: number },
): GeoJSON.FeatureCollection<GeoJSON.LineString, { osm_id: number; name: string | null }> {
  const index = getRoadIndex();
  const rows = index.query(`
    SELECT roads.osm_id, roads.name, roads.geometry
    FROM roads_rtree
    JOIN roads ON roads.osm_id = roads_rtree.osm_id
    WHERE roads_rtree.max_lng >= ? AND roads_rtree.min_lng <= ?
      AND roads_rtree.max_lat >= ? AND roads_rtree.min_lat <= ?
  `).all(bbox.minLng, bbox.maxLng, bbox.minLat, bbox.maxLat) as {
    osm_id: number; name: string | null; geometry: string;
  }[];
  return {
    type: 'FeatureCollection',
    features: rows.map((row) => ({
      type: 'Feature',
      id: row.osm_id,
      properties: { osm_id: row.osm_id, name: row.name },
      geometry: JSON.parse(row.geometry) as GeoJSON.LineString,
    })),
  };
}

function parseGeometry(value: string): [number, number][][] {
  const geometry = JSON.parse(value) as {
    type: 'LineString' | 'MultiLineString';
    coordinates: [number, number][] | [number, number][][];
  };
  return geometry.type === 'LineString'
    ? [geometry.coordinates as [number, number][]]
    : geometry.coordinates as [number, number][][];
}

function geometryAnchor(lines: [number, number][][]): [number, number] {
  const segmentDistance = (from: [number, number], to: [number, number]) => {
    const meanLat = ((from[1] + to[1]) / 2) * (Math.PI / 180);
    const lngDistance = (to[0] - from[0]) * 111_320 * Math.cos(meanLat);
    const latDistance = (to[1] - from[1]) * 111_320;
    return Math.hypot(lngDistance, latDistance);
  };
  const longest = lines.reduce((best, line) => {
    const length = line.reduce((sum, point, index) => {
      if (index === 0) return 0;
      const previous = line[index - 1];
      return sum + segmentDistance(previous, point);
    }, 0);
    return length > best.length ? { line, length } : best;
  }, { line: lines[0], length: -1 });
  const segmentLengths = longest.line.map((point, index) => {
    if (index === 0) return 0;
    const previous = longest.line[index - 1];
    return segmentDistance(previous, point);
  });
  const target = longest.length / 2;
  let travelled = 0;
  for (let index = 1; index < longest.line.length; index += 1) {
    const segmentLength = segmentLengths[index];
    if (travelled + segmentLength >= target) {
      const fraction = segmentLength > 0 ? (target - travelled) / segmentLength : 0;
      return [
        longest.line[index - 1][1]
          + (longest.line[index][1] - longest.line[index - 1][1]) * fraction,
        longest.line[index - 1][0]
          + (longest.line[index][0] - longest.line[index - 1][0]) * fraction,
      ];
    }
    travelled += segmentLength;
  }
  const last = longest.line.at(-1)!;
  return [last[1], last[0]];
}

type RatingRow = typeof roadRatings.$inferSelect;

function parseSubtypes(value: string): RoadRatingSubtype[] {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (subtype): subtype is RoadRatingSubtype => RATING_SUBTYPES.includes(subtype),
    );
  } catch {
    return [];
  }
}

function makeAggregate(
  road: typeof ratedRoads.$inferSelect,
  ratings: RatingRow[],
  ip: string,
): RoadRatingAggregate {
  const subtypeCounts = EMPTY_SUBTYPE_COUNTS();
  let prefer = 0;
  let demote = 0;
  ratings.forEach((rating) => {
    if (rating.type === 'prefer') prefer += 1;
    if (rating.type === 'demote') demote += 1;
    parseSubtypes(rating.subtypes).forEach((subtype) => {
      subtypeCounts[subtype] += 1;
    });
  });
  const { multiplier } = aggregateRatings(ratings);
  let type: RoadRatingType | null = null;
  if (multiplier != null && multiplier > 1) type = 'prefer';
  if (multiplier != null && multiplier < 1) type = 'demote';
  const mineRow = ratings.find((rating) => rating.ip === ip);
  return {
    wayId: road.wayId,
    name: road.name,
    lat: road.anchorLat,
    lng: road.anchorLng,
    multiplier,
    type,
    counts: {
      total: ratings.length, prefer, demote, subtypes: subtypeCounts,
    },
    mine: mineRow
      ? {
        type: mineRow.type as RoadRatingType,
        subtypes: parseSubtypes(mineRow.subtypes),
        comment: mineRow.comment,
      }
      : null,
  };
}

async function readAggregateSource(wayId: number): Promise<{
  road: typeof ratedRoads.$inferSelect;
  ratings: RatingRow[];
} | null> {
  const roads = await db.select().from(ratedRoads).where(eq(ratedRoads.wayId, wayId)).limit(1)
    .all();
  const road = roads[0];
  if (!road) return null;
  const ratings = await db.select().from(roadRatings).where(eq(roadRatings.wayId, wayId)).all();
  return { road, ratings };
}

async function getAggregateForWay(wayId: number, ip: string): Promise<RoadRatingAggregate> {
  const group = resolveRoadGroup(wayId);
  if (!group) throw new RoadGeometryNotFoundError(wayId);
  const source = await readAggregateSource(group.wayId);
  if (!source) throw new RoadGeometryNotFoundError(group.wayId);
  return makeAggregate(source.road, source.ratings, ip);
}

export async function getAggregateByWayId(
  wayId: number,
  ip: string,
): Promise<RoadRatingAggregate | null> {
  const group = resolveRoadGroup(wayId);
  if (!group) return null;
  const source = await readAggregateSource(group.wayId);
  if (!source || source.ratings.length === 0) return null;
  return makeAggregate(source.road, source.ratings, ip);
}

export async function saveRating(input: {
  wayId: number;
  name?: string;
  type: RoadRatingType;
  subtypes: RoadRatingSubtype[];
  comment?: string;
  ip: string;
}): Promise<RoadRatingAggregate> {
  const group = resolveRoadGroup(input.wayId);
  if (!group) throw new RoadGeometryNotFoundError(input.wayId);
  const existing = await db.select().from(ratedRoads)
    .where(eq(ratedRoads.wayId, group.wayId)).limit(1)
    .all();
  if (existing.length === 0) {
    const anchor = geometryAnchor(group.lines);
    const geometry = group.lines.length === 1
      ? { type: 'LineString', coordinates: group.lines[0] }
      : { type: 'MultiLineString', coordinates: group.lines };
    await db.insert(ratedRoads).values({
      wayId: group.wayId,
      name: input.name?.trim() || group.name,
      geometry: JSON.stringify(geometry),
      anchorLat: anchor[0],
      anchorLng: anchor[1],
    }).run();
  } else if (input.name?.trim()) {
    await db.update(ratedRoads)
      .set({ name: input.name.trim() })
      .where(eq(ratedRoads.wayId, group.wayId)).run();
  }

  await db.insert(roadRatings).values({
    wayId: group.wayId,
    ip: input.ip,
    type: input.type,
    subtypes: JSON.stringify(input.subtypes),
    multiplier: perUserMultiplier(input.type, input.subtypes),
    comment: input.comment?.trim() || null,
  }).onConflictDoUpdate({
    target: [roadRatings.wayId, roadRatings.ip],
    set: {
      type: input.type,
      subtypes: JSON.stringify(input.subtypes),
      multiplier: perUserMultiplier(input.type, input.subtypes),
      comment: input.comment?.trim() || null,
      updatedAt: sql`(datetime('now'))`,
    },
  }).run();
  return getAggregateForWay(group.wayId, input.ip);
}

export async function deleteRating(wayId: number, ip: string): Promise<RoadRatingAggregate> {
  const group = resolveRoadGroup(wayId);
  if (!group) throw new RoadGeometryNotFoundError(wayId);
  await db.delete(roadRatings)
    .where(and(eq(roadRatings.wayId, group.wayId), eq(roadRatings.ip, ip))).run();
  return getAggregateForWay(group.wayId, ip);
}

export async function getAggregatesInBbox(
  bbox: { minLng: number; minLat: number; maxLng: number; maxLat: number },
  ip: string,
  limit = 200,
): Promise<RoadRatingAggregate[]> {
  const roads = await db.select().from(ratedRoads).where(and(
    gte(ratedRoads.anchorLng, bbox.minLng),
    lte(ratedRoads.anchorLng, bbox.maxLng),
    gte(ratedRoads.anchorLat, bbox.minLat),
    lte(ratedRoads.anchorLat, bbox.maxLat),
  )).orderBy(asc(ratedRoads.wayId))
    .all();
  if (roads.length === 0) return [];
  const ratings = await db.select().from(roadRatings)
    .where(inArray(roadRatings.wayId, roads.map((road) => road.wayId))).all();
  const byWay = new Map<number, RatingRow[]>();
  ratings.forEach((rating) => {
    byWay.set(rating.wayId, [...(byWay.get(rating.wayId) ?? []), rating]);
  });
  return roads
    .map((road) => makeAggregate(road, byWay.get(road.wayId) ?? [], ip))
    .filter((aggregate) => aggregate.counts.total > 0)
    .slice(0, limit);
}

export async function getVotedRoadsInCorridor(
  stops: Stop[],
  limit = 200,
): Promise<{ wayId: number; multiplier: number; geometry: [number, number][][] }[]> {
  const bounds = corridorBounds(stops);
  const roads = await db.select().from(ratedRoads).where(and(
    gte(ratedRoads.anchorLng, bounds.minLng),
    lte(ratedRoads.anchorLng, bounds.maxLng),
    gte(ratedRoads.anchorLat, bounds.minLat),
    lte(ratedRoads.anchorLat, bounds.maxLat),
  )).orderBy(asc(ratedRoads.wayId))
    .all();
  if (roads.length === 0) return [];
  const ratings = await db.select().from(roadRatings)
    .where(inArray(roadRatings.wayId, roads.map((road) => road.wayId))).all();
  const byWay = new Map<number, RatingRow[]>();
  ratings.forEach((rating) => {
    byWay.set(rating.wayId, [...(byWay.get(rating.wayId) ?? []), rating]);
  });
  return roads.map((road) => {
    const wayRatings = byWay.get(road.wayId) ?? [];
    return {
      wayId: road.wayId,
      multiplier: medianOf(wayRatings.map((rating) => rating.multiplier)),
      geometry: parseGeometry(road.geometry),
    };
  }).filter((road) => Number.isFinite(road.multiplier)).slice(0, limit);
}
