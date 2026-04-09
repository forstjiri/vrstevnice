import { Elysia, t } from 'elysia'
import { cors } from '@elysiajs/cors'
import type { GeocodeResult, RouteResponse } from '@vrstevnice/shared'
import { db, routes } from './db'

const VALHALLA_URL = process.env.VALHALLA_URL || 'https://valhalla1.openstreetmap.de'

/** Decode a Valhalla polyline6 encoded string into [lat, lng][] pairs. */
function decodePolyline6(str: string): [number, number][] {
  const precision = 6
  const factor = 10 ** precision
  const result: [number, number][] = []
  let index = 0
  let lat = 0
  let lng = 0

  function decodeVarint(): number {
    let shift = 0
    let value = 0
    let byte: number
    do {
      byte = str.charCodeAt(index++) - 63
      value |= (byte & 0x1f) << shift
      shift += 5
    } while (byte & 0x20)
    return value
  }

  while (index < str.length) {
    const latDelta = decodeVarint()
    const lngDelta = decodeVarint()
    // Decode the sign: if bit 0 is set, the value is negative
    lat += (latDelta & 1) ? ~(latDelta >> 1) : latDelta >> 1
    lng += (lngDelta & 1) ? ~(lngDelta >> 1) : lngDelta >> 1
    result.push([lat / factor, lng / factor])
  }

  return result
}

const app = new Elysia({ prefix: '/api' })
  .use(cors({ origin: ['http://localhost:5173', 'http://localhost:4173'] }))

  .get('/geocode', async ({ query }) => {
    const params = new URLSearchParams({
      format: 'json',
      q: query.q,
      limit: '5',
      'accept-language': 'cs',
    })
    if (query.viewbox) {
      params.set('viewbox', query.viewbox)
      if (query.bounded === '1') {
        params.set('bounded', '1')
      }
    }
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?${params}`
    )
    const data = await res.json()
    return data.map((r: any) => ({
      lat: parseFloat(r.lat),
      lng: parseFloat(r.lon),
      name: r.name || r.display_name.split(',')[0],
      displayName: r.display_name,
    })) satisfies GeocodeResult[]
  }, {
    query: t.Object({
      q: t.String({ minLength: 1 }),
      viewbox: t.Optional(t.String()),
      bounded: t.Optional(t.String()),
    }),
    response: t.Array(t.Object({
      lat: t.Number(),
      lng: t.Number(),
      name: t.String(),
      displayName: t.String(),
    })),
  })

  .post('/route', async ({ body }) => {
    const { stops, elevationCoefficient } = body

    const locations = stops.map(s => ({
      lat: s.lat,
      lon: s.lng,
      type: 'break' as const,
    }))

    const res = await fetch(`${VALHALLA_URL}/route`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        locations,
        costing: 'bicycle',
        costing_options: {
          bicycle: {
            use_hills: elevationCoefficient,
          },
        },
        units: 'kilometers',
      }),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Valhalla error: ${res.status} ${text}`)
    }

    const data = await res.json()
    const leg = data.trip?.legs?.[0]

    if (!leg) {
      throw new Error('No route found')
    }

    // Decode Valhalla's polyline6 encoded string into [lat, lng][]
    const shapeStr = leg.shape as string | undefined
    const coords: [number, number][] = shapeStr
      ? decodePolyline6(shapeStr)
      : []

    // Fetch elevation profile via Valhalla /height endpoint
    let elevationGain = 0
    let elevationLoss = 0
    if (coords.length > 1) {
      try {
        const heightRes = await fetch(`${VALHALLA_URL}/height`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            shape: coords.map(c => ({ lat: c[0], lon: c[1] })),
            resample_distance: 50,
          }),
        })
        if (heightRes.ok) {
          const heightData = await heightRes.json()
          const heights: number[] = heightData.height ?? []
          for (let i = 1; i < heights.length; i++) {
            const diff = heights[i] - heights[i - 1]
            if (diff > 0) elevationGain += diff
            else elevationLoss += Math.abs(diff)
          }
        }
      } catch {
        // Elevation fetch failed — proceed with zero gain/loss
      }
    }

    const routeData: RouteResponse = {
      geometry: coords,
      distance: data.trip?.summary?.length || 0,
      duration: data.trip?.summary?.time || 0,
      elevationGain: Math.round(elevationGain),
      elevationLoss: Math.round(elevationLoss),
    }

    await db.insert(routes).values({
      name: `Trasa ${new Date().toISOString()}`,
      stops: JSON.stringify(stops),
      geometry: JSON.stringify(coords),
      distance: routeData.distance,
      duration: routeData.duration,
      elevationGain: routeData.elevationGain,
      elevationLoss: routeData.elevationLoss,
    })

    return routeData
  }, {
    body: t.Object({
      stops: t.Array(t.Object({
        lat: t.Number(),
        lng: t.Number(),
        name: t.String(),
      })),
      elevationCoefficient: t.Number({ minimum: 0, maximum: 1 }),
    }),
    response: t.Object({
      geometry: t.Array(t.Array(t.Number())),
      distance: t.Number(),
      duration: t.Number(),
      elevationGain: t.Number(),
      elevationLoss: t.Number(),
    }),
  })

  .get('/history', async () => {
    return db.select().from(routes).orderBy(routes.createdAt).all()
  })

  .listen(3002)

export type App = typeof app
console.log('🚀 Backend na http://localhost:3002')
