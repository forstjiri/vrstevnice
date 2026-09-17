/**
 * GraphHopper integration coverage for exact community-road penalties.
 *
 * The fixture has three alternatives with common Start/End nodes and cross-links
 * at internal junctions.  The assertions use GH's `osm_way_id` path detail, not
 * only geometry proximity: that catches a regression to area/buffer penalties
 * which can bleed to a close parallel or a shared endpoint.
 */
import { describe, expect, it } from 'vitest';
import { buildCustomModel, type GHCustomModel, type GHRouteRequest } from '@vrstevnice/routing';
import type { JsonValue } from '@vrstevnice/shared';
// eslint-disable-next-line import-x/no-relative-packages
import { bucketizeRoads } from '../../src/be/road-ratings-core';
import { GRAPHHOPPER_URL, dumpGHLogs } from '../helpers/gh-lifecycle';
import { nodePoint } from '../fixtures/nodes';

interface GHPathWithWayDetails {
  distance: number;
  points: { coordinates: number[][] };
  details?: { osm_way_id?: [number, number, string | number][] };
}

interface GHResponse {
  paths?: GHPathWithWayDetails[];
  info?: { errors?: JsonValue[] };
}

const A_WAY_IDS = [15, 16, 17, 18, 19];
const B_WAY_IDS = [20, 21, 22, 23, 24];
const DIRECT_EXACT_IDS = [1000, 1001, 1002];
const PARALLEL_EXACT_IDS = [1000, 1010, 1011, 1012];

async function routeWith(model: GHCustomModel): Promise<GHPathWithWayDetails> {
  return routeBetween('Start', 'End', model);
}

async function routeBetween(
  start: string,
  end: string,
  model: GHCustomModel,
): Promise<GHPathWithWayDetails> {
  const body: GHRouteRequest = {
    points: [nodePoint(start), nodePoint(end)],
    profile: 'bike',
    elevation: false,
    points_encoded: false,
    'ch.disable': true,
    // This is the critical engine-level assertion: the imported graph exposes
    // exact OSM way identities as a path detail as well as accepting the rule.
    details: ['osm_way_id'],
    custom_model: model,
  };
  const response = await fetch(`${GRAPHHOPPER_URL}/route`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response.ok) {
    dumpGHLogs(50);
    throw new Error(`GH /route returned ${response.status}: ${await response.text()}`);
  }
  const data = await response.json() as GHResponse;
  expect(data.info?.errors).toBeUndefined();
  expect(data.paths).toHaveLength(1);
  const path = data.paths![0];
  expect(path.details?.osm_way_id).toBeDefined();
  return path;
}

function pathWayIds(path: GHPathWithWayDetails): number[] {
  return (path.details?.osm_way_id ?? []).map((detail) => Number(detail[2]));
}

function baseModel() {
  // The normal request construction starts from the application's model. Strip
  // slope rules because this deliberately flat GH fixture uses noop elevation.
  const model = buildCustomModel(0, 1, 0);
  return { ...model, priority: model.priority.filter((rule) => !rule.if.includes('slope')) };
}

