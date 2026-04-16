import { Elysia, t } from 'elysia'
import { cors } from '@elysiajs/cors'
import logixlysia from 'logixlysia'
import type { GeocodeResult, RouteResponse } from '@vrstevnice/shared'
import { buildCustomModel, fetchRouteFromGH, convertGHToRouteResponse } from '@vrstevnice/routing'
import { db, routes } from './db'
import { resolve } from 'node:path'

const LOG_LEVEL = process.env.LOG_LEVEL || 'info'
const PROJECT_ROOT = resolve(import.meta.dir, '..', '..')
const LOG_FILE = resolve(PROJECT_ROOT, 'logs', 'app.log')

/** Browsers treat localhost vs 127.0.0.1 as different origins; allow both in dev. */
const LOCAL_DEV_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/

const EXTRA_CORS_ORIGINS =
  process.env.CORS_ORIGIN?.split(',')
    .map((s) => s.trim())
    .filter(Boolean) ?? []

function isOriginAllowed(origin: string): boolean {
  if (EXTRA_CORS_ORIGINS.includes(origin)) return true
  if (EXTRA_CORS_ORIGINS.length > 0) return false
  return LOCAL_DEV_ORIGIN.test(origin)
}

/** Manual `Response` from onError bypasses the CORS plugin’s `set.headers`; mirror allowlist here. */
function corsHeadersForRequest(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin')
  if (!origin || !isOriginAllowed(origin)) return {}
  return {
    Vary: 'Origin',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
  }
}

const app = new Elysia({ prefix: '/api' })
  .use(
    cors({
      origin:
        EXTRA_CORS_ORIGINS.length > 0 ? EXTRA_CORS_ORIGINS : LOCAL_DEV_ORIGIN,
    }),
  )
  .use(
    logixlysia({
      config: {
        service: 'vrstevnice',
        showStartupMessage: true,
        ip: true,
        timestamp: { translateTime: 'yyyy-mm-dd HH:MM:ss.SSS' },
        logFilePath: LOG_FILE,
        logRotation: {
          maxSize: '10m',
          interval: '1d',
          maxFiles: '7d',
          compress: true,
        },
        pino: {
          level: LOG_LEVEL,
          prettyPrint: true,
        },
      },
    }),
  )

  .onError(({ code, error, request }) => {
    const msg = error instanceof Error ? error.message : String(error)
    const cors = corsHeadersForRequest(request)

    if (code === 'VALIDATION') {
      return new Response(JSON.stringify({ message: msg }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...cors },
      })
    }

    if (code === 'NOT_FOUND') {
      return new Response('Not Found', { status: 404, headers: cors })
    }

    // Unknown error — return 500
    return new Response(JSON.stringify({ message: msg }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...cors },
    })
  })

  .get('/geocode', async ({ query, store }) => {
    const { pino } = store as { pino: any }
    pino.debug({ query: query.q, viewbox: query.viewbox, bounded: query.bounded }, 'Geocode request')

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

    if (!res.ok) {
      const text = await res.text()
      pino.error({ status: res.status, body: text }, 'Nominatim geocode failed')
      throw new Error(`Geocode failed: ${res.status}`)
    }

    const data = await res.json()
    const results: GeocodeResult[] = data.map((r: any) => ({
      lat: parseFloat(r.lat),
      lng: parseFloat(r.lon),
      name: r.name || r.display_name.split(',')[0],
      displayName: r.display_name,
    }))

    pino.debug({ count: results.length }, 'Geocode results')
    return results
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

  .post('/route', async ({ body, store }) => {
    const { pino } = store as { pino: any }
    const { stops, elevationCoefficient, roadAvoidanceCoefficient } = body

    pino.info(
      { stopCount: stops.length, elevCoeff: elevationCoefficient, roadAvoid: roadAvoidanceCoefficient },
      'Route request',
    )

    const customModel = buildCustomModel(elevationCoefficient, roadAvoidanceCoefficient)
    pino.debug({ customModel }, 'Custom model built')

    const t0 = performance.now()
    const ghResult = await fetchRouteFromGH(stops, customModel)
    const routeData = convertGHToRouteResponse(ghResult)
    const elapsed = Math.round(performance.now() - t0)

    pino.info(
      { distance: routeData.distance, duration: routeData.duration, gain: routeData.elevationGain, loss: routeData.elevationLoss, points: routeData.geometry.length, profilePoints: routeData.elevationProfile.length, elapsedMs: elapsed },
      'Route calculated',
    )

    try {
      await db.insert(routes).values({
        name: `Trasa ${new Date().toISOString()}`,
        stops: JSON.stringify(stops),
        geometry: JSON.stringify(routeData.geometry),
        distance: routeData.distance,
        duration: routeData.duration,
        elevationGain: routeData.elevationGain,
        elevationLoss: routeData.elevationLoss,
        elevationProfile: JSON.stringify(routeData.elevationProfile),
      })
      pino.debug('Route saved to DB')
    } catch (dbErr) {
      pino.error({ error: (dbErr as Error).message }, 'Failed to save route to DB')
      // Don't fail the request — route data is still valid
    }

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
      elevationProfile: t.Array(t.Object({
        distance: t.Number(),
        elevation: t.Number(),
      })),
    }),
  })

  .get('/history', async () => {
    return db.select().from(routes).orderBy(routes.createdAt).all()
  })

  .listen(3002)

export type App = typeof app
