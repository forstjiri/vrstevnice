import { describe, it, expect } from 'vitest';
import { haversineMeters, computeGeometryDistances, EARTH_RADIUS_M } from '@vrstevnice/shared';

describe('EARTH_RADIUS_M', () => {
  it('is the standard Earth radius in meters', () => {
    expect(EARTH_RADIUS_M).toBe(6_371_000);
  });
});

describe('haversineMeters', () => {
  it('returns 0 for identical points', () => {
    expect(haversineMeters(50.08, 14.42, 50.08, 14.42)).toBe(0);
  });

  it('returns ~111 195 m for 1° latitude difference at equator', () => {
    const d = haversineMeters(0, 0, 1, 0);
    // 1° of latitude ≈ 111 195 m; tolerate ±50 m
    expect(d).toBeGreaterThan(111_100);
    expect(d).toBeLessThan(111_300);
  });

  it('gives ~185 km for Praha → Brno', () => {
    // Praha: 50.0755, 14.4378  Brno: 49.1951, 16.6068
    const d = haversineMeters(50.0755, 14.4378, 49.1951, 16.6068);
    // Real distance ≈ 185 km; tolerate ±5 km
    expect(d).toBeGreaterThan(180_000);
    expect(d).toBeLessThan(190_000);
  });

  it('is symmetric', () => {
    const d1 = haversineMeters(50, 14, 49, 16);
    const d2 = haversineMeters(49, 16, 50, 14);
    expect(d1).toBe(d2);
  });
});

describe('computeGeometryDistances', () => {
  it('returns [0] for a single point', () => {
    expect(computeGeometryDistances([[50, 14]])).toEqual([0]);
  });

  it('returns [0, d] for two known points', () => {
    // Two points: Praha → Brno
    const geometry: [number, number][] = [
      [50.0755, 14.4378],
      [49.1951, 16.6068],
    ];
    const dists = computeGeometryDistances(geometry);
    expect(dists).toHaveLength(2);
    expect(dists[0]).toBe(0);
    // Second value should match direct haversine
    expect(dists[1]).toBeCloseTo(haversineMeters(50.0755, 14.4378, 49.1951, 16.6068), -1);
  });

  it('cumulative distances are strictly non-decreasing', () => {
    const geometry: [number, number][] = [
      [50.0, 14.0],
      [50.1, 14.1],
      [49.9, 14.2],
      [49.8, 14.3],
    ];
    const dists = computeGeometryDistances(geometry);
    dists.slice(1).forEach((distance, index) => {
      expect(distance).toBeGreaterThanOrEqual(dists[index]);
    });
    // First value must be 0
    expect(dists[0]).toBe(0);
  });

  it('handles empty array', () => {
    expect(computeGeometryDistances([])).toEqual([0]);
  });
});
