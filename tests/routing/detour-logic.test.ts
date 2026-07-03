import { describe, it, expect, vi } from 'vitest'
import { fetchPOIsAlongRoute, type POIQueryFn } from '@vrstevnice/routing'
import type { POILocation } from '@vrstevnice/shared'

/** Build a queryFn that returns a fixed list of POIs (ignoring lat/lng/radius). */
function mockPOIQuery(pois: POILocation[]): POIQueryFn {
  return vi.fn(async () => pois)
}

describe('POI Start Delay and Detour Optimization', () => {
  it('skips POIs near the start based on the 1/(1+N) formula', async () => {
    // 500km straight route to minimize thinning impact
    const lngPerKm = 1 / 111.32
    const geometry: [number, number][] = []
    for (let i = 0; i <= 100; i++) {
        geometry.push([0, 14.4 + (i / 100) * 500 * lngPerKm])
    }

    const poiNear: POILocation = { lat: 0, lng: 14.4 + 1 * lngPerKm, name: 'Early Pub', type: 'pub' }
    const poiFar: POILocation = { lat: 0, lng: 14.4 + 400 * lngPerKm, name: 'Late Pub', type: 'pub' }

    // coefficient=0.1 -> maxWaypoints = 24 (capped at 20)
    // startDelayFraction = 1 / (1 + 20) = 0.047 (23.5km)
    // Early Pub (1km) < 23.5km -> filtered
    // Late Pub (400km) > 23.5km -> kept
    const result = await fetchPOIsAlongRoute(geometry, 0.1, mockPOIQuery([poiNear, poiFar]))

    // On such long route, maxWaypoints is high even for low coefficient.
    // result.selected may still be limited by thinning, but Late Pub should survive.
    const names = result.selected.map(p => p.name)
    expect(names).toContain('Late Pub')
    expect(names).not.toContain('Early Pub')
  })

  it('skips inefficient detours (detour cost > distance to next)', async () => {
    const lngPerKm = 1 / 111.32
    const geometry: [number, number][] = []
    for (let i = 0; i <= 100; i++) {
        geometry.push([0, 14.4 + (i / 100) * 500 * lngPerKm])
    }

    const poiA: POILocation = { lat: 0.1, lng: 14.4 + 250 * lngPerKm, name: 'Expensive Detour', type: 'pub' }
    const poiB: POILocation = { lat: 0.001, lng: 14.4 + 260 * lngPerKm, name: 'Cheap Next', type: 'pub' }

    const result = await fetchPOIsAlongRoute(geometry, 0.8, mockPOIQuery([poiA, poiB]))
    const names = result.selected.map(p => p.name)
    expect(names).not.toContain('Expensive Detour')
    expect(names).toContain('Cheap Next')
  })
})
