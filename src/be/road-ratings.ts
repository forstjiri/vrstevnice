import { Database } from 'bun:sqlite';
import {
  and, asc, eq, gte, inArray, lte, sql,
} from 'drizzle-orm';

import type {
  RoadRatingAggregate,
  RoadRatingComment,
  RoadRatingSubtype,
  RoadRatingType,
  Stop,
  OSMRoadWay,
} from '@vrstevnice/shared';
import {
  connectedRoadWayGroup,
  ROAD_RATING_DEMOTE_SUBTYPES,
  ROAD_RATING_PREFER_SUBTYPES,
  isValidOsmWayId,
  MAX_ROAD_RATING_MODEL_MEMBER_IDS,
} from '@vrstevnice/shared';
import { resolve } from 'node:path';
import {
  aggregateRatings,
  corridorBounds,
  medianOf,
  perUserMultiplier,
  planMemberBackfill,
} from './road-ratings-core';
import type {
  MemberBackfillPlan,
  MemberBackfillRow,
  ResolvedGroupIds,
} from './road-ratings-core';
import {
  RatedRoadMembershipError, RoadGeometryNotFoundError, RoadRatingIntegrityError,
} from './road-rating-errors';
import {
  db, ratedRoadMembers, ratedRoads, rawSqlite, roadRatings,
} from './db';

export { RatedRoadMembershipError, RoadGeometryNotFoundError, RoadRatingIntegrityError };

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
  memberIds: number[];
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
  if (selectedLine.length < 2) return null;
  if (!selected.name) {
    return {
      wayId,
      name: selected.name,
      lines: [selectedLine],
      memberIds: [wayId],
    };
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
    memberIds: [...new Set(members.map((road) => road.osmId))].sort((a, b) => a - b),
  };
}

