import { describe, it, expect } from 'vitest'
import {
  convertGHToRouteResponse,
  computeElevationProfile,
  smoothElevationProfile,
  computeElevationGainLoss,
} from '@vrstevnice/routing'
import type { GHRouteResult } from '@vrstevnice/routing'

function makeGHResult(overrides: Partial<GHRouteResult> = {}): GHRouteResult {
  return {
    distance: 15000,         // 15 km
    duration: 3600000,       // 1 hour
    elevationGain: 200,
    elevationLoss: 180,
    geometry: [
      [14.42, 50.08, 200],  // [lon, lat, ele]
      [14.44, 50.08, 205],
      [14.46, 50.07, 210],
      [14.50, 50.06, 195],
    ],
    surfaceSegments: [
      { from: 0, to: 2, surface: 'asphalt' },
      { from: 2, to: 4, surface: 'gravel' },
    ],
    roadClassSegments: [
      { from: 0, to: 1, roadClass: 'residential' },
      { from: 1, to: 3, roadClass: 'tertiary' },
      { from: 3, to: 4, roadClass: 'track' },
    ],
    roadEnvSegments: [
      { from: 1, to: 2, roadClass: 'bridge' },
      { from: 2, to: 3, roadClass: 'road' },
    ],
    ...overrides,
  }
}

describe('convertGHToRouteResponse', () => {
  it('converts distance from meters to km with 1 decimal', () => {
    const result = convertGHToRouteResponse(makeGHResult({ distance: 12345 }))
    expect(result.distance).toBe(12.3)  // 12345 / 1000 = 12.345 → rounded
  })

  it('converts duration from ms to seconds', () => {
    const result = convertGHToRouteResponse(makeGHResult({ duration: 3661500 }))
    expect(result.duration).toBe(3662)  // 3661.5 → Math.round
  })

  it('swaps coordinates from [lon, lat, ele] to [lat, lon]', () => {
    const result = convertGHToRouteResponse(makeGHResult())
    expect(result.geometry).toEqual([
      [50.08, 14.42],  // swapped
      [50.08, 14.44],
      [50.07, 14.46],
      [50.06, 14.50],
    ])
  })

  it('includes surfaceSegments unchanged', () => {
    const result = convertGHToRouteResponse(makeGHResult())
    expect(result.surfaceSegments).toHaveLength(2)
    expect(result.surfaceSegments[0]).toEqual({ from: 0, to: 2, surface: 'asphalt' })
  })

  it('includes roadClassSegments unchanged', () => {
    const result = convertGHToRouteResponse(makeGHResult())
    expect(result.roadClassSegments).toHaveLength(3)
    expect(result.roadClassSegments[2]).toEqual({ from: 3, to: 4, roadClass: 'track' })
  })

  it('includes roadEnvSegments', () => {
    const result = convertGHToRouteResponse(makeGHResult())
    expect(result.roadEnvSegments).toHaveLength(2)
    expect(result.roadEnvSegments[0]).toEqual({ from: 1, to: 2, roadClass: 'bridge' })
  })

  it('initializes poiLocations and allPOILocations as empty', () => {
    const result = convertGHToRouteResponse(makeGHResult())
    expect(result.poiLocations).toEqual([])
    expect(result.allPOILocations).toEqual([])
  })

  it('generates elevationProfile from geometry', () => {
    const result = convertGHToRouteResponse(makeGHResult())
    expect(result.elevationProfile).toHaveLength(4)
    expect(result.elevationProfile[0]).toEqual({ distance: 0, elevation: 200 })
    // Distances are cumulative haversine
    expect(result.elevationProfile[0].distance).toBe(0)
    expect(result.elevationProfile[1].distance).toBeGreaterThan(0)
  })

  it('recomputes elevationGain and elevationLoss from the smoothed profile', () => {
    const gh = makeGHResult({
      elevationGain: 350,
      elevationLoss: 280,
    })
    const result = convertGHToRouteResponse(gh)
    const expectedProfile = smoothElevationProfile(computeElevationProfile(gh.geometry))
    const expectedGainLoss = computeElevationGainLoss(expectedProfile)

    expect(result.elevationProfile).toEqual(expectedProfile)
    expect(result.elevationGain).toBe(expectedGainLoss.gain)
    expect(result.elevationLoss).toBe(expectedGainLoss.loss)
    // Raw GH ascend/descend should no longer be passed through unchanged.
    expect(result.elevationGain).not.toBe(350)
    expect(result.elevationLoss).not.toBe(280)
  })

  it('handles empty roadEnvSegments (undefined)', () => {
    const result = convertGHToRouteResponse(makeGHResult({ roadEnvSegments: undefined }))
    expect(result.roadEnvSegments).toEqual([])
  })

  it('handles empty segments arrays', () => {
    const result = convertGHToRouteResponse(makeGHResult({
      surfaceSegments: [],
      roadClassSegments: [],
      roadEnvSegments: [],
    }))
    expect(result.surfaceSegments).toEqual([])
    expect(result.roadClassSegments).toEqual([])
    expect(result.roadEnvSegments).toEqual([])
  })
})
