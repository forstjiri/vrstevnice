import { describe, it, expect } from 'vitest';
import { binarySearchSegment, hexToRgba } from '@vrstevnice/fe/chart-constants';

describe('binarySearchSegment', () => {
  it('finds segment when distance is within range', () => {
    const starts = [0, 100, 300, 500];
    const ends = [100, 300, 500, 800];
    expect(binarySearchSegment(starts, ends, 50)).toBe(0);
    expect(binarySearchSegment(starts, ends, 200)).toBe(1);
    expect(binarySearchSegment(starts, ends, 400)).toBe(2);
    expect(binarySearchSegment(starts, ends, 700)).toBe(3);
  });

  it('finds exact boundary points', () => {
    const starts = [0, 100, 300];
    const ends = [100, 300, 500];
    expect(binarySearchSegment(starts, ends, 0)).toBe(0);
    expect(binarySearchSegment(starts, ends, 100)).toBe(1); // boundary: matches second segment
    expect(binarySearchSegment(starts, ends, 150)).toBe(1); // middle of second
    expect(binarySearchSegment(starts, ends, 300)).toBe(1); // boundary: matches second
    expect(binarySearchSegment(starts, ends, 400)).toBe(2); // middle of third
    expect(binarySearchSegment(starts, ends, 500)).toBe(2); // boundary: matches third
  });

  it('returns -1 when distance is before first segment', () => {
    const starts = [100, 300];
    const ends = [300, 500];
    expect(binarySearchSegment(starts, ends, 50)).toBe(-1);
  });

  it('returns -1 when distance is after last segment', () => {
    const starts = [0, 100];
    const ends = [100, 300];
    expect(binarySearchSegment(starts, ends, 400)).toBe(-1);
  });

  it('returns -1 for empty segments', () => {
    expect(binarySearchSegment([], [], 0)).toBe(-1);
  });

  it('handles single segment', () => {
    const starts = [0];
    const ends = [1000];
    expect(binarySearchSegment(starts, ends, 0)).toBe(0);
    expect(binarySearchSegment(starts, ends, 500)).toBe(0);
    expect(binarySearchSegment(starts, ends, 1000)).toBe(0);
    expect(binarySearchSegment(starts, ends, 1001)).toBe(-1);
  });

  it('handles segments with gaps', () => {
    // Realistic: some GH detail values have gaps between segments
    const starts = [0, 50, 200];
    const ends = [50, 100, 400];
    expect(binarySearchSegment(starts, ends, 75)).toBe(1);
    expect(binarySearchSegment(starts, ends, 150)).toBe(-1); // gap: 100–200
    expect(binarySearchSegment(starts, ends, 300)).toBe(2);
  });

  it('is O(log n) — works with many segments', () => {
    const n = 1000;
    const starts = Array.from({ length: n }, (_, i) => i * 100);
    const ends = Array.from({ length: n }, (_, i) => (i + 1) * 100);

    // Test a few points spread across the range
    expect(binarySearchSegment(starts, ends, 0)).toBe(0);
    expect(binarySearchSegment(starts, ends, 50_000)).toBe(499); // mid-range
    expect(binarySearchSegment(starts, ends, 99_999)).toBe(999); // last point
    expect(binarySearchSegment(starts, ends, 100_000)).toBe(999); // inclusive end of last
    expect(binarySearchSegment(starts, ends, 100_001)).toBe(-1);
  });
});

describe('hexToRgba', () => {
  it('converts black with full alpha', () => {
    expect(hexToRgba('#000000', 1)).toBe('rgba(0, 0, 0, 1)');
  });

  it('converts white with zero alpha', () => {
    expect(hexToRgba('#ffffff', 0)).toBe('rgba(255, 255, 255, 0)');
  });

  it('converts a real color with fractional alpha', () => {
    expect(hexToRgba('#ec4899', 0.35)).toBe('rgba(236, 72, 153, 0.35)');
  });

  it('converts the surface gray color', () => {
    expect(hexToRgba('#9ca3af', 0.35)).toBe('rgba(156, 163, 175, 0.35)');
  });

  it('converts cycleway pink', () => {
    expect(hexToRgba('#ec4899', 1)).toBe('rgba(236, 72, 153, 1)');
  });
});
