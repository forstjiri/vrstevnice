/**
 * Parametrized routing tests proving buildCustomModel() changes GH route selection.
 *
 * Three paths from Start to End in the synthetic spiderweb (test-graph.osm):
 *   Path A (short, ~4.5 km): all tertiary — PENALIZED by roadAvoid
 *   Path B (medium, ~5.0 km): all unclassified — NOT in any custom model rule (no penalty)
 *   Path C (long,  ~9.0 km): all cycleway — BOOSTED by cyclewayCoeff
 *
 * Cross-links at midpoints connect all three paths.
 *
 * Route selection:
 *   roadAvoid high (1.0):        Path A wins (shortest, full priority)
 *   roadAvoid low (≤0.75):       Path B wins (unpenalized, medium distance)
 *   cycleway high (≥0.7):        Path C wins (boosted cycleway beats medium distance)
 *   no custom model:             Path A wins (default GH bike profile, shortest)
 */

import { describe, it, expect } from 'vitest';
import {
  buildCustomModel,
  type GHCustomModel,
  type GHRouteRequest,
} from '@vrstevnice/routing';
import type { JsonValue } from '@vrstevnice/shared';
import { GRAPHHOPPER_URL, dumpGHLogs } from '../helpers/gh-lifecycle';
import { nodePoint, TEST_NODES } from '../fixtures/nodes';
import { assertRoutePassesThrough, findNodeHits } from '../helpers/assert-route';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GHRouteResponse {
  paths?: GHPath[];
  info?: { errors?: JsonValue[] };
}

interface GHPath {
  distance: number;
  time: number;
  ascend: number;
  descend: number;
  points: {
    type: string;
    coordinates: number[][]; // [lon, lat, ...]
  };
  instructions: JsonValue[];
}

interface RouteTestCase {
  name: string;
  startNode: string;
  endNode: string;
  elevationCoeff: number;
  roadAvoidanceCoeff: number;
  /** Cycleway preference coefficient 0→1. Defaults to 0. */
  cyclewayCoeff?: number;
  /** Expected node names in order the route must pass through. */
  expectedNodes: string[];
  /** If true, sends NO custom model — tests GH base bike profile. */
  skipCalibration?: boolean;
}

// ---------------------------------------------------------------------------
// Helper: strip slope rules
// ---------------------------------------------------------------------------

/**
 * Test GH has graph.elevation.provider: noop, so average_slope/max_slope
 * encoded values are not available. Strip slope rules from the custom model.
 */
function stripSlopeRules(cm: GHCustomModel): GHCustomModel {
  return {
    ...cm,
    priority: cm.priority.filter(
      (r: { if: string; multiply_by?: string }) => !r.if.includes('slope'),
    ),
  };
}

// ---------------------------------------------------------------------------
// Helper: GH route fetch
// ---------------------------------------------------------------------------

async function ghRoute(points: [number, number][], customModel?: GHCustomModel) {
  const body: GHRouteRequest = {
    points,
    profile: 'bike',
    elevation: false,
    points_encoded: false,
    'ch.disable': true,
  };

  if (customModel) {
    body.custom_model = customModel;
  }

  const res = await fetch(`${GRAPHHOPPER_URL}/route`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    dumpGHLogs(30);
    throw new Error(`GH /route returned ${res.status}: ${text}`);
  }

  return res.json() as Promise<GHRouteResponse>;
}

// ---------------------------------------------------------------------------
// Test cases — calibrated empirically against the test graph
// ---------------------------------------------------------------------------

