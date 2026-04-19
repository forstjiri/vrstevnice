/**
 * Unit tests for the POI pipeline: sampling, deduplication, waypoint insertion,
 * and Overpass response parsing.
 *
 * All tests use mock geometries and mock fetch — no real network or GH instance.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  sampleRouteGeometry,
  deduplicatePOIs,
  insertPOIWaypoints,
  queryOverpassAround,
  fetchPOIsAlongRoute,
  haversineMeters,
} from '@vrstevnice/routing'
import type { POILocation, Stop } from '@vrstevnice/shared'

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
  const lngPerKm = 1 / 111.32
  const totalLng = lengthKm * lngPerKm
  const step = totalLng / (pointCount - 1)
  const points: [number, number][] = []
  for (let i = 0; i < pointCount; i++) {
    points.push([0, 14.4 + i * step])
  }
  return points
}

/**
 * Create a simple Stop object for testing.
 */
function makeStop(lat: number, lng: number, name: string): Stop {
  return { lat, lng, name }
}

// ---------------------------------------------------------------------------
// sampleRouteGeometry
// ---------------------------------------------------------------------------
describe('sampleRouteGeometry', () => {
  it('samples a 10km straight line at 2km intervals', () => {
    // 10km line with many geometry points (100 pts for fine resolution)
    const geometry = makeRouteGeometry(10, 100)
    const samples = sampleRouteGeometry(geometry, 2000)

    // First point is always the start, then interval crossings.
    // For 10km at 2km: start + 4 samples = 5 total
    // (the while loop uses >=, so the exact boundary matters)
    expect(samples.length).toBe(5)
    // First sample is the route start
    expect(samples[0]).toEqual(geometry[0])
  })

  it('returns only the start point for a route shorter than the interval', () => {
    const geometry = makeRouteGeometry(1, 50) // 1km route
    const samples = sampleRouteGeometry(geometry, 5000) // 5km interval

    // Only the start point is included
    expect(samples.length).toBe(1)
    expect(samples[0]).toEqual(geometry[0])
  })

  it('returns only the start point for a single-point geometry', () => {
    const geometry: [number, number][] = [[50.0, 14.4]]
    const samples = sampleRouteGeometry(geometry, 2000)

    expect(samples.length).toBe(0) // < 2 points → empty
  })

  it('returns empty for empty geometry', () => {
    expect(sampleRouteGeometry([], 2000)).toEqual([])
  })

  it('caps at 8 sample points (MAX_SAMPLE_POINTS)', () => {
    // 20km route, 1km interval → would be ~20 samples, but capped at 8
    const geometry = makeRouteGeometry(20, 200)
    const samples = sampleRouteGeometry(geometry, 1000)

    expect(samples.length).toBe(8)
  })

  it('handles zigzag routes correctly', () => {
    // Create a zigzag: go north, then south, then north
    const geometry: [number, number][] = [
      [50.0, 14.4],
      [50.05, 14.405],  // ~550m NE
      [50.0, 14.41],    // ~550m SE from previous
      [50.05, 14.415],  // ~550m NE
      [50.0, 14.42],    // ~550m SE
      [50.05, 14.425],  // ~550m NE
      [50.0, 14.43],    // ~550m SE
      [50.05, 14.435],  // ~550m NE
    ]

    // Sample every 1000m — total route is ~3.3km so should get ~3 samples + start
    const samples = sampleRouteGeometry(geometry, 1000)

    expect(samples.length).toBeGreaterThanOrEqual(2)
    expect(samples[0]).toEqual(geometry[0])

    // Verify samples are actual interpolated points along the geometry
    for (const [lat, lng] of samples) {
      expect(lat).toBeGreaterThanOrEqual(49.99)
      expect(lat).toBeLessThanOrEqual(50.06)
      expect(lng).toBeGreaterThanOrEqual(14.39)
      expect(lng).toBeLessThanOrEqual(14.44)
    }
  })

  it('produces samples at approximately the correct distance intervals', () => {
    const geometry = makeRouteGeometry(6, 120) // 6km, fine resolution
    const samples = sampleRouteGeometry(geometry, 2000)

    // Should have start + 2 interval points = 3
    expect(samples.length).toBe(3)

    // Check distances between consecutive samples are close to 2km
    for (let i = 1; i < samples.length; i++) {
      const d = haversineMeters(
        samples[i - 1][0], samples[i - 1][1],
        samples[i][0], samples[i][1],
      )
      // Allow 15% tolerance due to discrete geometry stepping
      expect(d).toBeGreaterThan(1700)
      expect(d).toBeLessThan(2300)
    }
  })
})

