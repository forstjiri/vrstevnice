import { describe, it, expect } from 'vitest';
import { parseRoadClassSegments, parseSurfaceSegments } from '@vrstevnice/routing';

describe('parseRoadClassSegments', () => {
  it('parses real GraphHopper road_class values (lowercase)', () => {
    const details = {
      road_class: [
        [0, 8, 'track'],
        [8, 13, 'unclassified'],
        [13, 21, 'track'],
        [21, 33, 'residential'],
        [33, 39, 'tertiary'],
      ],
    };

    const result = parseRoadClassSegments(details);

    expect(result).toEqual([
      { from: 0, to: 8, roadClass: 'track' },
      { from: 8, to: 13, roadClass: 'unclassified' },
      { from: 13, to: 21, roadClass: 'track' },
      { from: 21, to: 33, roadClass: 'residential' },
      { from: 33, to: 39, roadClass: 'tertiary' },
    ]);
  });

  it('parses cycleway as a road_class value', () => {
    const details = {
      road_class: [
        [0, 10, 'cycleway'],
        [10, 25, 'residential'],
        [25, 30, 'cycleway'],
      ],
    };

    const result = parseRoadClassSegments(details);

    expect(result).toEqual([
      { from: 0, to: 10, roadClass: 'cycleway' },
      { from: 10, to: 25, roadClass: 'residential' },
      { from: 25, to: 30, roadClass: 'cycleway' },
    ]);
  });

  it('parses all GH bike-relevant road classes', () => {
    // Real values from GH bike profile response
    const classes = [
      'motorway',
      'trunk',
      'primary',
      'secondary',
      'tertiary',
      'residential',
      'living_street',
      'unclassified',
      'service',
      'track',
      'path',
      'cycleway',
      'steps',
      'ferry',
    ];

    const triples = classes.map(
      (cls, i) => [i * 10, (i + 1) * 10, cls] as [number, number, string],
    );

    const result = parseRoadClassSegments({ road_class: triples });

    expect(result).toHaveLength(classes.length);
    result.forEach((segment, index) => {
      expect(segment.roadClass).toBe(classes[index]);
      expect(segment.from).toBe(index * 10);
      expect(segment.to).toBe((index + 1) * 10);
    });
  });

  it('returns empty for undefined details', () => {
    expect(parseRoadClassSegments(undefined)).toEqual([]);
  });

  it('returns empty for missing road_class key', () => {
    expect(parseRoadClassSegments({ surface: [[0, 10, 'asphalt']] })).toEqual([]);
  });

  it('returns empty for empty array', () => {
    expect(parseRoadClassSegments({ road_class: [] })).toEqual([]);
  });

  it('skips malformed entries', () => {
    const details = {
      road_class: ['not-array', [0, 10, 'track'], 42, [10, 20, 'path']],
    };

    const result = parseRoadClassSegments(details);

    expect(result).toEqual([
      { from: 0, to: 10, roadClass: 'track' },
      { from: 10, to: 20, roadClass: 'path' },
    ]);
  });

  it('preserves real-world segment gaps (non-contiguous indices)', () => {
    // GH may return segments with gaps when detail values change at specific points
    const details = {
      road_class: [
        [0, 5, 'track'],
        [8, 15, 'residential'], // gap: 5–8 not covered
        [20, 30, 'cycleway'], // gap: 15–20
      ],
    };

    const result = parseRoadClassSegments(details);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ from: 0, to: 5, roadClass: 'track' });
    expect(result[1]).toEqual({ from: 8, to: 15, roadClass: 'residential' });
    expect(result[2]).toEqual({ from: 20, to: 30, roadClass: 'cycleway' });
  });
});

describe('parseSurfaceSegments and parseRoadClassSegments use same triple format', () => {
  it('produce consistent segment shapes', () => {
    const details = {
      surface: [
        [0, 10, 'asphalt'],
        [10, 20, 'gravel'],
      ],
      road_class: [
        [0, 10, 'residential'],
        [10, 20, 'track'],
      ],
    };

    const surfaces = parseSurfaceSegments(details);
    const roadClasses = parseRoadClassSegments(details);

    // Both have same structure: { from, to, <value> }
    expect(surfaces).toHaveLength(2);
    expect(roadClasses).toHaveLength(2);

    // Segment boundaries should match in this simple case
    expect(surfaces[0].from).toBe(roadClasses[0].from);
    expect(surfaces[0].to).toBe(roadClasses[0].to);
  });
});