const testCases: RouteTestCase[] = [
  // --- BASELINE ---
  {
    name: 'no custom model → GH default profile',
    startNode: 'Start',
    endNode: 'End',
    elevationCoeff: 0.5,
    roadAvoidanceCoeff: 0.5,
    cyclewayCoeff: 0,
    expectedNodes: ['Start', 'A_Trunk', 'A_Primary', 'A_Secondary', 'A_Tertiary', 'End'],
    skipCalibration: true,
  },

  // --- ROAD AVOIDANCE: Path A (full priority) vs Path B (unpenalized) ---
  {
    name: 'no road avoidance → Path A (roadAvoid=1.0)',
    startNode: 'Start',
    endNode: 'End',
    elevationCoeff: 0.5,
    roadAvoidanceCoeff: 1.0,
    cyclewayCoeff: 0,
    expectedNodes: ['Start', 'A_Trunk', 'A_Primary', 'A_Secondary', 'A_Tertiary', 'End'],
  },
  {
    name: 'moderate road avoidance → Path B (roadAvoid=0.5)',
    startNode: 'Start',
    endNode: 'End',
    elevationCoeff: 0.5,
    roadAvoidanceCoeff: 0.5,
    cyclewayCoeff: 0,
    expectedNodes: ['Start', 'B_Unc1', 'B_Unc2', 'B_Unc3', 'B_Unc4', 'End'],
  },
  {
    name: 'max road avoidance → Path B (roadAvoid=0.0)',
    startNode: 'Start',
    endNode: 'End',
    elevationCoeff: 0.5,
    roadAvoidanceCoeff: 0.0,
    cyclewayCoeff: 0,
    expectedNodes: ['Start', 'B_Unc1', 'B_Unc2', 'B_Unc3', 'B_Unc4', 'End'],
  },

  // --- CYCLEWAY BOOST: Path C wins when boosted enough ---
  {
    name: 'max cycleway + no avoidance → Path C (roadAvoid=1.0, cycleway=1.0)',
    startNode: 'Start',
    endNode: 'End',
    elevationCoeff: 0.5,
    roadAvoidanceCoeff: 1.0,
    cyclewayCoeff: 1.0,
    expectedNodes: ['Start', 'C_Cyc1', 'C_Cyc2', 'C_Cyc3', 'C_Cyc4', 'End'],
  },
  {
    name: 'max avoidance + max cycleway → Path C (roadAvoid=0.0, cycleway=1.0)',
    startNode: 'Start',
    endNode: 'End',
    elevationCoeff: 0.5,
    roadAvoidanceCoeff: 0.0,
    cyclewayCoeff: 1.0,
    expectedNodes: ['Start', 'C_Cyc1', 'C_Cyc2', 'C_Cyc3', 'C_Cyc4', 'End'],
  },
  // At avoid=0.5, cycleway=0.9 the cycleway boost crosses Path B's weight boundary
  {
    name: 'moderate avoidance + strong cycleway → Path C (roadAvoid=0.5, cycleway=0.9)',
    startNode: 'Start',
    endNode: 'End',
    elevationCoeff: 0.5,
    roadAvoidanceCoeff: 0.5,
    cyclewayCoeff: 0.9,
    expectedNodes: ['Start', 'C_Cyc1', 'C_Cyc2', 'C_Cyc3', 'C_Cyc4', 'End'],
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Routing: buildCustomModel() route selection', () => {
  it.each(testCases)('$name', async (tc) => {
    const startPt = nodePoint(tc.startNode);
    const endPt = nodePoint(tc.endNode);

    let customModel: GHCustomModel | undefined;
    if (!tc.skipCalibration) {
      const cm = buildCustomModel(tc.elevationCoeff, tc.roadAvoidanceCoeff, tc.cyclewayCoeff ?? 0);
      customModel = stripSlopeRules(cm);
    }

    console.log(`[routing-test] Case: "${tc.name}"`);
    console.log(
      `[routing-test]   coeff: elev=${tc.elevationCoeff}, `
        + `roadAvoid=${tc.roadAvoidanceCoeff}, cycleway=${tc.cyclewayCoeff ?? 0}`,
    );
    console.log(
      `[routing-test]   customModel: ${customModel ? JSON.stringify(customModel) : 'none'}`,
    );

    const data = await ghRoute([startPt, endPt], customModel);

    expect(data.paths).toBeDefined();
    expect(data.paths!.length).toBeGreaterThanOrEqual(1);
    expect(data.info?.errors).toBeUndefined();

    const path = data.paths![0];
    expect(path.distance).toBeGreaterThan(0);
    expect(path.time).toBeGreaterThan(0);

    const coords = path.points.coordinates;
    expect(coords.length).toBeGreaterThanOrEqual(2);

    console.log(`[routing-test]   distance: ${(path.distance / 1000).toFixed(3)} km`);
    console.log(`[routing-test]   duration: ${(path.time / 1000).toFixed(1)} s`);

    // Log which named nodes the route passes near (for debugging)
    const routeLonLat = coords.map((c) => [c[0], c[1]] as [number, number]);
    const allNodeCoords = Object.entries(TEST_NODES).map(
      ([n, nd]) => [n, nd.lon, nd.lat] as [string, number, number],
    );
    const hits = findNodeHits(routeLonLat, allNodeCoords, 50);
    const hitSummary = [...hits.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([n, idx]) => `${n}@${idx}`)
      .join(', ');
    console.log(`[routing-test]   nodes:    ${hitSummary}`);

    assertRoutePassesThrough(coords, tc.expectedNodes);
  });
});
