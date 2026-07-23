/**
 * Unit tests for computeElevationProfile().
 *
 * Uses synthetic coordinate data — no GraphHopper container required.
 */

import { describe, it, expect } from 'vitest';
import {
  computeElevationProfile,
  smoothElevationProfile,
  computeElevationGainLoss,
} from '@vrstevnice/routing';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Known haversine distance for ~1° of latitude at the equator: ~111 195 m */
const DEG_LAT_M = 111_195;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeElevationProfile', () => {
  it('returns empty array for empty input', () => {
    expect(computeElevationProfile([])).toEqual([]);
  });

  it('returns single point with distance 0 for one coordinate', () => {
    const coords: [number, number, number][] = [[14.4, 50.1, 200]];
    const profile = computeElevationProfile(coords);

    expect(profile).toHaveLength(1);
    expect(profile[0].distance).toBe(0);
    expect(profile[0].elevation).toBe(200);
  });

  it('computes cumulative distance along a straight north-south line', () => {
    // Two points ~1° apart in latitude (same longitude)
    const coords: [number, number, number][] = [
      [14.4, 50.0, 200],
      [14.4, 51.0, 350],
    ];
    const profile = computeElevationProfile(coords);

    expect(profile).toHaveLength(2);
    expect(profile[0]).toEqual({ distance: 0, elevation: 200 });

    // Distance should be ~DEG_LAT_M (≈111 km)
    expect(profile[1].distance).toBeCloseTo(DEG_LAT_M, -3); // within 1 km
    expect(profile[1].elevation).toBe(350);
  });

  it('computes cumulative distance for three points', () => {
    const coords: [number, number, number][] = [
      [14.4, 50.0, 200],
      [14.4, 50.5, 300],
      [15.4, 50.5, 250],
    ];
    const profile = computeElevationProfile(coords);

    expect(profile).toHaveLength(3);
    // First point: distance = 0
    expect(profile[0].distance).toBe(0);

    // Second point: ~0.5° latitude ≈ 55 km
    const seg1 = profile[1].distance;
    expect(seg1).toBeCloseTo(DEG_LAT_M * 0.5, -3);

    // Third point: seg1 + ~1° longitude at ~50.25°N
    // The actual haversine for 1° lon at 50.25°N is ~71.3 km (cos(50.25°) * 111.2 km)
    const seg2 = profile[2].distance - seg1;
    expect(seg2).toBeGreaterThan(60_000); // at least 60 km
    expect(seg2).toBeLessThan(80_000); // at most 80 km

    // Third point cumulative distance should be greater than second
    expect(profile[2].distance).toBeGreaterThan(profile[1].distance);
  });

  it('skips coordinates with undefined/null elevation', () => {
    const coords: [number, number, number][] = [
      [14.4, 50.0, 200],
      [14.4, 50.5, undefined as unknown as number],
      [14.4, 51.0, 350],
    ];
    const profile = computeElevationProfile(coords);

    expect(profile).toHaveLength(2);
    expect(profile[0].elevation).toBe(200);
    expect(profile[1].elevation).toBe(350);
  });

  it('skips coordinates with NaN elevation', () => {
    const coords: [number, number, number][] = [
      [14.4, 50.0, 200],
      [14.4, 50.5, NaN],
      [14.4, 51.0, 350],
    ];
    const profile = computeElevationProfile(coords);

    expect(profile).toHaveLength(2);
  });

  it('returns empty array when all coordinates have invalid elevation', () => {
    const coords: [number, number, number][] = [
      [14.4, 50.0, NaN],
      [14.4, 51.0, undefined as unknown as number],
    ];
    expect(computeElevationProfile(coords)).toEqual([]);
  });

  it('handles a realistic small elevation profile', () => {
    // Coordinates around Prague: gradually increasing elevation
    const coords: [number, number, number][] = [
      [14.42, 50.08, 180],
      [14.43, 50.09, 195],
      [14.44, 50.1, 210],
      [14.45, 50.1, 225],
      [14.46, 50.11, 200],
    ];
    const profile = computeElevationProfile(coords);

    expect(profile).toHaveLength(5);

    // Distances should be monotonically increasing
    profile.slice(1).forEach((point, index) => {
      expect(point.distance).toBeGreaterThan(profile[index].distance);
    });

    // Elevation should rise then fall
    expect(profile[3].elevation).toBe(225); // peak
    expect(profile[4].elevation).toBe(200); // drop
  });

  it('produces the same results as manual haversine calculation', () => {
    // Two very close points — short segment
    const coords: [number, number, number][] = [
      [14.4, 50.0, 100],
      [14.4001, 50.0001, 200],
    ];
    const profile = computeElevationProfile(coords);

    // At ~50°N, 0.0001° lat ≈ 11.1 m, 0.0001° lon ≈ 7.2 m
    // Euclidean approximation: sqrt(11.1² + 7.2²) ≈ 13.2 m
    // Haversine should be very close
    expect(profile[1].distance).toBeGreaterThan(10);
    expect(profile[1].distance).toBeLessThan(20);
  });
});

