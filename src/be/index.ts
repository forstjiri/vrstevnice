import { Elysia, t } from 'elysia'
import { cors } from '@elysiajs/cors'
import type { GeocodeResult, RouteResponse } from '@vrstevnice/shared'
import { buildCustomModel, fetchRouteFromGH, convertGHToRouteResponse } from '@vrstevnice/routing'
import { db, routes } from './db'

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
    const { stops, elevationCoefficient, roadAvoidanceCoefficient } = body

    const customModel = buildCustomModel(elevationCoefficient, roadAvoidanceCoefficient)
    const ghResult = await fetchRouteFromGH(stops, customModel)
    const routeData = convertGHToRouteResponse(ghResult)

    await db.insert(routes).values({
      name: `Trasa ${new Date().toISOString()}`,
      stops: JSON.stringify(stops),
      geometry: JSON.stringify(routeData.geometry),
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
      roadAvoidanceCoefficient: t.Number({ minimum: 0, maximum: 1 }),
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
