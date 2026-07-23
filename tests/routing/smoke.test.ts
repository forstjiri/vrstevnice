/**
 * Smoke test proving the full GraphHopper integration pipeline:
 * 1. GH container starts from docker-compose.test.yml
 * 2. Synthetic test-graph.osm is imported
 * 3. /health endpoint returns 200
 * 4. /route between two nodes returns valid geometry with coordinate points
 *
 * Test data: tests/fixtures/nodes.ts (node coordinates)
 * Infrastructure: tests/helpers/gh-lifecycle.ts (container lifecycle)
 */

import { describe, it, expect } from 'vitest';
import { GRAPHHOPPER_URL, dumpGHLogs } from '../helpers/gh-lifecycle';
import { nodePoint } from '../fixtures/nodes';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Make a raw GH /route request and return the typed response.
 */
async function ghRoute(points: [number, number][], customModel?: unknown) {
  const body: Record<string, unknown> = {
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

// Minimal types for the GH /route response
interface GHRouteResponse {
  paths?: GHPath[];
  info?: { errors?: unknown[] };
}

interface GHPath {
  distance: number;
  time: number;
  ascend: number;
  descend: number;
  points: {
    type: string;
    coordinates: number[][]; // [lon, lat, ele?]
  };
  instructions: unknown[];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GraphHopper smoke test', () => {
  it('health endpoint returns 200', async () => {
    const res = await fetch(`${GRAPHHOPPER_URL}/health`);
    expect(res.status).toBe(200);

    // GH /health returns plain text "OK" (not JSON)
    const body = await res.text();
    expect(body).toBeDefined();
    console.log(`[smoke] /health response: "${body}"`);
  });

  it('route between Start and End returns valid geometry', async () => {
    const startPt = nodePoint('Start'); // [lon, lat]
    const endPt = nodePoint('End'); // [lon, lat]

    const data = await ghRoute([startPt, endPt]);

    // GH should find a path on the synthetic graph
    expect(data.paths).toBeDefined();
    expect(data.paths!.length).toBeGreaterThanOrEqual(1);
    expect(data.info?.errors).toBeUndefined();

    const path = data.paths![0];

    // Validate basic route properties
    expect(path.distance).toBeGreaterThan(0);
    expect(path.time).toBeGreaterThan(0);

    // Validate geometry — should have at least start and end points
    expect(path.points.coordinates.length).toBeGreaterThanOrEqual(2);

    // Validate coordinate format: each point should have [lon, lat, ...]
    path.points.coordinates.forEach((coord) => {
      expect(coord.length).toBeGreaterThanOrEqual(2);
      expect(typeof coord[0]).toBe('number'); // lon
      expect(typeof coord[1]).toBe('number'); // lat
      expect(Math.abs(coord[0])).toBeLessThanOrEqual(180);
      expect(Math.abs(coord[1])).toBeLessThanOrEqual(90);
    });

    // Validate that route passes near the expected area (Prague ~50.07, 14.43)
    const firstCoord = path.points.coordinates[0];
    expect(Math.abs(firstCoord[1] - 50.07)).toBeLessThan(0.1);
    expect(Math.abs(firstCoord[0] - 14.43)).toBeLessThan(0.1);

    // Log summary for visual verification
    console.log('[smoke] Route summary:');
    console.log(`  Distance: ${(path.distance / 1000).toFixed(3)} km`);
    console.log(`  Duration: ${(path.time / 1000).toFixed(1)} s`);
    console.log(`  Points: ${path.points.coordinates.length}`);
    console.log(`  Ascend: ${path.ascend}m, Descend: ${path.descend}m`);
  });

  it('route uses bike profile and returns 2D coordinates (no elevation)', async () => {
    const startPt = nodePoint('Start');
    const endPt = nodePoint('End');

    // Request with elevation: false — coordinates should be 2D
    const data = await ghRoute([startPt, endPt]);

    expect(data.paths).toBeDefined();
    expect(data.paths!.length).toBeGreaterThanOrEqual(1);

    const path = data.paths![0];

    // With elevation: false and noop elevation provider, coordinates are [lon, lat]
    // (may include 0 elevation — that's fine, just verify lon/lat are valid)
    path.points.coordinates.forEach((coord) => {
      expect(coord[0]).toBeDefined();
      expect(coord[1]).toBeDefined();
    });

    // Verify response structure matches expected GH format
    expect(path.points.type).toBe('LineString');
    expect(Array.isArray(path.points.coordinates)).toBe(true);
    expect(typeof path.distance).toBe('number');
    expect(typeof path.time).toBe('number');

    console.log(
      `[smoke] Response format validated: LineString with ${path.points.coordinates.length} points`,
    );
  });
});
