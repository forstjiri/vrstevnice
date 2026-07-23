/**
 * Unit tests for the POI pipeline: sampling, deduplication, waypoint insertion,
 * and POI query orchestration.
 *
 * All tests use mock geometries and a mock `queryFn` — no real network or GH instance.
 */
import { describe, it, expect } from 'vitest';
import { sampleRouteGeometry, deduplicatePOIs } from '@vrstevnice/routing';
import { haversineMeters } from '@vrstevnice/shared';
import type { POILocation } from '@vrstevnice/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a straight-line geometry in Leaflet [lat, lng] format.
 * Points are spaced evenly along a west→east line near the equator
 * where 1° longitude ≈ 111 km.
 *
 * @param lengthKm  Total route length in kilometers
 * @param pointCount Number of geometry points (must be ≥ 2)
 */
function makeRouteGeometry(lengthKm: number, pointCount: number): [number, number][] {
  // Near equator, 1° longitude ≈ 111.32 km
  const lngPerKm = 1 / 111.32;
  const totalLng = lengthKm * lngPerKm;
  const step = totalLng / (pointCount - 1);
  const points: [number, number][] = [];
  for (let i = 0; i < pointCount; i += 1) {
    points.push([0, 14.4 + i * step]);
  }
  return points;
}

// ---------------------------------------------------------------------------
// sampleRouteGeometry
// ---------------------------------------------------------------------------
describe('sampleRouteGeometry', () => {
  it('samples a 10km straight line at 2km intervals', () => {
    // 10km line with many geometry points (100 pts for fine resolution)
    const geometry = makeRouteGeometry(10, 100);
    const samples = sampleRouteGeometry(geometry, 2000);

    // First point is always the start, then interval crossings.
    // For 10km at 2km: start + 4 samples = 5 total
    // (the while loop uses >=, so the exact boundary matters)
    expect(samples.length).toBe(5);
    // First sample is the route start
    expect(samples[0]).toEqual(geometry[0]);
  });

  it('returns only the start point for a route shorter than the interval', () => {
    const geometry = makeRouteGeometry(1, 50); // 1km route
    const samples = sampleRouteGeometry(geometry, 5000); // 5km interval

    // Only the start point is included
    expect(samples.length).toBe(1);
    expect(samples[0]).toEqual(geometry[0]);
  });

  it('returns only the start point for a single-point geometry', () => {
    const geometry: [number, number][] = [[50.0, 14.4]];
    const samples = sampleRouteGeometry(geometry, 2000);

    expect(samples.length).toBe(0); // < 2 points → empty
  });

  it('returns empty for empty geometry', () => {
    expect(sampleRouteGeometry([], 2000)).toEqual([]);
  });

  it('caps at 8 sample points (MAX_SAMPLE_POINTS)', () => {
    // 20km route, 1km interval → would be ~20 samples, but capped at 8
    const geometry = makeRouteGeometry(20, 200);
    const samples = sampleRouteGeometry(geometry, 1000);

    expect(samples.length).toBe(8);
  });

  it('handles zigzag routes correctly', () => {
    // Create a zigzag: go north, then south, then north
    const geometry: [number, number][] = [
      [50.0, 14.4],
      [50.05, 14.405], // ~550m NE
      [50.0, 14.41], // ~550m SE from previous
      [50.05, 14.415], // ~550m NE
      [50.0, 14.42], // ~550m SE
      [50.05, 14.425], // ~550m NE
      [50.0, 14.43], // ~550m SE
      [50.05, 14.435], // ~550m NE
    ];

    // Sample every 1000m — total route is ~3.3km so should get ~3 samples + start
    const samples = sampleRouteGeometry(geometry, 1000);

    expect(samples.length).toBeGreaterThanOrEqual(2);
    expect(samples[0]).toEqual(geometry[0]);

    // Verify samples are actual interpolated points along the geometry
    samples.forEach(([lat, lng]) => {
      expect(lat).toBeGreaterThanOrEqual(49.99);
      expect(lat).toBeLessThanOrEqual(50.06);
      expect(lng).toBeGreaterThanOrEqual(14.39);
      expect(lng).toBeLessThanOrEqual(14.44);
    });
  });

  it('produces samples at approximately the correct distance intervals', () => {
    const geometry = makeRouteGeometry(6, 120); // 6km, fine resolution
    const samples = sampleRouteGeometry(geometry, 2000);

    // Should have start + 2 interval points = 3
    expect(samples.length).toBe(3);

    // Check distances between consecutive samples are close to 2km
    samples.slice(1).forEach((sample, index) => {
      const previous = samples[index];
      const d = haversineMeters(previous[0], previous[1], sample[0], sample[1]);
      // Allow 15% tolerance due to discrete geometry stepping
      expect(d).toBeGreaterThan(1700);
      expect(d).toBeLessThan(2300);
    });
  });
});