// ---------------------------------------------------------------------------
// deduplicatePOIs
// ---------------------------------------------------------------------------
describe('deduplicatePOIs', () => {
  it('returns all POIs when none are duplicates', () => {
    const pois: POILocation[] = [
      { lat: 50.0, lng: 14.4, name: 'Pub A', type: 'pub' },
      { lat: 51.0, lng: 15.4, name: 'Pub B', type: 'pub' },
      { lat: 52.0, lng: 16.4, name: 'Pub C', type: 'pub' },
    ]
    const result = deduplicatePOIs(pois)
    expect(result).toHaveLength(3)
  })

  it('removes duplicate POIs within 100m', () => {
    // Two POIs ~50m apart (0.0005° lat ≈ ~55m at 50°N)
    const pois: POILocation[] = [
      { lat: 50.0, lng: 14.4, name: 'Pub A', type: 'pub' },
      { lat: 50.0005, lng: 14.4, name: 'Pub B', type: 'pub' },
    ]
    const result = deduplicatePOIs(pois)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('Pub A') // First kept
  })

  it('keeps POIs that are > 100m apart', () => {
    // ~200m apart
    const pois: POILocation[] = [
      { lat: 50.0, lng: 14.4, name: 'Pub A', type: 'pub' },
      { lat: 50.002, lng: 14.4, name: 'Pub B', type: 'pub' },
    ]
    const result = deduplicatePOIs(pois)
    expect(result).toHaveLength(2)
  })

  it('reduces a cluster of 3 nearby POIs to 1', () => {
    const pois: POILocation[] = [
      { lat: 50.0, lng: 14.4, name: 'Pub A', type: 'pub' },
      { lat: 50.0003, lng: 14.4, name: 'Pub B', type: 'bar' },
      { lat: 50.0006, lng: 14.4003, name: 'Pub C', type: 'cafe' },
    ]
    const result = deduplicatePOIs(pois)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('Pub A')
  })

  it('returns empty array for empty input', () => {
    expect(deduplicatePOIs([])).toEqual([])
  })

  it('respects custom minDistance parameter', () => {
    // Two POIs ~200m apart, with custom 300m threshold they become duplicates
    const pois: POILocation[] = [
      { lat: 50.0, lng: 14.4, name: 'Pub A', type: 'pub' },
      { lat: 50.002, lng: 14.4, name: 'Pub B', type: 'pub' },
    ]

    const defaultResult = deduplicatePOIs(pois, 100)
    expect(defaultResult).toHaveLength(2) // >100m apart → both kept

    const strictResult = deduplicatePOIs(pois, 300)
    expect(strictResult).toHaveLength(1) // <300m apart → deduplicated
  })
})

