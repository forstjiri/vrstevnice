import { describe, it, expect } from 'vitest';
import { parseSurfaceSegments } from '@vrstevnice/routing';

describe('parseSurfaceSegments', () => {
  it('parses valid surface detail triples into SurfaceSegment[]', () => {
    const details = {
      surface: [
        [0, 15, 'asphalt'],
        [15, 30, 'gravel'],
        [30, 45, 'unpaved'],
      ],
    };

    const result = parseSurfaceSegments(details);

    expect(result).toEqual([
      { from: 0, to: 15, surface: 'asphalt' },
      { from: 15, to: 30, surface: 'gravel' },
      { from: 30, to: 45, surface: 'unpaved' },
    ]);
  });

  it('returns empty array when details is undefined', () => {
    expect(parseSurfaceSegments(undefined)).toEqual([]);
  });

  it('returns empty array when details is an empty object', () => {
    expect(parseSurfaceSegments({})).toEqual([]);
  });

  it('returns empty array when surface array is empty', () => {
    expect(parseSurfaceSegments({ surface: [] })).toEqual([]);
  });

  it('returns empty array when details is null', () => {
    expect(parseSurfaceSegments(null as any)).toEqual([]);
  });

  it('skips malformed entries (non-array entries)', () => {
    const details = {
      surface: ['not-an-array', [0, 10, 'asphalt'], 42, [10, 20, 'gravel']],
    };

    const result = parseSurfaceSegments(details);

    expect(result).toEqual([
      { from: 0, to: 10, surface: 'asphalt' },
      { from: 10, to: 20, surface: 'gravel' },
    ]);
  });

  it('skips entries with wrong types (non-number indices, non-string surface)', () => {
    const details = {
      surface: [
        ['0', 10, 'asphalt'], // from is string, not number
        [0, '10', 'asphalt'], // to is string, not number
        [0, 10, 42], // surface is number, not string
        [0, 5, 'concrete'], // valid
        [5, 10], // too short (no surface value)
      ],
    };

    const result = parseSurfaceSegments(details);

    expect(result).toEqual([{ from: 0, to: 5, surface: 'concrete' }]);
  });

  it('ignores extra elements in triples (uses first three)', () => {
    const details = {
      surface: [[0, 10, 'asphalt', 'extra', 99]],
    };

    const result = parseSurfaceSegments(details);

    expect(result).toEqual([{ from: 0, to: 10, surface: 'asphalt' }]);
  });

  it('handles real-world surface values from GraphHopper', () => {
    const details = {
      surface: [
        [0, 3, 'paving_stones'],
        [3, 12, 'asphalt'],
        [12, 15, 'compacted'],
        [15, 25, 'fine_gravel'],
        [25, 30, 'ground'],
      ],
    };

    const result = parseSurfaceSegments(details);

    expect(result).toHaveLength(5);
    expect(result[0]).toEqual({ from: 0, to: 3, surface: 'paving_stones' });
    expect(result[2]).toEqual({ from: 12, to: 15, surface: 'compacted' });
    expect(result[4]).toEqual({ from: 25, to: 30, surface: 'ground' });
  });
});
