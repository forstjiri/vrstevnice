/**
 * Unit tests for computeElevationProfile().
 *
 * Uses synthetic coordinate data — no GraphHopper container required.
 */

import { describe, it, expect } from 'vitest'
import { computeElevationProfile } from '@vrstevnice/routing'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Known haversine distance for ~1° of latitude at the equator: ~111 195 m */
const DEG_LAT_M = 111_195

/** Roughly 1° longitude at 50°N latitude: ~71 700 m */
const DEG_LON_50N_M = 71_700

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeElevationProfile', () => {
  it('returns empty array for empty input', () => {
    expect(computeElevationProfile([])).toEqual([])
  })

  it('returns single point with distance 0 for one coordinate', () => {
    const coords: [number, number, number][] = [[14.4, 50.1, 200]]
    const profile = computeElevationProfile(coords)

    expect(profile).toHaveLength(1)
    expect(profile[0].distance).toBe(0)
    expect(profile[0].elevation).toBe(200)
  })

  it('computes cumulative distance along a straight north-south line', () => {
    // Two points ~1° apart in latitude (same longitude)
    const coords: [number, number, number][] = [
      [14.4, 50.0, 200],
      [14.4, 51.0, 350],
    ]
    const profile = computeElevationProfile(coords)

    expect(profile).toHaveLength(2)
    expect(profile[0]).toEqual({ distance: 0, elevation: 200 })

    // Distance should be ~DEG_LAT_M (≈111 km)
    expect(profile[1].distance).toBeCloseTo(DEG_LAT_M, -3) // within 1 km
    expect(profile[1].elevation).toBe(350)
  })

  it('computes cumulative distance for three points', () => {
    const coords: [number, number, number][] = [
      [14.4, 50.0, 200],
      [14.4, 50.5, 300],
      [15.4, 50.5, 250],
    ]
    const profile = computeElevationProfile(coords)

    expect(profile).toHaveLength(3)
    // First point: distance = 0
    expect(profile[0].distance).toBe(0)

    // Second point: ~0.5° latitude ≈ 55 km
    const seg1 = profile[1].distance
    expect(seg1).toBeCloseTo(DEG_LAT_M * 0.5, -3)

    // Third point: seg1 + ~1° longitude at ~50.25°N
    // The actual haversine for 1° lon at 50.25°N is ~71.3 km (cos(50.25°) * 111.2 km)
    const seg2 = profile[2].distance - seg1
    expect(seg2).toBeGreaterThan(60_000)  // at least 60 km
    expect(seg2).toBeLessThan(80_000)    // at most 80 km

    // Third point cumulative distance should be greater than second
    expect(profile[2].distance).toBeGreaterThan(profile[1].distance)
  })

  it('skips coordinates with undefined/null elevation', () => {
    const coords: [number, number, number][] = [
      [14.4, 50.0, 200],
      [14.4, 50.5, undefined as unknown as number],
      [14.4, 51.0, 350],
    ]
    const profile = computeElevationProfile(coords)

    expect(profile).toHaveLength(2)
    expect(profile[0].elevation).toBe(200)
    expect(profile[1].elevation).toBe(350)
  })

  it('skips coordinates with NaN elevation', () => {
    const coords: [number, number, number][] = [
      [14.4, 50.0, 200],
      [14.4, 50.5, NaN],
      [14.4, 51.0, 350],
    ]
    const profile = computeElevationProfile(coords)

    expect(profile).toHaveLength(2)
  })

  it('returns empty array when all coordinates have invalid elevation', () => {
    const coords: [number, number, number][] = [
      [14.4, 50.0, NaN],
      [14.4, 51.0, undefined as unknown as number],
    ]
    expect(computeElevationProfile(coords)).toEqual([])
  })

  it('handles a realistic small elevation profile', () => {
    // Coordinates around Prague: gradually increasing elevation
    const coords: [number, number, number][] = [
      [14.42, 50.08, 180],
      [14.43, 50.09, 195],
      [14.44, 50.10, 210],
      [14.45, 50.10, 225],
      [14.46, 50.11, 200],
    ]
    const profile = computeElevationProfile(coords)

    expect(profile).toHaveLength(5)

    // Distances should be monotonically increasing
    for (let i = 1; i < profile.length; i++) {
      expect(profile[i].distance).toBeGreaterThan(profile[i - 1].distance)
    }

    // Elevation should rise then fall
    expect(profile[3].elevation).toBe(225) // peak
    expect(profile[4].elevation).toBe(200) // drop
  })

  it('produces the same results as manual haversine calculation', () => {
    // Two very close points — short segment
    const coords: [number, number, number][] = [
      [14.40000, 50.00000, 100],
      [14.40010, 50.00010, 200],
    ]
    const profile = computeElevationProfile(coords)

    // At ~50°N, 0.0001° lat ≈ 11.1 m, 0.0001° lon ≈ 7.2 m
    // Euclidean approximation: sqrt(11.1² + 7.2²) ≈ 13.2 m
    // Haversine should be very close
    expect(profile[1].distance).toBeGreaterThan(10)
    expect(profile[1].distance).toBeLessThan(20)
  })
})