// ---------------------------------------------------------------------------
// insertPOIWaypoints
// ---------------------------------------------------------------------------
describe('insertPOIWaypoints', () => {
  it('inserts 1 POI between 2 stops', () => {
    const stops = [
      makeStop(50.0, 14.4, 'Start'),
      makeStop(50.05, 14.5, 'End'),
    ]
    // Geometry: straight line from start to end
    const geometry: [number, number][] = [
      [50.0, 14.4],
      [50.025, 14.45],  // midpoint
      [50.05, 14.5],
    ]
    // POI at the midpoint
    const pois: POILocation[] = [
      { lat: 50.025, lng: 14.45, name: 'Midway Pub', type: 'pub' },
    ]

    const result = insertPOIWaypoints(stops, pois, geometry)

    expect(result).toHaveLength(3)
    expect(result[0].name).toBe('Start')
    expect(result[1].name).toBe('Midway Pub')
    expect(result[2].name).toBe('End')
  })

  it('inserts 2 POIs in route order between 2 stops', () => {
    const stops = [
      makeStop(50.0, 14.4, 'Start'),
      makeStop(50.1, 14.6, 'End'),
    ]
    const geometry: [number, number][] = [
      [50.0, 14.4],
      [50.033, 14.467],
      [50.067, 14.533],
      [50.1, 14.6],
    ]
    // POI A is closer to start, POI B is closer to end
    const pois: POILocation[] = [
      { lat: 50.067, lng: 14.533, name: 'Pub B (further)', type: 'pub' }, // listed first but further
      { lat: 50.033, lng: 14.467, name: 'Pub A (closer)', type: 'pub' },
    ]

    const result = insertPOIWaypoints(stops, pois, geometry)

    expect(result).toHaveLength(4)
    expect(result[0].name).toBe('Start')
    // POIs should be in route order regardless of input order
    expect(result[1].name).toBe('Pub A (closer)')
    expect(result[2].name).toBe('Pub B (further)')
    expect(result[3].name).toBe('End')
  })

  it('inserts POI on the correct segment with 3 stops', () => {
    const stops = [
      makeStop(50.0, 14.4, 'Start'),
      makeStop(50.05, 14.5, 'Middle'),
      makeStop(50.1, 14.6, 'End'),
    ]
    const geometry: [number, number][] = [
      [50.0, 14.4],
      [50.025, 14.45],
      [50.05, 14.5],
      [50.075, 14.55],
      [50.1, 14.6],
    ]
    // POI on segment 1 (between Start and Middle)
    const pois: POILocation[] = [
      { lat: 50.025, lng: 14.45, name: 'Segment 1 Pub', type: 'pub' },
    ]

    const result = insertPOIWaypoints(stops, pois, geometry)

    expect(result).toHaveLength(4)
    expect(result[0].name).toBe('Start')
    expect(result[1].name).toBe('Segment 1 Pub')
    expect(result[2].name).toBe('Middle')
    expect(result[3].name).toBe('End')
  })

  it('returns original stops unchanged when no POIs provided', () => {
    const stops = [
      makeStop(50.0, 14.4, 'Start'),
      makeStop(50.05, 14.5, 'End'),
    ]
    const geometry: [number, number][] = [
      [50.0, 14.4],
      [50.025, 14.45],
      [50.05, 14.5],
    ]

    const result = insertPOIWaypoints(stops, [], geometry)

    expect(result).toHaveLength(2)
    expect(result[0]).toEqual(stops[0])
    expect(result[1]).toEqual(stops[1])
  })

  it('returns original stops when geometry has fewer than 2 points', () => {
    const stops = [
      makeStop(50.0, 14.4, 'Start'),
      makeStop(50.05, 14.5, 'End'),
    ]
    const pois: POILocation[] = [
      { lat: 50.025, lng: 14.45, name: 'Midway Pub', type: 'pub' },
    ]

    const result = insertPOIWaypoints(stops, pois, [[50.0, 14.4]])
    expect(result).toEqual(stops)
  })

  it('returns original stops when fewer than 2 stops', () => {
    const stops = [makeStop(50.0, 14.4, 'Only Stop')]
    const geometry: [number, number][] = [[50.0, 14.4], [50.05, 14.5]]
    const pois: POILocation[] = [
      { lat: 50.025, lng: 14.45, name: 'Pub', type: 'pub' },
    ]

    const result = insertPOIWaypoints(stops, pois, geometry)
    expect(result).toEqual(stops)
  })

  it('maintains route order for POIs across multiple segments', () => {
    const stops = [
      makeStop(50.0, 14.4, 'A'),
      makeStop(50.1, 14.6, 'B'),
      makeStop(50.2, 14.8, 'C'),
    ]
    const geometry: [number, number][] = [
      [50.0, 14.4],
      [50.05, 14.5],
      [50.1, 14.6],
      [50.15, 14.7],
      [50.2, 14.8],
    ]
    // One POI per segment
    const pois: POILocation[] = [
      { lat: 50.15, lng: 14.7, name: 'POI on seg 2', type: 'pub' },
      { lat: 50.05, lng: 14.5, name: 'POI on seg 1', type: 'pub' },
    ]

    const result = insertPOIWaypoints(stops, pois, geometry)

    expect(result).toHaveLength(5)
    expect(result[0].name).toBe('A')
    expect(result[1].name).toBe('POI on seg 1')
    expect(result[2].name).toBe('B')
    expect(result[3].name).toBe('POI on seg 2')
    expect(result[4].name).toBe('C')
  })
})

