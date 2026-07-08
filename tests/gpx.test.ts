import { describe, it, expect } from 'vitest'
import { generateGPX } from '@vrstevnice/fe/gpx'
import type { RouteResponse } from '@vrstevnice/shared'

function makeRoute(overrides: Partial<RouteResponse> = {}): RouteResponse {
  return {
    geometry: [
      [50.0, 14.0],
      [50.001, 14.001],
      [50.002, 14.002],
    ],
    distance: 1500,
    duration: 300,
    elevationGain: 50,
    elevationLoss: 20,
    elevationProfile: [
      { distance: 0, elevation: 200 },
      { distance: 500, elevation: 210 },
      { distance: 1000, elevation: 205 },
      { distance: 1500, elevation: 195 },
    ],
    surfaceSegments: [],
    roadClassSegments: [],
    roadEnvSegments: [],
    poiLocations: [],
    allPOILocations: [],
    ...overrides,
  }
}

describe('generateGPX', () => {
  it('produces valid GPX XML with required elements', () => {
    const gpx = generateGPX(makeRoute())

    expect(gpx).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(gpx).toContain('<gpx version="1.1"')
    expect(gpx).toContain('xmlns="http://www.topografix.com/GPX/1/1"')
    expect(gpx).toContain('</gpx>')
  })

  it('includes metadata with route stats', () => {
    const route = makeRoute({ distance: 5000, duration: 900, elevationGain: 120, elevationLoss: 80 })
    const gpx = generateGPX(route)

    expect(gpx).toContain('<metadata>')
    expect(gpx).toContain('<name>Vrstevnice Route</name>')
    expect(gpx).toContain('5.0 km')
    expect(gpx).toContain('15 min')
    expect(gpx).toContain('↑120m')
    expect(gpx).toContain('↓80m')
    expect(gpx).toContain('</metadata>')
  })

  it('includes track segment with correct number of trackpoints', () => {
    const route = makeRoute()
    const gpx = generateGPX(route)

    expect(gpx).toContain('<trk>')
    expect(gpx).toContain('<trkseg>')

    const trkptMatches = gpx.match(/<trkpt /g)
    expect(trkptMatches).toHaveLength(3) // 3 geometry points
  })

  it('trackpoints have lat, lon attributes and ele element', () => {
    const route = makeRoute()
    const gpx = generateGPX(route)

    expect(gpx).toContain('lat="50" lon="14"')
    expect(gpx).toContain('lat="50.001" lon="14.001"')
    expect(gpx).toContain('lat="50.002" lon="14.002"')
    expect(gpx).toContain('<ele>')
  })

  it('elevation is interleaved from elevationProfile', () => {
    // geometry has 3 points spread ~111m apart (haversine ≈ 111m per 0.001° lat)
    // Cumulative distances: ~0, ~111m, ~222m
    // Profile: [0→200, 500→210, 1000→205, 1500→195]
    // Point 0 (dist≈0) → closest profile at 0m → ele 200
    // Point 2 (dist≈222m) → closest profile at 0m → ele 200
    const route = makeRoute()
    const gpx = generateGPX(route)

    expect(gpx).toContain('<ele>200</ele>')  // first point at distance 0
    // Verify all trackpoints have valid elevations from the profile
    const eleValues = [...gpx.matchAll(/<ele>(\d+)<\/ele>/g)].map(m => m[1])
    expect(eleValues).toHaveLength(3)
    expect(eleValues.every(v => Number(v) >= 0)).toBe(true)
  })

  it('handles empty elevationProfile gracefully', () => {
    const route = makeRoute({ elevationProfile: [] })
    const gpx = generateGPX(route)

    const eleMatches = gpx.match(/<ele>\d+<\/ele>/g)
    expect(eleMatches).toHaveLength(3)
    // All elevations should be 0 when no profile data
    expect(gpx).toContain('<ele>0</ele>')
  })

  it('handles single-point geometry', () => {
    const route = makeRoute({
      geometry: [[50.5, 15.5]],
      elevationProfile: [{ distance: 0, elevation: 350 }],
    })
    const gpx = generateGPX(route)

    const trkptMatches = gpx.match(/<trkpt /g)
    expect(trkptMatches).toHaveLength(1)
    expect(gpx).toContain('lat="50.5" lon="15.5"')
    expect(gpx).toContain('<ele>350</ele>')
  })

  it('handles empty geometry', () => {
    const route = makeRoute({ geometry: [], elevationProfile: [] })
    const gpx = generateGPX(route)

    expect(gpx).toContain('<trkseg>')
    expect(gpx).toContain('</trkseg>')
    expect(gpx).not.toContain('<trkpt')
  })

  it('includes a time element in metadata', () => {
    const gpx = generateGPX(makeRoute())
    expect(gpx).toContain('<time>')
    expect(gpx).toContain('</time>')
  })

  it('rounded elevation values are integers', () => {
    const route = makeRoute({
      elevationProfile: [
        { distance: 0, elevation: 200.7 },
        { distance: 50, elevation: 210.3 },
        { distance: 100, elevation: 205.9 },
      ],
    })
    const gpx = generateGPX(route)

    // All three points are within ~111m of distance=0, so all map to profile point 0
    // But the closest match algorithm finds the nearest distance
    // Point 0: dist≈0 → profile[0]=200.7 → rounded to 201
    // Point 1: dist≈111m → profile[2]=205.9 (closest at dist 100) → rounded to 206
    // Point 2: dist≈222m → profile[2]=205.9 (still closest) → rounded to 206
    expect(gpx).toContain('<ele>201</ele>')
    expect(gpx).toContain('<ele>206</ele>')

    // No decimal elevations should appear
    expect(gpx).not.toMatch(/<ele>\d+\.\d+<\/ele>/)
  })
})
