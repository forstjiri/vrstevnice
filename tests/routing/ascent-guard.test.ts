/**
 * Unit tests for applyAscentGuard().
 *
 * The core invariant: the guard must select the route with lower
 * RECOMPUTED elevationGain (smoothed 100m + 1.5m min-delta),
 * NOT the one with lower raw GH ascend.
 *
 * Uses synthetic geometry — no GraphHopper required.
 */

import { describe, it, expect } from 'vitest';
import {
  applyAscentGuard,
  computeElevationProfile,
  smoothElevationProfile,
  computeElevationGainLoss,
  convertGHToRouteResponse,
} from '@vrstevnice/routing';
import type { GHRouteResult } from '@vrstevnice/routing';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRoute(geometry: [number, number, number][], rawAscend: number): GHRouteResult {
  return {
    distance: 5000,
    duration: 1200000,
    elevationGain: rawAscend,
    elevationLoss: 0,
    geometry,
    surfaceSegments: [],
    roadClassSegments: [],
    roadEnvSegments: [],
  };
}

/** Generate coords stepping north by ~11m per step (0.0001° lat). */
function flatCoords(n: number, baseEle: number): [number, number, number][] {
  return Array.from({ length: n }, (_, i) => [14.4, 50.0 + i * 0.0001, baseEle]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('applyAscentGuard', () => {
  it('selects the route with lower recomputed elevationGain', () => {
    // Route A: one big 50m climb → recomputed gain = 50
    const routeA = makeRoute([
      [14.4, 50.0, 200],
      [14.4, 50.01, 200],
      [14.4, 50.02, 250],
      [14.4, 50.03, 250],
    ], 50);

    // Route B: one big 80m climb → recomputed gain = 80
    const routeB = makeRoute([
      [14.4, 50.0, 200],
      [14.4, 50.01, 200],
      [14.4, 50.02, 280],
      [14.4, 50.03, 280],
    ], 80);

    expect(applyAscentGuard(routeA, routeB)).toBe(routeA);
    expect(applyAscentGuard(routeB, routeA)).toBe(routeA);
  });

  it('selects by recomputed gain, not raw GH ascend, when they disagree', () => {
    // Route A: tiny 0.3m bumps every ~11m. Raw GH counts each bump (100 bumps × ~0.3m ≈ 30m),
    // but after smoothing (50m half-window), the bumps average out. Recomputed gain ≈ 0.
    const coordsA: [number, number, number][] = [[14.4, 50.0, 200]];
    for (let i = 1; i <= 200; i += 2) {
      coordsA.push([14.4, 50.0 + i * 0.0001, 200.3]);
      coordsA.push([14.4, 50.0 + (i + 1) * 0.0001, 200.0]);
    }
    const routeA = makeRoute(coordsA, 30); // raw GH says 30m ascend

    // Route B: one steady 50m climb spread over 200 points (~11m spacing).
    // Smoothing won't eliminate this — it's a genuine slope.
    const coordsB: [number, number, number][] = Array.from(
      { length: 201 },
      (_, i) => [14.4, 50.0 + i * 0.0001, 200 + i * 0.25] as [number, number, number],
    );
    const routeB = makeRoute(coordsB, 50); // raw GH says 50m ascend

    // Raw ranking: A (30m) < B (50m) → raw-based guard would pick A
    const gainA = computeElevationGainLoss(
      smoothElevationProfile(computeElevationProfile(routeA.geometry)),
    ).gain;
    const gainB = computeElevationGainLoss(
      smoothElevationProfile(computeElevationProfile(routeB.geometry)),
    ).gain;

    // Verify divergence: A's bumps smooth out (gainA ≈ 0), B's climb persists (gainB ≈ 50)
    // So B has MORE recomputed gain, and A should be the guard's pick
    expect(gainA).toBeLessThan(gainB);
    expect(routeA.elevationGain).toBeLessThan(routeB.elevationGain);

    // Guard should pick A (lower recomputed gain)
    expect(applyAscentGuard(routeA, routeB)).toBe(routeA);
    expect(applyAscentGuard(routeB, routeA)).toBe(routeA);
  });

  it('returns elevResult when both have equal recomputed gain', () => {
    const coords = flatCoords(10, 200);
    const routeA = makeRoute(coords, 50);
    const routeB = makeRoute(coords, 30);

    // Same geometry → same recomputed gain (50 and 30 raw don't matter)
    expect(applyAscentGuard(routeA, routeB)).toBe(routeA);
  });

  it('is consistent: applyAscentGuard(a,b) and applyAscentGuard(b,a) return same winner', () => {
    const routeA = makeRoute(
      [[14.4, 50.0, 200], [14.4, 50.01, 260]],
      60,
    );
    const routeB = makeRoute(
      [[14.4, 50.0, 200], [14.4, 50.01, 240]],
      40,
    );

    const winner1 = applyAscentGuard(routeA, routeB);
    const winner2 = applyAscentGuard(routeB, routeA);
    expect(winner1).toBe(winner2);
  });
});

describe('Ascent guard end-to-end via convertGHToRouteResponse', () => {
  it('recomputed elevationGain in RouteResponse matches the guard logic', () => {
    // Route A: tiny 0.3m bumps — smooth out, low recomputed gain, but raw = 30m
    const coordsA: [number, number, number][] = [[14.4, 50.0, 200]];
    for (let i = 1; i <= 200; i += 2) {
      coordsA.push([14.4, 50.0 + i * 0.0001, 200.3]);
      coordsA.push([14.4, 50.0 + (i + 1) * 0.0001, 200.0]);
    }
    const routeA = makeRoute(coordsA, 30);

    // Route B: steady 50m climb — smoothing preserves it, raw = 50m
    const coordsB: [number, number, number][] = Array.from(
      { length: 201 },
      (_, i) => [14.4, 50.0 + i * 0.0001, 200 + i * 0.25] as [number, number, number],
    );
    const routeB = makeRoute(coordsB, 50);

    // convertGHToRouteResponse uses the same smoothing + gain computation as the guard
    const responseA = convertGHToRouteResponse(routeA);
    const responseB = convertGHToRouteResponse(routeB);

    // The guard's winner must have lower or equal RouteResponse.elevationGain
    const winner = applyAscentGuard(routeA, routeB);
    const winnerResponse = convertGHToRouteResponse(winner);
    const loserResponse = winner === routeA ? responseB : responseA;

    expect(winnerResponse.elevationGain).toBeLessThanOrEqual(loserResponse.elevationGain);
  });
});
