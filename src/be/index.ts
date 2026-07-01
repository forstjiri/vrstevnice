import { Elysia, t } from 'elysia'
import { cors } from '@elysiajs/cors'
import logixlysia from 'logixlysia'
import { rateLimit } from 'elysia-rate-limit'
import type { GeocodeResult } from '@vrstevnice/shared'
import {
	buildCustomModel,
	convertGHToRouteResponse,
	fetchPOIsAlongRoute,
	fetchRouteFromGH,
	insertPOIWaypoints
} from '@vrstevnice/routing'
import { db, routes } from './db'
import { mapPhotonFeature } from './geocode'
import { detectAndParseGPS } from './gps'
import { computeShadowProfile, hasTerrainData, readTerrainTile } from './terrain'
import { resolve } from 'node:path'
import {appendFile, readFile} from 'node:fs/promises'
import { Buffer } from 'node:buffer'

const LOG_LEVEL = process.env.LOG_LEVEL || 'info'
const PROJECT_ROOT = resolve(import.meta.dir, '..', '..')

// Photon geocode backends — tried in order. Local first (fast, no external dep),
// then public komoot Photon as fallback when local is down (e.g. low-RAM deployments).
const PHOTON_URLS = (process.env.PHOTON_URLS || 'http://localhost:2322,https://photon.komoot.io')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

/** Try each Photon backend in order; return first successful Response. */
async function fetchPhoton(pathWithQuery: string, pino: any): Promise<Response | null> {
  for (const base of PHOTON_URLS) {
    const url = `${base}${pathWithQuery}`
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
      if (res.ok) {
        if (base !== PHOTON_URLS[0]) pino.warn({ base }, 'Photon fallback used')
        return res
      }
      pino.debug({ base, status: res.status }, 'Photon backend non-OK')
    } catch (err) {
      pino.debug({ base, error: (err as Error).message }, 'Photon backend unreachable')
    }
  }
  return null
}

const LOG_FILE = resolve(PROJECT_ROOT, 'data', 'app.log')

const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAAAD0lEQVR42mP8/5+hHgAHggJ/P0s8WQAAAABJRU5ErkJggg==',
  'base64',
)

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

/** Manual `Response` from onError bypasses the CORS plugin's `set.headers`; mirror allowlist here. */
function corsHeadersForRequest(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin')
  if (!origin || !isOriginAllowed(origin)) return {}
  return {
    Vary: 'Origin',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
  }
}

// ── Soft-warn rate limiter: pino warning at 60 req/min/IP, never blocks ──

class RateLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RateLimitError'
  }
}

const ipCounts = new Map<string, { count: number; resetAt: number }>()

