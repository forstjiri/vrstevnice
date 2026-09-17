import {
  ROAD_RATING_DEMOTE_SUBTYPES,
  ROAD_RATING_PREFER_SUBTYPES,
  ROAD_RATING_SUBTYPE_MULTIPLIERS,
  isValidOsmWayId,
} from '@vrstevnice/shared';
import type {
  RoadRatingBucket,
  RoadRatingSubtype,
  RoadRatingType,
} from '@vrstevnice/shared';

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

export function bucketizeRoads(
  roads: VotedRoadMembers[],
): RoadRatingBucket[] {
  // Invariant: each OSM way belongs to exactly ONE bucket. Overlapping group
  // membership is a data conflict (broken grouping/migration), not something
  // to resolve by policy — reject it loudly.
  const ownership = new Map<number, { owner: number }>();
  roads.forEach((road) => {
    const rounded = Math.round(road.multiplier * 100) / 100;
    if (!Number.isFinite(road.multiplier)) {
      throw new Error(`Non-finite multiplier for rated road ${road.wayId}`);
    }
    const memberIds = normalizedMemberIds(road.memberIds);
    if (memberIds.length === 0) {
      throw new Error(`Rated road ${road.wayId} has no persisted member way IDs`);
    }
    memberIds.forEach((wayId) => {
      if (!isValidOsmWayId(wayId)) {
        throw new Error(`Invalid OSM way ID ${wayId} in group ${road.wayId}`);
      }
      const previous = ownership.get(wayId);
      if (previous) {
        throw new Error(
          `Membership conflict: OSM way ${wayId} owned by rated roads `
          + `${previous.owner} and ${road.wayId}`,
        );
      }
      ownership.set(wayId, { owner: road.wayId });
    });
  });
  const buckets = new Map<number, number[]>();
  roads.forEach((road) => {
    const multiplier = Math.round(road.multiplier * 100) / 100;
    const wayIds = buckets.get(multiplier) ?? [];
    wayIds.push(...normalizedMemberIds(road.memberIds));
    buckets.set(multiplier, wayIds);
  });
  return [...buckets.entries()].map(([multiplier, wayIds]) => ({
    multiplier,
    wayIds: wayIds.sort((a, b) => a - b),
  }));
}

// ── Membership backfill planning (pure — applied by road-ratings.ts) ──

export interface MemberBackfillRow {
  wayId: number;
  name: string | null;
  geometry: string;
  anchorLat: number;
  anchorLng: number;
}

export interface ResolvedGroupIds {
  wayId: number;
  memberIds: number[];
  name?: string | null;
  geometry?: string;
  anchorLat?: number;
  anchorLng?: number;
}

export interface MemberBackfillPlan {
  /** (Re)write complete membership for these rated roads. */
  memberWrites: { ratedWayId: number; memberIds: number[] }[];
  /**
   * Representative changed: move cached row + votes from `fromWayId` to
   * `toWayId` (target row is created by copying when it does not exist).
   */
  rekeys: { fromWayId: number; toWayId: number }[];
  /** Target row already exists with its own votes — needs manual review. */
  conflicts: { wayId: number; targetWayId: number }[];
  /** Rated road no longer resolvable in the original-way index. */
  unresolved: number[];
  /** Resolved current index data, kept non-enumerable for plan consumers. */
  resolvedGroups?: Map<number, ResolvedGroupIds>;
}

function normalizedMemberIds(memberIds: number[]): number[] {
  return [...new Set(memberIds)].sort((a, b) => a - b);
}

export function planMemberBackfill(
  rows: MemberBackfillRow[],
  existingMembers: Map<number, number[]>,
  resolveGroup: (wayId: number) => ResolvedGroupIds | null,
): MemberBackfillPlan {
  const plan: MemberBackfillPlan = {
    memberWrites: [],
    rekeys: [],
    conflicts: [],
    unresolved: [],
  };
  const rowIds = new Set(rows.map((row) => row.wayId));
  const canonical = new Map<number, ResolvedGroupIds>();
  rows.forEach((row) => {
    const group = resolveGroup(row.wayId);
    if (!group) {
      plan.unresolved.push(row.wayId);
      return;
    }
    // Invalid member IDs would poison routing rules — abort this group loudly.
    const memberIds = normalizedMemberIds(group.memberIds);
    if (!isValidOsmWayId(group.wayId) || memberIds.length === 0 || !memberIds.every(isValidOsmWayId)) {
      plan.unresolved.push(row.wayId);
      return;
    }
    canonical.set(row.wayId, { ...group, memberIds });
  });
  // Reject ambiguous convergence BEFORE planning writes: several rows
  // resolving to the same new representative cannot be auto-merged.
  const targetCounts = new Map<number, number>();
  canonical.forEach((group, rowWayId) => {
    if (group.wayId !== rowWayId) {
      targetCounts.set(group.wayId, (targetCounts.get(group.wayId) ?? 0) + 1);
    }
  });

  rows.forEach((row) => {
    const group = canonical.get(row.wayId);
    if (!group) return;
    // Representative changed and the target row does not exist yet → rekey,
    // unless another row converges on the same target (ambiguous split/merge).
    if (group.wayId !== row.wayId && !rowIds.has(group.wayId)) {
      if ((targetCounts.get(group.wayId) ?? 0) > 1) {
        plan.conflicts.push({ wayId: row.wayId, targetWayId: group.wayId });
        return;
      }
      plan.rekeys.push({ fromWayId: row.wayId, toWayId: group.wayId });
      plan.memberWrites.push({ ratedWayId: group.wayId, memberIds: group.memberIds });
      return;
    }
    // Representative changed and target exists with its own row → conflict.
    if (group.wayId !== row.wayId) {
      plan.conflicts.push({ wayId: row.wayId, targetWayId: group.wayId });
      return;
    }
    // Same representative: refresh membership when missing or stale.
    const current = existingMembers.get(row.wayId);
    const same = current !== undefined
      && current.length === group.memberIds.length
      && normalizedMemberIds(current).every((id, index) => id === group.memberIds[index]);
    if (!same) {
      plan.memberWrites.push({ ratedWayId: row.wayId, memberIds: group.memberIds });
    }
  });
  Object.defineProperty(plan, 'resolvedGroups', { value: canonical, enumerable: false });
  return plan;
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

export interface VotedRoadMembers {
  wayId: number;
  multiplier: number;
  memberIds: number[];
}

/** Community penalty bucket: all OSM ways sharing one aggregate multiplier.
 *  Canonical definition lives in @vrstevnice/shared; this re-export keeps
 *  backend-internal call sites on the shared type. */
export type { RoadRatingBucket };

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
