/**
 * Haversine-based route assertion helpers for GraphHopper integration tests.
 *
 * Provides:
 * - haversineMeters(): great-circle distance between two [lon, lat] points
 * - findNodeHits(): finds which route coordinates fall near expected nodes
 * - assertRoutePassesThrough(): asserts a route passes through nodes in order
 */

import { nodePoint, TEST_NODES } from '../fixtures/nodes';

// ---------------------------------------------------------------------------
// Haversine distance
// ---------------------------------------------------------------------------

const R = 6_371_000; // Earth radius in meters

/**
 * Calculate the great-circle distance in meters between two [lon, lat] points.
 */
export function haversineMeters(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

// ---------------------------------------------------------------------------
// Node hit detection
// ---------------------------------------------------------------------------

/**
 * For each node, find the first route coordinate within `toleranceM` meters.
 *
 * @returns Map<nodeName, routeIndex> — route index of the first hit for each node
 *          (omits nodes with no hit)
 */
export function findNodeHits(
  routeCoords: number[][],
  nodeCoords: [string, number, number][],
  toleranceM = 50,
): Map<string, number> {
  const hits = new Map<string, number>();

  nodeCoords.forEach(([name, lon, lat]) => {
    const index = routeCoords.findIndex(([routeLon, routeLat]) => (
      haversineMeters(routeLon, routeLat, lon, lat) <= toleranceM
    ));
    if (index >= 0) hits.set(name, index);
  });

  return hits;
}

// ---------------------------------------------------------------------------
// Route assertion
// ---------------------------------------------------------------------------

/**
 * Assert that a route passes near the given expected nodes, in order.
 *
 * Uses haversine distance (default 50m tolerance) to match route coordinates
 * to node positions, then verifies that matched route indices are monotonically
 * increasing (i.e., the route visits nodes in the specified order).
 *
 * @throws Error with a clear "Expected: A→B→C, Got: A→D→C" message on failure
 */
export function assertRoutePassesThrough(
  routeCoords: number[][],
  expectedNodes: string[],
  toleranceM = 50,
): void {
  // Resolve node names to [name, lon, lat]
  const nodeCoords: [string, number, number][] = expectedNodes.map((name) => {
    const pt = nodePoint(name);
    return [name, pt[0], pt[1]];
  });

  // Find hits
  const hits = findNodeHits(routeCoords, nodeCoords, toleranceM);

  // Check all nodes were found
  const missingNodes = expectedNodes.filter((n) => !hits.has(n));
  if (missingNodes.length > 0) {
    throw new Error(
      `assertRoutePassesThrough: route does not pass near nodes: ${missingNodes.join(', ')}`,
    );
  }

  // Check ordering — route indices must be monotonically increasing
  const indices = expectedNodes.map((n) => hits.get(n)!);
  indices.slice(1).forEach((index, offset) => {
    const previousIndex = indices[offset];
    if (index < previousIndex) {
      // Build the actual node subsequence found on the route
      // Sort all hits by route index to reconstruct what the route actually passed through
      const allTestNodeCoords: [string, number, number][] = Object.entries(TEST_NODES).map(
        ([name, node]) => [name, node.lon, node.lat],
      );
      const allHits = findNodeHits(routeCoords, allTestNodeCoords, toleranceM);
      const sortedHitEntries = [...allHits.entries()].sort((a, b) => a[1] - b[1]);
      const actualSubsequence = sortedHitEntries
        .filter(([name]) => expectedNodes.includes(name))
        .map(([name]) => name);

      throw new Error(
        'assertRoutePassesThrough: nodes out of order.\n'
          + `Expected: ${expectedNodes.join('→')}\n`
          + `Got:      ${actualSubsequence.join('→')}`,
      );
    }
  });

  // Log success with distances
  const distSummary = expectedNodes
    .map((n) => {
      const idx = hits.get(n)!;
      return `${n}@${idx}`;
    })
    .join(', ');
  console.log(`[routing-test] assertRoutePassesThrough passed: ${distSummary}`);
}
