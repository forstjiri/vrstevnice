/* eslint-disable import-x/no-relative-packages */
import { describe, expect, it } from 'vitest';
import { buildCustomModel } from '../src/routing';
import { BIKE_TYPES, connectedRoadWayGroup } from '../src/shared';
import type { BikeType } from '../src/shared';
// The pure backend unit is intentionally imported directly to avoid starting Elysia.
import {
  aggregateRatings,
  bikeAwareMultiplier,
  bucketizeRoads,
  corridorBounds,
  createRatingThrottle,
  medianOf,
  perUserMultiplier,
  planMemberBackfill,
  validateSubtypes,
  validateMinimumBike,
  summarizeBikeRecommendations,
} from '../src/be/road-ratings-core';

describe('road ratings core', () => {
  it('groups only contiguous ways with the same street name', () => {
    const group = connectedRoadWayGroup(10, [
      { osmId: 10, name: 'Novoveská', coordinates: [[14, 50], [14.001, 50]] },
      { osmId: 11, name: 'Novoveská', coordinates: [[14.001, 50], [14.002, 50]] },
      { osmId: 12, name: 'Novoveská', coordinates: [[15, 50], [15.001, 50]] },
      { osmId: 13, name: null, coordinates: [[14.002, 50], [14.003, 50]] },
    ]);
    expect(group.map((road) => road.osmId)).toEqual([10, 11]);
  });

  it('calculates odd, even, and single medians', () => {
    expect(medianOf([3, 1, 2])).toBe(2);
    expect(medianOf([1, 4, 2, 3])).toBe(2.5);
    expect(medianOf([7])).toBe(7);
    expect(Number.isNaN(medianOf([]))).toBe(true);
  });

  it('calculates per-user subtype medians', () => {
    expect(perUserMultiplier('prefer', ['nice'])).toBe(1.5);
    expect(perUserMultiplier('demote', ['dangerous', 'unpassable', 'bad_terrain'])).toBe(0.2);
  });

  it('aggregates user medians', () => {
    const votes = [{ multiplier: 1.5 }, { multiplier: 0.2 }, { multiplier: 1.7 }];
    expect(aggregateRatings(votes)).toEqual({ multiplier: 1.5 });
    expect(aggregateRatings([])).toEqual({ multiplier: null });
  });

  it('validates subtype direction, non-empty input, and duplicates', () => {
    expect(validateSubtypes('prefer', ['nice', 'fast'])).toBe(true);
    expect(validateSubtypes('prefer', ['dangerous'])).toBe(false);
    expect(validateSubtypes('demote', [])).toBe(false);
    expect(validateSubtypes('demote', ['bad_terrain', 'bad_terrain'])).toBe(false);
  });

  const bikeVotes = (count: number, minimumBike: BikeType | null = 'mtb') => (
    Array.from({ length: count }, () => ({ type: 'prefer', minimumBike, multiplier: 1.5 }))
  );

  it('requires a valid minimum bike for endorsements only', () => {
    BIKE_TYPES.forEach((bike) => expect(validateMinimumBike('prefer', bike)).toBe(true));
    expect(validateMinimumBike('prefer', undefined)).toBe(false);
    expect(validateMinimumBike('prefer', 'scooter')).toBe(false);
    expect(validateMinimumBike('demote', 'mtb')).toBe(false);
    expect(validateMinimumBike('demote', undefined)).toBe(true);
  });

  it('counts all explicit recommendations but hides the minimum below five votes', () => {
    expect(summarizeBikeRecommendations(bikeVotes(1))).toEqual({
      total: 1,
      minimum: null,
      counts: {
        road: 0, gravel: 0, mtb: 1, freeride: 0,
      },
    });
    expect(summarizeBikeRecommendations([
      ...bikeVotes(1, 'road'), ...bikeVotes(1, 'gravel'),
      ...bikeVotes(4, null), { type: 'demote', minimumBike: 'freeride' },
    ])).toEqual({
      total: 2,
      minimum: null,
      counts: {
        road: 1, gravel: 1, mtb: 0, freeride: 0,
      },
    });
    expect(summarizeBikeRecommendations([]).minimum).toBeNull();
  });

  it('shows the highest two-thirds-supported minimum and rejects polarized votes', () => {
    const agreed = [...bikeVotes(1, 'gravel'), ...bikeVotes(5, 'mtb'), ...bikeVotes(4, 'freeride')];
    expect(summarizeBikeRecommendations(agreed).minimum).toBe('mtb');
    expect(bikeAwareMultiplier(agreed, 'gravel')).toBeCloseTo(0.26);
    expect(bikeAwareMultiplier(agreed, 'mtb')).toBe(1.5);
    const polarized = [
      ...bikeVotes(10, 'road'), ...bikeVotes(1, 'gravel'),
      ...bikeVotes(2, 'mtb'), ...bikeVotes(7, 'freeride'),
    ];
    expect(summarizeBikeRecommendations(polarized).minimum).toBeNull();
    BIKE_TYPES.forEach((bike) => expect(bikeAwareMultiplier(polarized, bike)).toBe(1.5));
  });

  it('accepts exactly two thirds and requires explicit consensus for road bikes', () => {
    const exact = [...bikeVotes(4, 'mtb'), ...bikeVotes(2, 'road')];
    expect(summarizeBikeRecommendations(exact).minimum).toBe('mtb');
    expect(bikeAwareMultiplier(exact, 'gravel')).toBe(0.8);
    expect(summarizeBikeRecommendations([
      ...bikeVotes(3, 'mtb'), ...bikeVotes(2, 'road'),
    ]).minimum).toBeNull();
    expect(summarizeBikeRecommendations([
      ...bikeVotes(4, 'road'), ...bikeVotes(2, 'freeride'),
    ]).minimum).toBe('road');
    expect(summarizeBikeRecommendations([
      ...bikeVotes(3, 'road'), ...bikeVotes(3, 'freeride'),
    ]).minimum).toBeNull();
    expect(summarizeBikeRecommendations([
      ...bikeVotes(51, 'freeride'), ...bikeVotes(49, 'road'),
    ]).minimum).toBeNull();
  });

  it('starts bike-specific avoidance at five and strong avoidance at ten recommendations', () => {
    expect(bikeAwareMultiplier(bikeVotes(4), 'road')).toBe(1.5);
    expect(bikeAwareMultiplier(bikeVotes(5), 'road')).toBe(0.8);
    expect(bikeAwareMultiplier(bikeVotes(9), 'gravel')).toBe(0.8);
    expect(bikeAwareMultiplier(bikeVotes(10), 'gravel')).toBe(0.2);
    expect(bikeAwareMultiplier(bikeVotes(10), 'mtb')).toBe(1.5);
    expect(bikeAwareMultiplier(bikeVotes(10), 'freeride')).toBe(1.5);
  });

  it('requires two-thirds consensus and scales strong avoidance with its agreement', () => {
    const split = [...bikeVotes(5, 'road'), ...bikeVotes(5, 'mtb')];
    expect(bikeAwareMultiplier(split, 'road')).toBeGreaterThanOrEqual(1);
    const majority = [...bikeVotes(4, 'road'), ...bikeVotes(6, 'mtb')];
    expect(bikeAwareMultiplier(majority, 'road')).toBe(1.5);
    const consensus = [...bikeVotes(3, 'road'), ...bikeVotes(7, 'mtb')];
    expect(bikeAwareMultiplier(consensus, 'road')).toBeCloseTo(0.38);
    expect(bikeAwareMultiplier(consensus, 'road')).toBeGreaterThan(
      bikeAwareMultiplier(bikeVotes(10), 'road'),
    );
  });

  it('preserves legacy and negative votes without manufacturing bike evidence', () => {
    expect(bikeAwareMultiplier(bikeVotes(10, null), 'road')).toBe(1.5);
    const negatives = Array.from({ length: 11 }, () => ({
      type: 'demote', minimumBike: null, multiplier: 0.05,
    }));
    BIKE_TYPES.forEach((bike) => {
      expect(bikeAwareMultiplier([...bikeVotes(10), ...negatives], bike)).toBe(0.05);
    });
    expect(bikeAwareMultiplier([...bikeVotes(4), ...bikeVotes(20, null)], 'road')).toBe(1.5);
  });

  it('buckets disjoint roads by multiplier and rejects every cross-group overlap', () => {
    expect(bucketizeRoads([
      { wayId: 1, multiplier: 1.234, memberIds: [1, 2] },
      { wayId: 3, multiplier: 0.2, memberIds: [3] },
    ])).toEqual([
      { multiplier: 1.23, wayIds: [1, 2] },
      { multiplier: 0.2, wayIds: [3] },
    ]);
    // Ownership is exclusive even when both groups round to the same model
    // multiplier; never silently merge two persisted groups.
    expect(() => bucketizeRoads([
      { wayId: 1, multiplier: 1.234, memberIds: [1, 2] },
      { wayId: 2, multiplier: 1.234, memberIds: [2] },
    ])).toThrow(/Membership conflict/);
    expect(() => bucketizeRoads([
      { wayId: 1, multiplier: Number.NaN, memberIds: [1] },
    ])).toThrow(/Non-finite multiplier/);
    expect(() => bucketizeRoads([
      { wayId: 1, multiplier: 1, memberIds: [-5] },
    ])).toThrow(/Invalid OSM way ID/);
  });

  it('plans membership backfill: writes, rekeys, conflicts, unresolved', () => {
    const rows = [
      {
        wayId: 10, name: 'A', geometry: '{}', anchorLat: 1, anchorLng: 2,
      },
      {
        wayId: 20, name: 'B', geometry: '{}', anchorLat: 1, anchorLng: 2,
      },
      {
        wayId: 30, name: null, geometry: '{}', anchorLat: 1, anchorLng: 2,
      },
      {
        wayId: 40, name: null, geometry: '{}', anchorLat: 1, anchorLng: 2,
      },
    ];
    const groups = new Map<number, { wayId: number; memberIds: number[] } | null>([
      // Stale membership → refresh
      [10, { wayId: 10, memberIds: [10, 11] }],
      // Representative changed to an ID without its own row → rekey
      [20, { wayId: 21, memberIds: [20, 21] }],
      // Representative changed to an ID that already exists → conflict
      [30, { wayId: 40, memberIds: [30, 40] }],
      // Missing from index → unresolved
      [40, null],
    ]);
    const plan = planMemberBackfill(
      rows,
      new Map([[10, [10]]]),
      (wayId) => groups.get(wayId) ?? null,
    );
    expect(plan.memberWrites).toEqual([
      { ratedWayId: 10, memberIds: [10, 11] },
      { ratedWayId: 21, memberIds: [20, 21] },
    ]);
    expect(plan.rekeys).toEqual([{ fromWayId: 20, toWayId: 21 }]);
    expect(plan.conflicts).toEqual([{ wayId: 30, targetWayId: 40 }]);
    expect(plan.unresolved).toEqual([40]);
  });

  it('flags converging rekeys as conflicts before any write', () => {
    const rows = [
      {
        wayId: 50, name: null, geometry: '{}', anchorLat: 1, anchorLng: 2,
      },
      {
        wayId: 60, name: null, geometry: '{}', anchorLat: 1, anchorLng: 2,
      },
    ];
    const plan = planMemberBackfill(
      rows,
      new Map(),
      (wayId) => ({ wayId: 99, memberIds: [wayId, 99] }),
    );
    // Both rows re-resolve to the same new representative — an ambiguous
    // merge that must NOT be planned as two rekeys onto one target.
    expect(plan.rekeys).toEqual([]);
    expect(plan.conflicts).toEqual([
      { wayId: 50, targetWayId: 99 },
      { wayId: 60, targetWayId: 99 },
    ]);
  });

  it('rejects invalid member IDs during planning', () => {
    const plan = planMemberBackfill(
      [{
        wayId: 5, name: null, geometry: '{}', anchorLat: 1, anchorLng: 2,
      }],
      new Map(),
      () => ({ wayId: 5, memberIds: [5, -1] }),
    );
    expect(plan.unresolved).toEqual([5]);
  });

  it('plans no-op when membership is complete and current', () => {
    const plan = planMemberBackfill(
      [{
        wayId: 5, name: null, geometry: '{}', anchorLat: 1, anchorLng: 2,
      }],
      new Map([[5, [5, 6]]]),
      () => ({ wayId: 5, memberIds: [5, 6] }),
    );
    expect(plan).toEqual({
      memberWrites: [], rekeys: [], conflicts: [], unresolved: [],
    });
  });

  it('emits exact osm_way_id rules; malformed bucket input is a hard error', () => {
    const model = buildCustomModel(0, 0, 0, [
      { multiplier: 0.2, wayIds: [495432578, 70857079] },
      { multiplier: 1.5, wayIds: [42] },
    ]);
    const ratingRules = model.priority.filter((rule) => (rule.if ?? '').includes('osm_way_id'));
    expect(ratingRules).toEqual([
      { if: 'osm_way_id == 495432578 || osm_way_id == 70857079', multiply_by: '0.2' },
      { if: 'osm_way_id == 42', multiply_by: '1.5' },
    ]);
    expect('areas' in model).toBe(false);
    // Invalid IDs no longer disappear silently — they fail model construction.
    expect(() => buildCustomModel(0, 0, 0, [
      { multiplier: 1.5, wayIds: [42, -7] },
    ])).toThrow(/Invalid OSM way IDs/);
    expect(() => buildCustomModel(0, 0, 0, [
      { multiplier: 1.5, wayIds: [] },
    ])).toThrow(/without any OSM way IDs/);
  });

  it('pads corridor bounds by meters', () => {
    const bounds = corridorBounds([{ lat: 50, lng: 14 }, { lat: 50.01, lng: 14.01 }]);
    expect(50 - 5_000 / 111_320).toBeGreaterThan(bounds.minLat);
    expect(50.01 + 5_000 / 111_320).toBeLessThan(bounds.maxLat);
    expect(14 - 5_000 / (111_320 * Math.cos((50 * Math.PI) / 180))).toBeGreaterThan(bounds.minLng);
  });

  it('enforces rating throttle minute and hourly boundaries', () => {
    let now = 0;
    const throttle = createRatingThrottle(() => now);
    for (let i = 0; i < 5; i += 1) {
      expect(throttle('ip')).toEqual({ ok: true, retryAfterSec: 0 });
    }
    expect(throttle('ip')).toEqual({ ok: false, retryAfterSec: 60 });

    now = 30_000;
    expect(throttle('ip')).toEqual({ ok: false, retryAfterSec: 30 });
    now = 60_001;
    for (let i = 0; i < 4; i += 1) {
      expect(throttle('ip')).toEqual({ ok: true, retryAfterSec: 0 });
    }

    now = 0;
    const hourlyThrottle = createRatingThrottle(() => now);
    for (let i = 0; i < 60; i += 1) {
      now = i * 61_000;
      expect(hourlyThrottle('hourly')).toEqual({ ok: true, retryAfterSec: 0 });
    }
    expect(hourlyThrottle('hourly')).toEqual({ ok: false, retryAfterSec: 1 });
  });
});