describe('GraphHopper exact osm_way_id penalties', () => {
  it(
    'imports osm_way_id and changing only target way 15 selects the untouched alternative',
    async () => {
      const baseline = await routeWith(baseModel());
      expect(pathWayIds(baseline)).toContain(15);

      const targetOnly = buildCustomModel(0, 1, 0, [{ wayIds: [15], multiplier: 0.05 }]);
      targetOnly.priority = targetOnly.priority.filter((rule) => !rule.if.includes('slope'));
      const rerouted = await routeWith(targetOnly);
      const reroutedIds = pathWayIds(rerouted);

      // A target-only rule must not penalize the nearby/parallel B branch merely
      // because both branches share Start and End.
      expect(reroutedIds).not.toContain(15);
      expect(reroutedIds.some((id) => B_WAY_IDS.includes(id))).toBe(true);
    },
  );

  it(
    'keeps a junction neighbour usable when only a short own-rated segment is penalized',
    async () => {
      const direct = await routeBetween('Exact_Start', 'Exact_End', baseModel());
      expect(pathWayIds(direct)).toEqual(expect.arrayContaining(DIRECT_EXACT_IDS));

      const shortTarget = buildCustomModel(0, 1, 0, [{ wayIds: [1001], multiplier: 0.05 }]);
      shortTarget.priority = shortTarget.priority.filter((rule) => !rule.if.includes('slope'));
      const reroutedIds = pathWayIds(
        await routeBetween('Exact_Start', 'Exact_End', shortTarget),
      );

      // 1000 is shared into the junction, while 1010…1012 are only ~50m away.
      // Exact matching preserves both: no area/buffer bleed is permitted.
      expect(reroutedIds).toContain(1000);
      expect(reroutedIds).not.toContain(1001);
      expect(reroutedIds).toEqual(expect.arrayContaining(PARALLEL_EXACT_IDS));
      expect(reroutedIds.every((id) => PARALLEL_EXACT_IDS.includes(id))).toBe(true);
    },
  );

  it(
    'changes route only when the exact shared-endpoint/internal-junction member is targeted',
    async () => {
      const control = buildCustomModel(0, 1, 0, [{ wayIds: [999_999], multiplier: 0.05 }]);
      control.priority = control.priority.filter((rule) => !rule.if.includes('slope'));
      expect(pathWayIds(await routeWith(control))).toContain(15);

      // All connected members of the rated street are one exact OR rule. This
      // covers multi-member persistence and prevents a short internal segment
      // from escaping through the A/B cross-link junctions.
      const allMembers = buildCustomModel(0, 1, 0, [{ wayIds: A_WAY_IDS, multiplier: 0.05 }]);
      allMembers.priority = allMembers.priority.filter((rule) => !rule.if.includes('slope'));
      const reroutedIds = pathWayIds(await routeWith(allMembers));
      expect(reroutedIds.some((id) => A_WAY_IDS.includes(id))).toBe(false);
      expect(reroutedIds.some((id) => B_WAY_IDS.includes(id))).toBe(true);
      const memberRule = allMembers.priority.at(-1)?.if;
      expect(memberRule).toBe(A_WAY_IDS.map((id) => `osm_way_id == ${id}`).join(' || '));
      expect(memberRule).not.toContain('osm_way_id == 20');
    },
  );

  it('keeps rating rules in both ascent-guard request models and omits them on opt-out', () => {
    const bucket = [{ wayIds: [15, 16], multiplier: 0.2 }];
    const elevationRequest = buildCustomModel(1, 1, 0, bucket);
    const ascentGuardBaseRequest = buildCustomModel(0, 1, 0, bucket);
    const optOutRequest = buildCustomModel(1, 1, 0);
    const rule = 'osm_way_id == 15 || osm_way_id == 16';

    expect(elevationRequest.priority.map((item) => item.if)).toContain(rule);
    expect(ascentGuardBaseRequest.priority.map((item) => item.if)).toContain(rule);
    expect(optOutRequest.priority.map((item) => item.if)).not.toContain(rule);
  });

  it('rejects malformed membership before a GH request is constructed', () => {
    expect(() => buildCustomModel(0, 1, 0, [{ wayIds: [0], multiplier: 0.2 }]))
      .toThrow(/Invalid OSM way IDs/);
    expect(() => buildCustomModel(0, 1, 0, [{ wayIds: [], multiplier: 0.2 }]))
      .toThrow(/without any OSM way IDs/);
  });

  it('rejects conflicting persisted membership before it can become a GH rule', () => {
    expect(() => bucketizeRoads([
      { wayId: 5001, multiplier: 0.2, memberIds: [1001] },
      { wayId: 5002, multiplier: 0.8, memberIds: [1001, 1010] },
    ])).toThrow(/Membership conflict/);
  });
});
