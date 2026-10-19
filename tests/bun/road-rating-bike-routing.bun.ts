/* eslint-disable import-x/no-relative-packages, import-x/no-unresolved */
import { Database } from 'bun:sqlite';
import {
  beforeEach, describe, expect, it, mock,
} from 'bun:test';
import { buildCustomModel, type GHRouteRequest } from '../../src/routing';
import { BIKE_TYPES, type BikeType } from '../../src/shared';
import { bucketizeRoads } from '../../src/be/road-ratings-core';
import { nodePoint } from '../fixtures/nodes';

// Use the real persistence implementation, but never open data/data.db.
let redirectedLiveDatabase = false;
class IsolatedDatabase extends Database {
  constructor(filename?: string, options?: ConstructorParameters<typeof Database>[1]) {
    if (filename?.endsWith('/data/data.db')) {
      redirectedLiveDatabase = true;
      super(':memory:', options);
      return;
    }
    super(filename, options);
  }
}
mock.module('bun:sqlite', () => ({ Database: IsolatedDatabase }));
const { rawSqlite } = await import('../../src/be/db');
const { applySaveRating, getVotedRoadsInCorridor } = await import('../../src/be/road-ratings');

const start = nodePoint('Exact_Start');
const end = nodePoint('Exact_End');
const junction = nodePoint('Exact_Junction');
const targetEnd = nodePoint('Exact_TargetEnd');
const stops = [start, end].map(([lng, lat]) => ({ name: 'Test stop', lat, lng }));
const DIRECT_IDS = [1000, 1001, 1002];
const DETOUR_IDS = [1000, 1010, 1011, 1012];
const ghUrl = process.env.GRAPHHOPPER_URL;
if (ghUrl !== 'http://localhost:8988') {
  throw new Error('Bike-routing integration must use the disposable GH fixture on localhost:8988');
}

beforeEach(() => {
  expect(redirectedLiveDatabase).toBe(true);
  rawSqlite.exec(`
    DELETE FROM road_ratings; DELETE FROM rated_road_members; DELETE FROM rated_roads;
  `);
});

function saveVotes(bikes: (BikeType | null)[]) {
  bikes.forEach((minimumBike, index) => {
    applySaveRating(rawSqlite, { wayId: 1001, memberIds: [1001], name: 'MTB shortcut' }, {
      type: 'prefer', subtypes: ['nice'], minimumBike: minimumBike ?? 'mtb', ip: `test-${index}`,
    }, {
      type: 'LineString', coordinates: [junction, targetEnd],
    }, [junction[1], junction[0]]);
    if (minimumBike == null) {
      // Legacy recommendations predate the required minimum-bike field.
      rawSqlite.query('UPDATE road_ratings SET minimum_bike = NULL WHERE ip = ?')
        .run(`test-${index}`);
    }
  });
}

async function requestFor(bikeType: BikeType, useRoadRatings = true) {
  const roads = useRoadRatings ? await getVotedRoadsInCorridor(stops, 200, bikeType) : [];
  const buckets = bucketizeRoads(roads);
  const model = buildCustomModel(0, 1, 0, buckets);
  // The disposable graph has noop elevation, just like the existing exact-ID tests.
  model.priority = model.priority.filter((rule) => !rule.if.includes('slope'));
  return { model, buckets };
}

async function routeFor(bikeType: BikeType, useRoadRatings = true) {
  const { model, buckets } = await requestFor(bikeType, useRoadRatings);
  const body: GHRouteRequest = {
    points: [start, end],
    profile: 'bike',
    elevation: false,
    points_encoded: false,
    'ch.disable': true,
    details: ['osm_way_id'],
    custom_model: model,
  };
  const response = await fetch(`${ghUrl}/route`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`GH ${response.status}: ${await response.text()}`);
  const data = await response.json() as {
    paths: { distance: number; details: { osm_way_id: [number, number, number | string][] } }[];
  };
  expect(data.paths).toHaveLength(1);
  const path = data.paths[0];
  return {
    ids: path.details.osm_way_id.map((detail) => Number(detail[2])),
    distance: path.distance,
    model,
    buckets,
  };
}

