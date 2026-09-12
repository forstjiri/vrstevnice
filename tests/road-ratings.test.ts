/* eslint-disable import-x/no-relative-packages */
import { describe, expect, it } from 'vitest';
import { buildCustomModel } from '../src/routing';
import { connectedRoadWayGroup } from '../src/shared';
// The pure backend unit is intentionally imported directly to avoid starting Elysia.
import {
  aggregateRatings,
  buildBufferPolygon,
  buildRoadRatingModelParts,
  bucketizeRoads,
  chainGeometryPieces,
  corridorBounds,
  createRatingThrottle,
  medianOf,
  perUserMultiplier,
  validateSubtypes,
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

  it('builds a closed buffered ring around a line', () => {
    const ring = buildBufferPolygon([[0, 0], [0.001, 0]], 15);
    expect(ring.length).toBeGreaterThanOrEqual(4);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    const lngs = ring.map(([lng]) => lng);
    const lats = ring.map(([, lat]) => lat);
    expect(Math.min(...lngs)).toBeLessThan(0);
    expect(Math.max(...lngs)).toBeGreaterThan(0.001);
    expect(Math.min(...lats)).toBeCloseTo(-15 / 111_320, 5);
    expect(Math.max(...lats)).toBeCloseTo(15 / 111_320, 5);
    expect(Math.max(...lats) - Math.min(...lats)).toBeGreaterThan(20 / 111_320);
  });

  it('groups roads by multiplier rounded to two decimals', () => {
    expect(bucketizeRoads([
      { wayId: 1, multiplier: 1.234 },
      { wayId: 2, multiplier: 1.235 },
      { wayId: 3, multiplier: 0.2 },
    ])).toEqual([
      { multiplier: 1.23, wayIds: [1] },
      { multiplier: 1.24, wayIds: [2] },
      { multiplier: 0.2, wayIds: [3] },
    ]);
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
    expect(throttle('ip')).toEqual({ ok: true, retryAfterSec: 0 });
    expect(throttle('ip')).toEqual({ ok: true, retryAfterSec: 0 });
    expect(throttle('ip')).toEqual({ ok: false, retryAfterSec: 60 });

    now = 30_000;
    expect(throttle('ip')).toEqual({ ok: false, retryAfterSec: 30 });
    now = 60_001;
    expect(throttle('ip')).toEqual({ ok: true, retryAfterSec: 0 });
    expect(throttle('ip')).toEqual({ ok: true, retryAfterSec: 0 });

    now = 0;
    const hourlyThrottle = createRatingThrottle(() => now);
    for (let i = 0; i < 20; i += 1) {
      now = i * 61_000;
      expect(hourlyThrottle('hourly')).toEqual({ ok: true, retryAfterSec: 0 });
    }
    expect(hourlyThrottle('hourly')).toEqual({ ok: false, retryAfterSec: 2441 });
  });

  it('chains geometry pieces in both directions and keeps disjoint pieces', () => {
    expect(chainGeometryPieces([
      [[0, 0], [1, 0]],
      [[1, 0], [2, 0]],
      [[4, 0], [3, 0]],
      [[2, 0], [3, 0]],
      [[10, 0], [11, 0]],
    ])).toEqual([
      [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]],
      [[10, 0], [11, 0]],
    ]);
  });

  it('keeps area IDs and custom-model rule IDs in sync', () => {
    const parts = buildRoadRatingModelParts([
      { wayId: 10, multiplier: 1.5, geometry: [[[14, 50], [14.001, 50]]] },
      { wayId: 20, multiplier: 0.2, geometry: [[[14.002, 50], [14.003, 50]]] },
    ]);
    const featureIds = new Set(parts.areas.features.map((feature) => feature.id));
    parts.buckets.forEach((bucket) => {
      bucket.areaIds.forEach((areaId) => expect(featureIds.has(areaId)).toBe(true));
    });
    const model = buildCustomModel(0, 0, 0, parts.buckets);
    const ruleAreaIds = model.priority.flatMap((rule) => [
      ...rule.if.matchAll(/in_([^\s|]+)/g),
    ].map((match) => match[1]));
    ruleAreaIds.forEach((areaId) => expect(featureIds.has(areaId)).toBe(true));
  });
});