function resolvedRoadCache(group: RoadGroup): {
  name: string | null;
  geometry: string;
  anchorLat: number;
  anchorLng: number;
} {
  const anchor = geometryAnchor(group.lines);
  return {
    name: group.name,
    geometry: JSON.stringify(group.lines.length === 1
      ? { type: 'LineString', coordinates: group.lines[0] }
      : { type: 'MultiLineString', coordinates: group.lines }),
    anchorLat: anchor[0],
    anchorLng: anchor[1],
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
    commentsCount: ratings.filter((rating) => Boolean(rating.comment?.trim())).length,
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

export async function getCommentsByWayId(
  wayId: number,
  offset: number,
  limit = 5,
): Promise<{ comments: RoadRatingComment[]; hasMore: boolean }> {
  const group = resolveRoadGroup(wayId);
  if (!group) return { comments: [], hasMore: false };
  const rows = await db.select().from(roadRatings)
    .where(and(
      eq(roadRatings.wayId, group.wayId),
      sql`comment IS NOT NULL AND trim(comment) <> ''`,
    ))
    .orderBy(sql`updated_at DESC`)
    .limit(limit + 1)
    .offset(offset)
    .all();
  return {
    comments: rows.slice(0, limit).map((row) => ({
      type: row.type as RoadRatingType,
      subtypes: parseSubtypes(row.subtypes),
      comment: row.comment!,
      updatedAt: row.updatedAt,
    })),
    hasMore: rows.length > limit,
  };
}

/**
 * Applies a membership backfill plan against the given SQLite handle in ONE
 * transaction: rekeys move the cached row and UPDATE votes to the new parent
 * (preserving rows, IPs, comments, timestamps), then membership is rewritten.
 * Any throw rolls everything back. Split from `backfillRatedRoadMembers` so
 * the real SQL implementation is testable against an isolated database.
 */
export function applyMemberBackfill(
  sqlite: Database,
  plan: MemberBackfillPlan,
  rows: MemberBackfillRow[],
  failDuringApply?: () => never,
): void {
  sqlite.transaction(() => {
    const byId = new Map(rows.map((row) => [row.wayId, row]));
    plan.rekeys.forEach(({ fromWayId, toWayId }) => {
      const source = byId.get(fromWayId);
      if (!source) throw new Error(`Rekey source row missing: ${fromWayId}`);
      const resolved = plan.resolvedGroups?.get(fromWayId);
      if (
        !resolved?.geometry
        || !Number.isFinite(resolved.anchorLat)
        || !Number.isFinite(resolved.anchorLng)
      ) {
        throw new RoadRatingIntegrityError([{
          code: 'invalid_group',
          wayId: fromWayId,
          action: 'Resolve the road group from the road index before rekeying it.',
        }]);
      }
      const anchorLat = resolved.anchorLat as number;
      const anchorLng = resolved.anchorLng as number;
      sqlite.query(`
        INSERT INTO rated_roads (way_id, name, geometry, anchor_lat, anchor_lng)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        toWayId,
        resolved.name ?? source.name,
        resolved.geometry,
        anchorLat,
        anchorLng,
      );
      // MOVE votes by updating their parent identity — vote rows, IPs,
      // comments and timestamps are preserved; nothing is duplicated and
      // nothing is left orphaned behind the deleted source row.
      sqlite.query('UPDATE road_ratings SET way_id = ? WHERE way_id = ?')
        .run(toWayId, fromWayId);
      sqlite.query('DELETE FROM rated_road_members WHERE rated_way_id = ?').run(fromWayId);
      sqlite.query('DELETE FROM rated_roads WHERE way_id = ?').run(fromWayId);
    });
    plan.memberWrites.forEach(({ ratedWayId, memberIds }) => {
      sqlite.query('DELETE FROM rated_road_members WHERE rated_way_id = ?').run(ratedWayId);
      [...new Set(memberIds)].sort((a, b) => a - b).forEach((osmWayId) => {
        if (!isValidOsmWayId(osmWayId)) {
          throw new Error(`Invalid OSM way ID for rated road ${ratedWayId}: ${osmWayId}`);
        }
        sqlite.query(
          'INSERT INTO rated_road_members (rated_way_id, osm_way_id) VALUES (?, ?)',
        ).run(ratedWayId, osmWayId);
      });
    });
    // A same-representative resolution can change the cached geometry and
    // anchor even when membership itself is unchanged.
    plan.resolvedGroups?.forEach((resolved, sourceWayId) => {
      if (resolved.wayId !== sourceWayId) return;
      if (
        !resolved.geometry
        || !Number.isFinite(resolved.anchorLat)
        || !Number.isFinite(resolved.anchorLng)
      ) {
        throw new RoadRatingIntegrityError([{
          code: 'invalid_group',
          wayId: sourceWayId,
          action: 'Resolve geometry and anchors from the road index before backfilling.',
        }]);
      }
      sqlite.query(`
        UPDATE rated_roads
        SET name = ?, geometry = ?, anchor_lat = ?, anchor_lng = ?
        WHERE way_id = ?
      `).run(
        resolved.name ?? null,
        resolved.geometry,
        resolved.anchorLat as number,
        resolved.anchorLng as number,
        sourceWayId,
      );
    });
    if (failDuringApply) failDuringApply();
  })();
}

/**
 * Plans and applies membership backfill in one transaction:
 * - writes complete membership for new/stale groups,
 * - rekeys groups whose representative way changed — votes MOVE via UPDATE
 *   (never copied), cached row is recreated, old row deleted,
 * - reports unresolvable roads and true conflicts instead of hiding them.
 * Any failure rolls the whole migration back.
 */
export function backfillRatedRoadMembersFor(
  sqlite: Database,
  resolveGroupForWay: (wayId: number) => ResolvedGroupIds | null,
): {
  memberWrites: number;
  rekeys: number;
  conflicts: { wayId: number; targetWayId: number }[];
  unresolved: number[];
} {
  return sqlite.transaction(() => {
    const rows = sqlite.query(`
      SELECT way_id wayId, name, geometry,
             anchor_lat anchorLat, anchor_lng anchorLng
      FROM rated_roads
    `).all() as MemberBackfillRow[];
    const existingMembers = new Map<number, number[]>();
    (sqlite.query(
      'SELECT rated_way_id ratedWayId, osm_way_id osmWayId FROM rated_road_members',
    ).all() as {
      ratedWayId: number; osmWayId: number;
    }[]).forEach((member) => existingMembers.set(member.ratedWayId, [
      ...(existingMembers.get(member.ratedWayId) ?? []), member.osmWayId,
    ]));
    const invalid = new Set<number>();
    const plan = planMemberBackfill(rows, existingMembers, (wayId) => {
      const group = resolveGroupForWay(wayId);
      if (!group) return null;
      if (
        !isValidOsmWayId(group.wayId)
        || group.memberIds.length === 0
        || !group.memberIds.every(isValidOsmWayId)
      ) {
        invalid.add(wayId);
        return null;
      }
      return group;
    });
    const diagnostics: RoadRatingIntegrityError['diagnostics'] = [
      ...plan.unresolved.map((wayId) => ({
        code: invalid.has(wayId) ? 'invalid_group' as const : 'unresolved_group' as const,
        wayId,
        action: invalid.has(wayId)
          ? 'Repair invalid OSM member IDs in the road index.'
          : 'Restore this rated road in the road-rating index or remove its rating.',
      })),
      ...plan.conflicts.map(({ wayId, targetWayId }) => ({
        code: 'rekey_conflict' as const,
        wayId,
        targetWayId,
        action: 'Manually merge or remove one of the conflicting rated-road groups.',
      })),
    ];
    const ownership = new Map<number, number>();
    const plannedMembers = new Map(existingMembers);
    plan.memberWrites.forEach(({ ratedWayId, memberIds }) => {
      plannedMembers.set(ratedWayId, memberIds);
    });
    plan.rekeys.forEach(({ fromWayId, toWayId }) => {
      const resolvedMembers = plan.resolvedGroups?.get(fromWayId)?.memberIds;
      if (!resolvedMembers) {
        diagnostics.push({
          code: 'invalid_group',
          wayId: fromWayId,
          action: 'Resolve target membership before rekeying this rated-road group.',
        });
      } else {
        plannedMembers.set(toWayId, resolvedMembers);
        plannedMembers.delete(fromWayId);
      }
    });
    plannedMembers.forEach((memberIds, ratedWayId) => {
      [...new Set(memberIds)].forEach((osmWayId) => {
        const ownerWayId = ownership.get(osmWayId);
        if (ownerWayId !== undefined && ownerWayId !== ratedWayId) {
          diagnostics.push({
            code: 'membership_conflict',
            osmWayId,
            ownerWayId,
            wayId: ratedWayId,
            action: 'Assign each OSM way to exactly one rated-road group.',
          });
        }
        ownership.set(osmWayId, ratedWayId);
      });
    });
    // All resolution and ownership preflight completes before any mutation.
    if (diagnostics.length > 0) throw new RoadRatingIntegrityError(diagnostics);
    // Apply even when memberships are current: resolved geometry/anchors must
    // be refreshed for same-representative groups.
    applyMemberBackfill(sqlite, plan, rows);
    return {
      memberWrites: plan.memberWrites.length,
      rekeys: plan.rekeys.length,
      conflicts: [],
      unresolved: [],
    };
  })();
}

export function backfillRatedRoadMembers(): {
  memberWrites: number;
  rekeys: number;
  conflicts: { wayId: number; targetWayId: number }[];
  unresolved: number[];
} {
  return backfillRatedRoadMembersFor(rawSqlite, (wayId) => {
    const group = resolveRoadGroup(wayId);
    return group
      ? { wayId: group.wayId, memberIds: group.memberIds, ...resolvedRoadCache(group) }
      : null;
  });
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
  const anchor = geometryAnchor(group.lines);
  const geometry: {
    type: 'LineString' | 'MultiLineString';
    coordinates: [number, number][] | [number, number][][];
  } = group.lines.length === 1
    ? { type: 'LineString', coordinates: group.lines[0] }
    : { type: 'MultiLineString', coordinates: group.lines };
  applySaveRating(rawSqlite, group, input, geometry, anchor);
  return getAggregateForWay(group.wayId, input.ip);
}

/**
 * Writes rated-road cache + complete membership + the vote itself in ONE
 * transaction. Split from `saveRating` so the real SQL implementation is
 * testable against an isolated database.
 */
export function applySaveRating(
  sqlite: Database,
  group: { wayId: number; memberIds: number[]; name: string | null },
  input: {
    name?: string;
    type: RoadRatingType;
    subtypes: RoadRatingSubtype[];
    comment?: string;
    ip: string;
  },
  geometry: {
    type: 'LineString' | 'MultiLineString';
    coordinates: [number, number][] | [number, number][][];
  },
  anchor: [number, number],
  failDuringApply?: () => never,
): void {
  const comment = input.comment?.trim() || null;
  const multiplier = perUserMultiplier(input.type, input.subtypes);
  sqlite.transaction(() => {
    const memberIds = [...new Set(group.memberIds)].sort((a, b) => a - b);
    if (
      !isValidOsmWayId(group.wayId)
      || memberIds.length === 0
      || !memberIds.every(isValidOsmWayId)
    ) {
      throw new RoadRatingIntegrityError([{
        code: 'invalid_group',
        wayId: group.wayId,
        action: 'Resolve a complete valid group from the road index before saving.',
      }]);
    }
    const ownershipConflicts = sqlite.query(`
      SELECT rated_way_id AS ratedWayId, osm_way_id AS osmWayId FROM rated_road_members
      WHERE osm_way_id IN (${memberIds.map(() => '?').join(',')}) AND rated_way_id <> ?
    `).all(...memberIds, group.wayId) as { ratedWayId: number; osmWayId: number }[];
    if (ownershipConflicts.length > 0) {
      throw new RoadRatingIntegrityError(ownershipConflicts.map((conflict) => ({
        code: 'membership_conflict',
        wayId: group.wayId,
        ownerWayId: conflict.ratedWayId,
        osmWayId: conflict.osmWayId,
        action: 'Remove or merge the existing rated-road group first.',
      })));
    }
    sqlite.query(`
      INSERT INTO rated_roads (way_id, name, geometry, anchor_lat, anchor_lng)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(way_id) DO UPDATE SET
        name = COALESCE(NULLIF(excluded.name, ''), name),
        geometry = excluded.geometry,
        anchor_lat = excluded.anchor_lat,
        anchor_lng = excluded.anchor_lng
    `).run(
      group.wayId,
      input.name?.trim() || group.name,
      JSON.stringify(geometry),
      anchor[0],
      anchor[1],
    );

    sqlite.query('DELETE FROM rated_road_members WHERE rated_way_id = ?').run(group.wayId);
    memberIds.forEach((osmWayId) => {
      if (!isValidOsmWayId(osmWayId)) {
        throw new Error(`Invalid OSM way ID for rated road ${group.wayId}: ${osmWayId}`);
      }
      sqlite.query(`
        INSERT INTO rated_road_members (rated_way_id, osm_way_id) VALUES (?, ?)
      `).run(group.wayId, osmWayId);
    });

    sqlite.query(`
      INSERT INTO road_ratings (way_id, ip, type, subtypes, multiplier, comment, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(way_id, ip) DO UPDATE SET
        type = excluded.type,
        subtypes = excluded.subtypes,
        multiplier = excluded.multiplier,
        comment = excluded.comment,
        updated_at = excluded.updated_at
    `).run(group.wayId, input.ip, input.type, JSON.stringify(input.subtypes), multiplier, comment);

    if (failDuringApply) failDuringApply();
  })();
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
): Promise<{ wayId: number; multiplier: number; memberIds: number[] }[]> {
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
  const votedWayIds = roads.filter((road) => (byWay.get(road.wayId)?.length ?? 0) > 0)
    .map((road) => road.wayId);
  if (votedWayIds.length === 0) return [];
  const members = await db.select().from(ratedRoadMembers)
    .where(inArray(ratedRoadMembers.ratedWayId, votedWayIds)).all();
  const membersByWay = new Map<number, number[]>();
  members.forEach((member) => {
    membersByWay.set(
      member.ratedWayId,
      [...(membersByWay.get(member.ratedWayId) ?? []), member.osmWayId],
    );
  });
  const votedRoads = roads.filter((road) => (byWay.get(road.wayId)?.length ?? 0) > 0);
  if (votedRoads.length > limit) {
    throw new RoadRatingIntegrityError([{
      code: 'model_limit',
      action: `Reduce corridor ratings below the ${limit}-group custom-model limit.`,
    }]);
  }
  const result = votedRoads.flatMap((road) => {
    const wayRatings = byWay.get(road.wayId) ?? [];
    if (wayRatings.length === 0) return [];
    const memberIds = membersByWay.get(road.wayId);
    // A voted group without persisted membership is a data error — routing
    // cannot target it exactly, so fail loudly instead of approximating.
    if (!memberIds || memberIds.length === 0) {
      throw new RatedRoadMembershipError(road.wayId);
    }
    const multipliers = wayRatings.map((rating) => rating.multiplier);
    const invalidMultiplier = (multiplier: number) => !Number.isFinite(multiplier)
      || multiplier < 0.05
      || multiplier > 1.7;
    if (multipliers.some(invalidMultiplier)) {
      throw new RoadRatingIntegrityError([{
        code: 'invalid_multiplier',
        wayId: road.wayId,
        action: 'Repair persisted rating multipliers to the supported 0.05–1.7 range.',
      }]);
    }
    return [{
      wayId: road.wayId,
      multiplier: medianOf(multipliers),
      memberIds,
    }];
  });
  const memberCount = result.reduce((total, road) => total + road.memberIds.length, 0);
  if (memberCount > MAX_ROAD_RATING_MODEL_MEMBER_IDS) {
    throw new RoadRatingIntegrityError([{
      code: 'model_limit',
      action: [
        'Reduce corridor rating membership below the',
        `${MAX_ROAD_RATING_MODEL_MEMBER_IDS}-way custom-model limit.`,
      ].join(' '),
    }]);
  }
  return result;
}