const softWarnPlugin = new Elysia({ name: 'soft-warn-rate-limit' }).onBeforeHandle(
  { as: 'global' },
  ({ request, server }) => {
    const ip = server?.requestIP(request)?.address
    if (!ip) return

    const now = Date.now()
    let entry = ipCounts.get(ip)
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + 60_000 }
      ipCounts.set(ip, entry)
    }
    entry.count++

    if (entry.count === 60) {
      const msg = `WARN Rate limit soft threshold reached {"ip":"${ip}","count":60,"threshold":"soft"}\n`
			appendFile(LOG_FILE, msg).catch(() => {
			})
    }
  },
)

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
  .use(softWarnPlugin)
  .use(
    rateLimit({
      duration: 60_000,
      max: 900,
      errorResponse: new RateLimitError('Rate limit exceeded. Please try again later.'),
    }),
  )

  .get('/terrain/:z/:x/:y', async ({ params, set }) => {
		const z = Number(params.z)
		const x = Number(params.x)
		const y = Number(params.y)

		// Try reading from local mbtiles (DMR 5G) first
		const tile = readTerrainTile(z, x, y)
		if (tile) {
			set.headers['Content-Type'] = 'image/png'
			set.headers['Cache-Control'] = 'public, max-age=86400'
			return tile
		}

		// Fallback: proxy to tileserver when local mbtiles miss a tile.
		// This avoids rectangular holes in contours/hillshade when generated
		// terrain coverage is incomplete or a tile is absent in the mbtiles.
    const upstream = `http://localhost:2323/data/cz-terrain/${params.z}/${params.x}/${params.y}.png`
    try {
      const res = await fetch(upstream)
      if (res.ok) {
        set.headers['Content-Type'] = 'image/png'
        set.headers['Cache-Control'] = 'public, max-age=86400'
        return new Uint8Array(await res.arrayBuffer())
      }
    } catch {
      // fall through to transparent tile
    }

    set.headers['Content-Type'] = 'image/png'
    set.headers['Cache-Control'] = 'public, max-age=86400'
    return TRANSPARENT_PNG
  }, {
    params: t.Object({
      z: t.String(),
      x: t.String(),
      y: t.String(),
    }),
  })

  .onError(async ({ code, error, request }) => {
    const msg = error instanceof Error ? error.message : String(error)
    const cors = corsHeadersForRequest(request)

    if (error instanceof RateLimitError) {
      return new Response(JSON.stringify({ message: msg }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', ...cors },
      })
    }

    if (code === 'VALIDATION') {
      return new Response(JSON.stringify({ message: msg }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...cors },
      })
    }

    if (code === 'NOT_FOUND') {
      // SPA fallback: serve static FE files for non-API paths
      const url = new URL(request.url)
      const reqPath = url.pathname
      if (!reqPath.startsWith('/api/')) {
        const FE_DIST = resolve(PROJECT_ROOT, 'src', 'fe', 'dist')
        const MIME: Record<string, string> = {
          '.html': 'text/html; charset=utf-8',
          '.js': 'application/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.json': 'application/json; charset=utf-8',
          '.svg': 'image/svg+xml',
          '.png': 'image/png',
          '.ico': 'image/x-icon',
          '.woff2': 'font/woff2',
          '.woff': 'font/woff',
          '.mjs': 'application/javascript; charset=utf-8',
          '.map': 'application/json; charset=utf-8',
        }
        const cleanPath = reqPath.replace(/\.\./g, '')
        const candidate = resolve(FE_DIST, cleanPath === '/' ? 'index.html' : cleanPath.slice(1))
        // Guard against path traversal — candidate must stay within FE_DIST
        if (!candidate.startsWith(FE_DIST)) return new Response('Forbidden', { status: 403, headers: cors })
        try {
          const file = Bun.file(candidate)
          if (await file.exists()) {
            const ext = candidate.slice(candidate.lastIndexOf('.'))
            const headers: Record<string, string> = {
              'Content-Type': MIME[ext] ?? 'application/octet-stream',
              ...cors,
            }
            if (ext === '.html') headers['Cache-Control'] = 'no-cache'
            else headers['Cache-Control'] = 'public, max-age=86400'
            return new Response(file, { status: 200, headers })
          }
        } catch { /* fall through */ }
        // SPA index.html fallback
        try {
          const index = Bun.file(resolve(FE_DIST, 'index.html'))
          if (await index.exists()) {
            return new Response(index, {
              status: 200,
              headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...cors },
            })
          }
        } catch { /* dev mode — no dist */ }
      }
      return new Response('Not Found', { status: 404, headers: cors })
    }

    // Unknown error - return 500
    return new Response(JSON.stringify({ message: msg }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...cors },
    })
  })

  .get('/geocode', async ({ query, store }) => {
		const {pino} = store as {
			pino: {
				debug: (...args: any[]) => void;
				info: (...args: any[]) => void;
				warn: (...args: any[]) => void;
				error: (...args: any[]) => void
			}
		}
    pino.debug({ q: query.q }, 'Geocode request')

    // ── GPS coordinate detection: reverse-geocode if input looks like coords ──
    const gpsCoord = detectAndParseGPS(query.q)
    if (gpsCoord) {
      pino.debug({ lat: gpsCoord.lat, lng: gpsCoord.lng }, 'GPS detected')

      const reverseRes = await fetchPhoton(`/reverse?lon=${gpsCoord.lng}&lat=${gpsCoord.lat}`, pino)
      if (reverseRes) {
        try {
          const reverseData = await reverseRes.json() as any
          const features: any[] = reverseData?.features ?? []
          pino.debug({ count: features.length }, 'Reverse geocode results')
          if (features.length > 0) {
            return [mapPhotonFeature(features[0])]
          }
        } catch (err) {
          pino.error({ error: (err as Error).message }, 'Photon reverse geocode: malformed response')
        }
      } else {
        pino.warn('All Photon backends unreachable for reverse geocode')
      }

      // Fallback: return raw coordinate as a GeocodeResult
      return [{
        lat: gpsCoord.lat,
        lng: gpsCoord.lng,
        name: `${gpsCoord.lat}, ${gpsCoord.lng}`,
        displayName: `${gpsCoord.lat}, ${gpsCoord.lng}`,
      }]
    }

    pino.debug('GPS: no match, forward geocode')

    // ── Forward geocode via Photon (with fallback chain) ──
    // viewbox/bounded accepted for backward compat but ignored by Photon
    let photonPath = `/api?q=${encodeURIComponent(query.q)}&limit=5`

    // Apply Photon location bias when lat/lon are provided by the frontend
    if (query.lat && query.lon) {
      const biasZoom = Math.round(parseFloat(query.zoom || '14'))
      photonPath += `&lat=${query.lat}&lon=${query.lon}&zoom=${biasZoom}&location_bias_scale=0.2`
      pino.debug({ lat: query.lat, lon: query.lon, zoom: biasZoom }, 'Location bias applied to Photon geocode')
    }

    const res = await fetchPhoton(photonPath, pino)
    if (!res) {
      pino.error({ path: photonPath }, 'All Photon backends unreachable')
      throw new Error('Geocode service unavailable')
    }

    let data: any
    try {
      data = await res.json()
    } catch (err) {
      pino.error({ error: (err as Error).message }, 'Photon geocode: malformed JSON response')
      throw new Error('Geocode service returned invalid data')
    }

    const features: any[] = data?.features ?? []
    const results: GeocodeResult[] = features.map(mapPhotonFeature)

    pino.debug({ q: query.q, count: results.length }, 'Geocode results')
    return results
  }, {
    query: t.Object({
      q: t.String({ minLength: 1 }),
      viewbox: t.Optional(t.String()),
      bounded: t.Optional(t.String()),
      lat: t.Optional(t.String()),
      lon: t.Optional(t.String()),
      zoom: t.Optional(t.String()),
    }),
    response: t.Array(t.Object({
      lat: t.Number(),
      lng: t.Number(),
      name: t.String(),
      displayName: t.String(),
    })),
  })

  .post('/route', async ({ body, store }) => {
		const {pino} = store as {
			pino: {
				debug: (...args: any[]) => void;
				info: (...args: any[]) => void;
				warn: (...args: any[]) => void;
				error: (...args: any[]) => void
			}
		}
		const {
			stops,
			elevationCoefficient,
			roadAvoidanceCoefficient,
			cyclewayCoefficient,
			lemonadeCoefficient: rawLemonade = 0
		} = body

    pino.info(
			{
				stopCount: stops.length,
				elevCoeff: elevationCoefficient,
				roadAvoid: roadAvoidanceCoefficient,
				cycleway: cyclewayCoefficient,
				lemonade: rawLemonade
			},
      'Route request',
    )

    const customModel = buildCustomModel(elevationCoefficient, roadAvoidanceCoefficient, cyclewayCoefficient)
    pino.debug({ customModel }, 'Custom model built')

    // Stage 1: Compute base route
    const t0 = performance.now()
    const ghResult = await fetchRouteFromGH(stops, customModel)
    let routeData = convertGHToRouteResponse(ghResult)
    const elapsed = Math.round(performance.now() - t0)

    pino.info(
			{
				distance: routeData.distance,
				duration: routeData.duration,
				gain: routeData.elevationGain,
				loss: routeData.elevationLoss,
				points: routeData.geometry.length,
				profilePoints: routeData.elevationProfile.length,
				surfaceSegments: routeData.surfaceSegments.length,
				elapsedMs: elapsed
			},
      'Route calculated',
    )

    // Stage 2 (conditional): POI pipeline for lemonade routing
    let finalRouteData = routeData
    if (rawLemonade > 0) {
      const poiT0 = performance.now()
      try {
        pino.info({ lemonadeCoefficient: rawLemonade }, 'POI pipeline: starting')

        const { selected, all } = await fetchPOIsAlongRoute(routeData.geometry, rawLemonade)

        if (selected.length > 0) {
          pino.info({ poiCount: selected.length, allPOIs: all.length }, 'POI pipeline: inserting waypoints')
          const expandedStops = insertPOIWaypoints(stops, selected, routeData.geometry)

          const reRouteT0 = performance.now()
          const ghReRoute = await fetchRouteFromGH(expandedStops, customModel)
          const reRouted = convertGHToRouteResponse(ghReRoute)
          const reRouteElapsed = Math.round(performance.now() - reRouteT0)

          // Attach POI locations to the re-routed response
          reRouted.poiLocations = selected
          reRouted.allPOILocations = all
          finalRouteData = reRouted

          pino.info(
						{
							poiCount: selected.length,
							allPOIs: all.length,
							reRouteDistance: reRouted.distance,
							reRouteElapsedMs: reRouteElapsed
						},
            'POI pipeline: re-route complete',
          )
        } else {
          pino.warn({ allPOIs: all.length }, 'POI pipeline: no POIs selected, returning base route')
          // Still attach all discovered POIs for map display even if none were selected
          finalRouteData.allPOILocations = all
        }
      } catch (poiErr) {
        const elapsed = Math.round(performance.now() - poiT0)
				pino.error({
					error: (poiErr as Error).message,
					elapsedMs: elapsed
				}, 'POI pipeline failed - returning base route')
        // Fallback: return the original base route with empty poiLocations
      }
    }

    try {
      await db.insert(routes).values({
        name: `Trasa ${new Date().toISOString()}`,
        stops: JSON.stringify(stops),
        geometry: JSON.stringify(finalRouteData.geometry),
        distance: finalRouteData.distance,
        duration: finalRouteData.duration,
        elevationGain: finalRouteData.elevationGain,
        elevationLoss: finalRouteData.elevationLoss,
        elevationProfile: JSON.stringify(finalRouteData.elevationProfile),
        surfaceSegments: JSON.stringify(finalRouteData.surfaceSegments),
      roadClassSegments: JSON.stringify(finalRouteData.roadClassSegments),
      })
      pino.debug('Route saved to DB')
    } catch (dbErr) {
      pino.error({ error: (dbErr as Error).message }, 'Failed to save route to DB')
      // Don't fail the request - route data is still valid
    }

    if (body.shadowDateTime && hasTerrainData()) {
      try {
        finalRouteData.shadowProfile = computeShadowProfile(finalRouteData.geometry, body.shadowDateTime)
      } catch (shadowErr) {
        pino.warn({ error: (shadowErr as Error).message }, 'Shadow profile computation failed')
      }
    }

    return finalRouteData
  }, {
    body: t.Object({
      stops: t.Array(t.Object({
        lat: t.Number(),
        lng: t.Number(),
        name: t.String(),
      })),
      elevationCoefficient: t.Number({ minimum: 0, maximum: 1 }),
      roadAvoidanceCoefficient: t.Number({ minimum: 0, maximum: 1 }),
      cyclewayCoefficient: t.Number({ minimum: 0, maximum: 1 }),
      lemonadeCoefficient: t.Optional(t.Number({ minimum: 0, maximum: 1 })),
      shadowDateTime: t.Optional(t.String()),
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
      surfaceSegments: t.Array(t.Object({
        from: t.Number(),
        to: t.Number(),
        surface: t.String(),
      })),
      roadClassSegments: t.Array(t.Object({
        from: t.Number(),
        to: t.Number(),
        roadClass: t.String(),
      })),
      roadEnvSegments: t.Array(t.Object({
        from: t.Number(),
        to: t.Number(),
        roadClass: t.String(),
      })),
      poiLocations: t.Array(t.Object({
        lat: t.Number(),
        lng: t.Number(),
        name: t.String(),
        type: t.String(),
      })),
      allPOILocations: t.Array(t.Object({
        lat: t.Number(),
        lng: t.Number(),
        name: t.String(),
        type: t.String(),
      })),
      shadowProfile: t.Optional(t.Array(t.Object({
        distance: t.Number(),
        shadow: t.Boolean(),
        sunExposure: t.Number(),
      }))),
    }),
  })

  .post('/shadow-profile', async ({ body }) => {
    if (!hasTerrainData()) return { shadowProfile: [] }
    return {
      shadowProfile: computeShadowProfile(body.geometry as [number, number][], body.datetime, {
        sampleIntervalM: body.sampleIntervalM,
        stepM: body.stepM,
        maxRayM: body.maxRayM,
        durationMs: body.durationMs,
      }),
    }
  }, {
    body: t.Object({
      geometry: t.Array(t.Tuple([t.Number(), t.Number()])),
      datetime: t.String(),
      sampleIntervalM: t.Optional(t.Number({ minimum: 1 })),
      stepM: t.Optional(t.Number({ minimum: 1 })),
      maxRayM: t.Optional(t.Number({ minimum: 1 })),
      durationMs: t.Optional(t.Number({ minimum: 1 })),
    }),
    response: t.Object({
      shadowProfile: t.Array(t.Object({
        distance: t.Number(),
        shadow: t.Boolean(),
        sunExposure: t.Number(),
      })),
    }),
  })

  .get('/history', async () => {
    return db.select().from(routes).orderBy(routes.createdAt).all()
  })

  .get('/cycleroutes', async ({ set }) => {
    const filePath = resolve(PROJECT_ROOT, 'data', 'cycleroutes.geojson')
    try {
      const data = await readFile(filePath, 'utf-8')
      set.headers['Content-Type'] = 'application/geo+json'
      set.headers['Cache-Control'] = 'public, max-age=86400'
      return data
    } catch {
      return new Response('Cycle routes data not found. Run pnpm extract-routes first.', {
        status: 404,
        headers: { 'Content-Type': 'text/plain' },
      })
    }
  })

  .listen(3002)

export type App = typeof app