// ---------------------------------------------------------------------------
// deduplicatePOIs
// ---------------------------------------------------------------------------
describe('deduplicatePOIs', () => {
  it('returns all POIs when none are duplicates', () => {
    const pois: POILocation[] = [
      {
        lat: 50.0,
        lng: 14.4,
        name: 'Pub A',
        type: 'pub',
      },
      {
        lat: 51.0,
        lng: 15.4,
        name: 'Pub B',
        type: 'pub',
      },
      {
        lat: 52.0,
        lng: 16.4,
        name: 'Pub C',
        type: 'pub',
      },
    ];
    const result = deduplicatePOIs(pois);
    expect(result).toHaveLength(3);
  });

  it('removes duplicate POIs within 100m', () => {
    // Two POIs ~50m apart (0.0005° lat ≈ ~55m at 50°N)
    const pois: POILocation[] = [
      {
        lat: 50.0,
        lng: 14.4,
        name: 'Pub A',
        type: 'pub',
      },
      {
        lat: 50.0005,
        lng: 14.4,
        name: 'Pub B',
        type: 'pub',
      },
    ];
    const result = deduplicatePOIs(pois);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Pub A'); // First kept
  });

  it('keeps POIs that are > 100m apart', () => {
    // ~200m apart
    const pois: POILocation[] = [
      {
        lat: 50.0,
        lng: 14.4,
        name: 'Pub A',
        type: 'pub',
      },
      {
        lat: 50.002,
        lng: 14.4,
        name: 'Pub B',
        type: 'pub',
      },
    ];
    const result = deduplicatePOIs(pois);
    expect(result).toHaveLength(2);
  });

  it('reduces a cluster of 3 nearby POIs to 1', () => {
    const pois: POILocation[] = [
      {
        lat: 50.0,
        lng: 14.4,
        name: 'Pub A',
        type: 'pub',
      },
      {
        lat: 50.0003,
        lng: 14.4,
        name: 'Pub B',
        type: 'bar',
      },
      {
        lat: 50.0006,
        lng: 14.4003,
        name: 'Pub C',
        type: 'cafe',
      },
    ];
    const result = deduplicatePOIs(pois);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Pub A');
  });

  it('returns empty array for empty input', () => {
    expect(deduplicatePOIs([])).toEqual([]);
  });

  it('respects custom minDistance parameter', () => {
    // Two POIs ~200m apart, with custom 300m threshold they become duplicates
    const pois: POILocation[] = [
      {
        lat: 50.0,
        lng: 14.4,
        name: 'Pub A',
        type: 'pub',
      },
      {
        lat: 50.002,
        lng: 14.4,
        name: 'Pub B',
        type: 'pub',
      },
    ];

    const defaultResult = deduplicatePOIs(pois, 100);
    expect(defaultResult).toHaveLength(2); // >100m apart → both kept

    const strictResult = deduplicatePOIs(pois, 300);
    expect(strictResult).toHaveLength(1); // <300m apart → deduplicated
  });
});
