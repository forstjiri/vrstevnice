import { describe, it, expect } from 'vitest';
import {
  SURFACE_COLORS,
  DEFAULT_SURFACE_COLOR,
  SURFACE_LABELS,
  ROAD_CLASS_COLORS,
  DEFAULT_ROAD_CLASS_COLOR,
  ROAD_CLASS_DASH,
  ROAD_CLASS_LABELS,
} from '@vrstevnice/fe/chart-constants';

describe('SURFACE_COLORS', () => {
  it('has color for every surface label', () => {
    Object.keys(SURFACE_LABELS).forEach((key) => {
      expect(SURFACE_COLORS[key], `missing color for surface "${key}"`).toBeDefined();
    });
  });

  it('has a default color defined', () => {
    expect(DEFAULT_SURFACE_COLOR).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('all colors are valid hex', () => {
    Object.entries(SURFACE_COLORS).forEach(([key, color]) => {
      expect(color, `${key}: "${color}" is not valid hex`).toMatch(/^#[0-9a-f]{6}$/);
    });
  });
});

describe('SURFACE_LABELS', () => {
  const REAL_VALUES = [
    'asphalt',
    'concrete',
    'paving_stones',
    'cobblestone',
    'gravel',
    'fine_gravel',
    'compacted',
    'cycleway',
    'track',
    'trail',
    'ground',
    'dirt',
    'unpaved',
    'paved',
    'grass',
    'sand',
  ];

  it('has a Czech label for every real GraphHopper surface value', () => {
    REAL_VALUES.forEach((surface) => {
      expect(SURFACE_LABELS[surface], `missing label for "${surface}"`).toBeTruthy();
    });
  });

  it('labels are non-empty strings', () => {
    Object.values(SURFACE_LABELS).forEach((label) => {
      expect(typeof label).toBe('string');
      expect(label.length).toBeGreaterThan(0);
    });
  });
});

describe('ROAD_CLASS_COLORS', () => {
  const GH_VALUES = [
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
    'other',
  ];

  it('has a color for every real GraphHopper road_class value', () => {
    GH_VALUES.forEach((cls) => {
      expect(ROAD_CLASS_COLORS[cls], `missing color for road_class "${cls}"`).toBeDefined();
    });
  });

  it('cycleway is pink', () => {
    expect(ROAD_CLASS_COLORS.cycleway).toBe('#ec4899');
  });

  it('path is brown', () => {
    expect(ROAD_CLASS_COLORS.path).toBe('#92400e');
  });

  it('all colors are valid hex', () => {
    Object.entries(ROAD_CLASS_COLORS).forEach(([key, color]) => {
      expect(color, `${key}: "${color}" is not valid hex`).toMatch(/^#[0-9a-f]{6}$/);
    });
  });

  it('has a default color defined', () => {
    expect(DEFAULT_ROAD_CLASS_COLOR).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('ROAD_CLASS_DASH', () => {
  it('path is dashed', () => {
    expect(ROAD_CLASS_DASH.path).toEqual([4, 3]);
  });

  it('cycleway is dashed', () => {
    expect(ROAD_CLASS_DASH.cycleway).toEqual([6, 3]);
  });

  it('track is solid (undefined)', () => {
    expect(ROAD_CLASS_DASH.track).toBeUndefined();
  });

  it('unknown entries return undefined (fallback to solid)', () => {
    expect(ROAD_CLASS_DASH.nonexistent).toBeUndefined();
  });
});

describe('ROAD_CLASS_LABELS', () => {
  it('has a Czech label for every road_class color', () => {
    Object.keys(ROAD_CLASS_COLORS).forEach((key) => {
      expect(ROAD_CLASS_LABELS[key], `missing label for road_class "${key}"`).toBeTruthy();
    });
  });

  it('labels are non-empty strings', () => {
    Object.values(ROAD_CLASS_LABELS).forEach((label) => {
      expect(typeof label).toBe('string');
      expect(label.length).toBeGreaterThan(0);
    });
  });
});