function expectDirect(ids: number[]) {
  expect(ids).toEqual(expect.arrayContaining(DIRECT_IDS));
  expect(ids.every((id) => DIRECT_IDS.includes(id))).toBe(true);
}

function expectDetour(ids: number[]) {
  expect(ids).toEqual(expect.arrayContaining(DETOUR_IDS));
  expect(ids.every((id) => DETOUR_IDS.includes(id))).toBe(true);
  expect(ids).not.toContain(1001);
}

describe('minimum-bike SQLite → custom model → GraphHopper routing', () => {
  it.each([...BIKE_TYPES])('ignores the selected %s bike on community opt-out', async (bike) => {
    saveVotes(Array<BikeType>(10).fill('mtb'));
    const route = await routeFor(bike, false);
    expect(route.buckets).toEqual([]);
    expect(route.model.priority.some((rule) => rule.if.includes('osm_way_id'))).toBe(false);
    expectDirect(route.ids);
  });

  it.each([...BIKE_TYPES])('keeps four recommendations bike-independent for %s', async (bike) => {
    saveVotes(Array<BikeType>(4).fill('mtb'));
    const route = await routeFor(bike);
    expect(route.buckets).toEqual([{ multiplier: 1.5, wayIds: [1001] }]);
    expectDirect(route.ids);
  });

  it.each([5, 9])('applies only weak avoidance with %i explicit recommendations', async (count) => {
    saveVotes(Array<BikeType>(count).fill('mtb'));
    const route = await routeFor('gravel');
    expect(route.buckets).toEqual([{ multiplier: 0.8, wayIds: [1001] }]);
    expect(route.model.priority.at(-1)).toEqual({ if: 'osm_way_id == 1001', multiply_by: '0.8' });
    // This ~90m segment is too short for weak avoidance to justify the detour.
    expectDirect(route.ids);
  });

  it.each([...BIKE_TYPES])('routes %s correctly with ten minimum-MTB votes', async (bike) => {
    saveVotes(Array<BikeType>(10).fill('mtb'));
    const baseline = await routeFor(bike, false);
    const route = await routeFor(bike);
    if (bike === 'road' || bike === 'gravel') {
      expect(route.buckets).toEqual([{ multiplier: 0.2, wayIds: [1001] }]);
      expectDetour(route.ids);
      expect(route.distance).toBeGreaterThan(baseline.distance);
    } else {
      expect(route.buckets).toEqual([{ multiplier: 1.5, wayIds: [1001] }]);
      expectDirect(route.ids);
      expect(route.distance).toBe(baseline.distance);
    }
  });

  it('reroutes with a seven-of-ten consensus, less strongly than unanimity', async () => {
    saveVotes([...Array<BikeType>(7).fill('mtb'), ...Array<BikeType>(3).fill('gravel')]);
    const route = await routeFor('gravel');
    expect(route.buckets).toEqual([{ multiplier: 0.38, wayIds: [1001] }]);
    expectDetour(route.ids);
  });

  it.each([4, 5, 6])('ignores bike-specific avoidance with only %i of ten votes', async (count) => {
    saveVotes([
      ...Array<BikeType>(count).fill('mtb'), ...Array<BikeType>(10 - count).fill('gravel'),
    ]);
    const route = await routeFor('gravel');
    expect(route.buckets[0].multiplier).toBeGreaterThanOrEqual(1);
    expectDirect(route.ids);
  });

  it('does not count legacy recommendations toward bike-specific confidence', async () => {
    saveVotes([...Array<BikeType>(4).fill('mtb'), ...Array<null>(20).fill(null)]);
    const route = await routeFor('road');
    expect(route.buckets).toEqual([{ multiplier: 1.5, wayIds: [1001] }]);
    expectDirect(route.ids);
  });
});