// ---------------------------------------------------------------------------
// smoothElevationProfile
// ---------------------------------------------------------------------------

describe('smoothElevationProfile', () => {
  it('returns copy for short profiles (< 3 points)', () => {
    const profile = [
      { distance: 0, elevation: 100 },
      { distance: 50, elevation: 110 },
    ];
    const smoothed = smoothElevationProfile(profile);
    expect(smoothed).toHaveLength(2);
    expect(smoothed[0].elevation).toBe(100);
    expect(smoothed[1].elevation).toBe(110);
  });

  it('does not alter distances', () => {
    const profile = [
      { distance: 0, elevation: 100 },
      { distance: 30, elevation: 120 },
      { distance: 60, elevation: 110 },
      { distance: 90, elevation: 130 },
    ];
    const smoothed = smoothElevationProfile(profile);
    smoothed.forEach((point, index) => {
      expect(point.distance).toBe(profile[index].distance);
    });
  });

  it('reduces noise in sawtooth pattern', () => {
    // Simulate SRTM jitter: ±5m noise around 200m baseline
    const profile = Array.from({ length: 20 }, (_, i) => ({
      distance: i * 10,
      elevation: 200 + (i % 2 === 0 ? 5 : -5),
    }));
    const smoothed = smoothElevationProfile(profile);

    // Raw range: 195-205 (10m spread)
    // Smoothed should be much tighter — within ±2m of 200
    const rawRange = Math.max(...profile.map((p) => p.elevation))
      - Math.min(...profile.map((p) => p.elevation));
    const smoothedRange = Math.max(...smoothed.map((p) => p.elevation))
      - Math.min(...smoothed.map((p) => p.elevation));
    expect(smoothedRange).toBeLessThan(rawRange / 2);
  });

  it('preserves real climbs after smoothing', () => {
    // A genuine 100m climb over 500m distance
    const profile = Array.from({ length: 11 }, (_, i) => ({
      distance: i * 50,
      elevation: 200 + i * 10, // 200 → 300
    }));
    const smoothed = smoothElevationProfile(profile);
    // Start and end should be close to original values
    expect(Math.abs(smoothed[0].elevation - 200)).toBeLessThan(15);
    expect(Math.abs(smoothed[10].elevation - 300)).toBeLessThan(15);
  });
});

// ---------------------------------------------------------------------------
// computeElevationGainLoss
// ---------------------------------------------------------------------------

describe('computeElevationGainLoss', () => {
  it('returns zero for empty or single-point profiles', () => {
    expect(computeElevationGainLoss([])).toEqual({ gain: 0, loss: 0 });
    expect(computeElevationGainLoss([{ distance: 0, elevation: 100 }])).toEqual({
      gain: 0,
      loss: 0,
    });
  });

  it('computes simple monotonic climb', () => {
    const profile = [
      { distance: 0, elevation: 100 },
      { distance: 100, elevation: 150 },
      { distance: 200, elevation: 200 },
    ];
    const { gain, loss } = computeElevationGainLoss(profile);
    expect(gain).toBe(100);
    expect(loss).toBe(0);
  });

  it('computes simple monotonic descent', () => {
    const profile = [
      { distance: 0, elevation: 300 },
      { distance: 100, elevation: 200 },
      { distance: 200, elevation: 100 },
    ];
    const { gain, loss } = computeElevationGainLoss(profile);
    expect(gain).toBe(0);
    expect(loss).toBe(200);
  });

  it('ignores sub-threshold noise (DEM jitter)', () => {
    // ±0.5m oscillation around 200m baseline — delta of 1m between points, below 1.5m threshold
    const profile = Array.from({ length: 20 }, (_, i) => ({
      distance: i * 10,
      elevation: 200 + (i % 2 === 0 ? 0.5 : -0.5),
    }));
    const { gain, loss } = computeElevationGainLoss(profile);
    expect(gain).toBe(0);
    expect(loss).toBe(0);
  });

  it('accumulates real climb across multiple sub-threshold steps', () => {
    // Gradual 5m climb in 0.5m steps — each step is sub-threshold but total is real
    const profile = Array.from({ length: 11 }, (_, i) => ({
      distance: i * 10,
      elevation: 200 + i * 0.5, // 200 → 205
    }));
    const { gain, loss } = computeElevationGainLoss(profile, 1.5);
    // After 4 steps (2m), the threshold is crossed — gain should be ~5m
    expect(gain).toBeGreaterThan(3);
    expect(gain).toBeLessThan(6);
    expect(loss).toBe(0);
  });

  it('counts a hill + valley correctly', () => {
    const profile = [
      { distance: 0, elevation: 100 },
      { distance: 100, elevation: 200 },
      { distance: 200, elevation: 150 },
      { distance: 300, elevation: 250 },
    ];
    const { gain, loss } = computeElevationGainLoss(profile);
    // Climb 100→200 (+100), descend 200→150 (-50), climb 150→250 (+100)
    expect(gain).toBe(200);
    expect(loss).toBe(50);
  });
});
