import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchPOIsAlongRoute } from '@vrstevnice/routing'

describe('POI Start Delay and Detour Optimization', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockReset()
  })

  it('skips POIs near the start based on the 1/(1+N) formula', async () => {
    // 500km straight route to minimize thinning impact
    const lngPerKm = 1 / 111.32
    const geometry: [number, number][] = []
    for (let i = 0; i <= 100; i++) {
        geometry.push([0, 14.4 + (i / 100) * 500 * lngPerKm])
    }

    const poiNear = { lat: 0, lon: 14.4 + 1 * lngPerKm, tags: { name: 'Early Pub', amenity: 'pub' } }
    const poiFar = { lat: 0, lon: 14.4 + 400 * lngPerKm, tags: { name: 'Late Pub', amenity: 'pub' } }

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ elements: [poiNear, poiFar] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    // coefficient=0.1 -> maxWaypoints = 24 (capped at 20)
    // startDelayFraction = 1 / (1 + 20) = 0.047 (23.5km)
    // Early Pub (1km) < 23.5km -> filtered
    // Late Pub (400km) > 23.5km -> kept
    const result = await fetchPOIsAlongRoute(geometry, 0.1)
    
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

    const poiA = { lat: 0.1, lon: 14.4 + 250 * lngPerKm, tags: { name: 'Expensive Detour', amenity: 'pub' } }
    const poiB = { lat: 0.001, lon: 14.4 + 260 * lngPerKm, tags: { name: 'Cheap Next', amenity: 'pub' } }

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ elements: [poiA, poiB] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    const result = await fetchPOIsAlongRoute(geometry, 0.8)
    const names = result.selected.map(p => p.name)
    expect(names).not.toContain('Expensive Detour')
    expect(names).toContain('Cheap Next')
  })
})