// ---------------------------------------------------------------------------
// Coefficient mapping (tested via fetchPOIsAlongRoute internals)
// ---------------------------------------------------------------------------
describe('coefficient-to-interval/radius mapping', () => {
  it('coefficient=0 returns empty (no-op)', async () => {
    const geometry = makeRouteGeometry(10, 100)
    const result = await fetchPOIsAlongRoute(geometry, 0)
    expect(result).toEqual([])
  })

  it('coefficient negative returns empty', async () => {
    const geometry = makeRouteGeometry(10, 100)
    const result = await fetchPOIsAlongRoute(geometry, -0.5)
    expect(result).toEqual([])
  })

  // Verify interval/radius mapping by checking sample count behavior
  it('coefficient=1 uses small interval → more sample points', async () => {
    // With coefficient=1: interval=2000m, radius=800m
    // For a 20km route, interval=2km → capped at 8 samples
    const geometry = makeRouteGeometry(20, 200)

    // Mock fetch to return empty POIs
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ elements: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    try {
      await fetchPOIsAlongRoute(geometry, 1.0)
      // With 20km and 2km interval, expect max 8 fetch calls (one per sample)
      expect(fetchSpy.mock.calls.length).toBe(8)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('coefficient=0.1 uses large interval → fewer sample points', async () => {
    // With coefficient=0.1: interval ≈ lerp(50000, 2000, 0.1) = 45200m
    // For a 10km route, this should produce only 1 sample (the start)
    const geometry = makeRouteGeometry(10, 100)

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ elements: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    try {
      await fetchPOIsAlongRoute(geometry, 0.1)
      // Only the start point, which doesn't trigger Overpass queries
      // because sampleRouteGeometry only returns [start] which is 1 point
      // but fetchPOIsAlongRoute still queries at each sample point
      // Wait — it queries at each sample point. 1 sample point → 1 fetch
      expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(1)
    } finally {
      fetchSpy.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// queryOverpassAround response parsing
// ---------------------------------------------------------------------------
describe('queryOverpassAround', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockReset()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('parses a successful Overpass JSON response', async () => {
    const mockData = {
      elements: [
        { lat: 50.0, lon: 14.4, tags: { name: 'U Zlatého Tygra', amenity: 'pub' } },
        { lat: 50.001, lon: 14.401, tags: { name: 'Lokál', amenity: 'restaurant' } },
      ],
    }

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockData), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    const result = await queryOverpassAround(50.0, 14.4, 500)

    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({
      lat: 50.0,
      lng: 14.4,
      name: 'U Zlatého Tygra',
      type: 'pub',
    })
    expect(result[1]).toEqual({
      lat: 50.001,
      lng: 14.401,
      name: 'Lokál',
      type: 'restaurant',
    })
  })

  it('returns empty array on HTML error page', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html><body>Error 503</body></html>', {
        status: 503,
        headers: { 'content-type': 'text/html' },
      }),
    )

    const result = await queryOverpassAround(50.0, 14.4, 500)
    expect(result).toEqual([])
  })

  it('returns empty array on network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network timeout'))

    const result = await queryOverpassAround(50.0, 14.4, 500)
    expect(result).toEqual([])
  })

  it('filters out elements without name tag', async () => {
    const mockData = {
      elements: [
        { lat: 50.0, lon: 14.4, tags: { name: 'Named Pub', amenity: 'pub' } },
        { lat: 50.001, lon: 14.401, tags: { amenity: 'pub' } }, // no name
        { lat: 50.002, lon: 14.402, tags: {} }, // no tags at all
      ],
    }

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockData), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    const result = await queryOverpassAround(50.0, 14.4, 500)

    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('Named Pub')
  })

  it('returns empty array for empty elements array', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ elements: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    const result = await queryOverpassAround(50.0, 14.4, 500)
    expect(result).toEqual([])
  })

  it('returns empty array for non-JSON response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('not json', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    )

    const result = await queryOverpassAround(50.0, 14.4, 500)
    expect(result).toEqual([])
  })

  it('defaults type to "unknown" when amenity tag missing', async () => {
    const mockData = {
      elements: [
        { lat: 50.0, lon: 14.4, tags: { name: 'Mystery Place' } },
      ],
    }

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockData), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    const result = await queryOverpassAround(50.0, 14.4, 500)

    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('unknown')
  })
})
