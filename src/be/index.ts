import { Elysia, t, status as httpStatus } from 'elysia';
import { cors } from '@elysiajs/cors';
import logixlysia from 'logixlysia';
import { rateLimit } from 'elysia-rate-limit';
import type {
  GeocodeResult,
  PhotonResponse,
  POILocation,
  RoadRatingAggregate, RoadRatingBucket,
} from '@vrstevnice/shared';
import { mapPhotonFeature, detectAndParseGPS } from '@vrstevnice/shared';
import {
  applyAscentGuard,
  buildCustomModel,
  convertGHToRouteResponse,
  fetchRouteFromGH,
  sampleRouteGeometry,
  deduplicatePOIs,
} from '@vrstevnice/routing';
import { resolve } from 'node:path';
import { appendFile, readFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { db, routes } from './db';
import { computeShadowProfile, hasTerrainData, readTerrainTile } from './terrain';
import queryLocalPOIs from './pois';
import {
  deleteRating,
  getAggregateByWayId,
  getCommentsByWayId,
  getAggregatesInBbox,
  getRoadRatingFeaturesInBbox,
  getVotedRoadsInCorridor,
  RoadGeometryNotFoundError,
  isRoadRatingRoadIndexUnavailable,
  backfillRatedRoadMembers,
  saveRating,
} from './road-ratings';
import {
  bucketizeRoads,
  createRatingThrottle,
  validateSubtypes,
} from './road-ratings-core';

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const PROJECT_ROOT = resolve(import.meta.dir, '..', '..');
const ENABLE_FILE_LOGGING = process.env.ENABLE_FILE_LOGGING === '1';

type Logger = (value: object | string, message?: string) => void;
interface PinoStore {
  pino: { debug: Logger; info: Logger; warn: Logger; error: Logger };
}

// Photon geocode — local instance only (no external fallback).
const PHOTON_URL = 'http://localhost:2322';

async function fetchPhoton(pathWithQuery: string): Promise<Response> {
  const url = `${PHOTON_URL}${pathWithQuery}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Photon returned ${res.status}`);
  return res;
}

const LOG_FILE = resolve(PROJECT_ROOT, 'data', 'app.log');

const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAAAD0lEQVR42mP8/5+hHgAHggJ/P0s8WQAAAABJRU5ErkJggg=='
    .replace(/(.{50})/, '$1\n'),
  'base64',
);

/** Browsers treat localhost vs 127.0.0.1 as different origins; allow both in dev. */
const LOCAL_DEV_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

const EXTRA_CORS_ORIGINS = process.env.CORS_ORIGIN?.split(',')
  .map((s) => s.trim())
  .filter(Boolean) ?? [];

function isOriginAllowed(origin: string): boolean {
  if (EXTRA_CORS_ORIGINS.includes(origin)) return true;
  if (EXTRA_CORS_ORIGINS.length > 0) return false;
  return LOCAL_DEV_ORIGIN.test(origin);
}

/** Manual response from onError mirrors the CORS allowlist. */
function corsHeadersForRequest(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin');
  if (!origin || !isOriginAllowed(origin)) return {};
  return {
    Vary: 'Origin',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
  };
}

// ── Soft-warn rate limiter: pino warning at 60 req/min/IP, never blocks ──

class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitError';
  }
}

const ipCounts = new Map<string, { count: number; resetAt: number }>();

const ratingThrottle = createRatingThrottle();

function checkRatingThrottle(ip: string): { ok: boolean; retryAfterSec: number } {
  return ratingThrottle(ip);
}

const roadRatingResponseSchema = t.Object({
  wayId: t.Number(),
  name: t.Nullable(t.String()),
  lat: t.Number(),
  lng: t.Number(),
  multiplier: t.Nullable(t.Number()),
  type: t.Nullable(t.Union([t.Literal('prefer'), t.Literal('demote')])),
  counts: t.Object({
    total: t.Number(),
    prefer: t.Number(),
    demote: t.Number(),
    subtypes: t.Object({
      nice: t.Number(),
      safe: t.Number(),
      fast: t.Number(),
      dangerous: t.Number(),
      unpassable: t.Number(),
      bad_terrain: t.Number(),
    }),
  }),
  commentsCount: t.Number(),
  mine: t.Nullable(t.Object({
    type: t.Union([t.Literal('prefer'), t.Literal('demote')]),
    subtypes: t.Array(t.Union([
      t.Literal('nice'),
      t.Literal('safe'),
      t.Literal('fast'),
      t.Literal('dangerous'),
      t.Literal('unpassable'),
      t.Literal('bad_terrain'),
    ])),
    comment: t.Nullable(t.String()),
  })),
});

function ratingErrorResponse(message: string, status: number, retryAfterSec?: number): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (retryAfterSec != null) headers['Retry-After'] = String(retryAfterSec);
  const body = { message, ...(retryAfterSec == null ? {} : { retryAfterSec }) };
  return new Response(JSON.stringify(body), {
    status,
    headers,
  });
}

function ratingJsonResponse(value: RoadRatingAggregate | RoadRatingAggregate[] | null): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const softWarnPlugin = new Elysia({
  name: 'soft-warn-rate-limit',
}).onBeforeHandle({ as: 'global' }, ({ request, server }) => {
  const ip = server?.requestIP(request)?.address;
  if (!ip) return;

  const now = Date.now();
  let entry = ipCounts.get(ip);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + 60_000 };
    ipCounts.set(ip, entry);
  }
  entry.count += 1;

  if (entry.count === 60) {
    const msg = `WARN rate limit threshold {"ip":"${ip}","count":60,"threshold":"soft"}\n`;
    appendFile(LOG_FILE, msg).catch(() => {});
  }
});

export const app = new Elysia({ prefix: '/api' })
  .use(
    cors({
      origin: EXTRA_CORS_ORIGINS.length > 0 ? EXTRA_CORS_ORIGINS : LOCAL_DEV_ORIGIN,
    }),
  )
  .use(
    logixlysia({
      config: {
        service: 'vrstevnice',
        showStartupMessage: true,
        ip: true,
        timestamp: { translateTime: 'yyyy-mm-dd HH:MM:ss.SSS' },
        ...(ENABLE_FILE_LOGGING
          ? {
            logFilePath: LOG_FILE,
            logRotation: {
              maxSize: '10m',
              interval: '1d',
              maxFiles: '7d',
              compress: true,
            },
          }
          : {}),
        pino: {
          level: LOG_LEVEL,
          prettyPrint: false,
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

  .get(
    '/terrain/:z/:x/:y',
    async ({ params }) => {
      const z = Number(params.z);
      const x = Number(params.x);
      const y = Number(params.y);

      // Try reading from local mbtiles (DMR 5G) first
      const tile = readTerrainTile(z, x, y);
      if (tile) {
        return new Response(new Uint8Array(tile), {
          headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' },
        });
      }

      // Fallback: proxy to tileserver when local mbtiles miss a tile.
      // This avoids rectangular holes in contours/hillshade when generated
      // terrain coverage is incomplete or a tile is absent in the mbtiles.
      const upstream = [
        'http://localhost:2323/data/cz-terrain', params.z, params.x, `${params.y}.png`,
      ].join('/');
      try {
        const res = await fetch(upstream);
        if (res.ok) {
          return new Response(new Uint8Array(await res.arrayBuffer()), {
            headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' },
          });
        }
      } catch {
        // fall through to transparent tile
      }

      return new Response(TRANSPARENT_PNG, {
        headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' },
      });
    },
    {
      params: t.Object({
        z: t.String(),
        x: t.String(),
        y: t.String(),
      }),
    },
  )

  .get(
    '/road-rating-roads',
    ({ query }) => {
      const values = query.bbox.split(',').map(Number);
      if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) {
        return ratingErrorResponse('Neplatný bbox.', 400);
      }
      const [minLng, minLat, maxLng, maxLat] = values;
      if (minLng > maxLng || minLat > maxLat) return ratingErrorResponse('Neplatný bbox.', 400);
      try {
        return getRoadRatingFeaturesInBbox({
          minLng, minLat, maxLng, maxLat,
        });
      } catch (error) {
        if (error instanceof Error && isRoadRatingRoadIndexUnavailable(error)) {
          return ratingErrorResponse('Index cest pro hodnocení není vygenerovaný.', 503);
        }
        throw error;
      }
    },
    { query: t.Object({ bbox: t.String() }) },
  )

  .get(
    '/road-ratings',
    async ({ query, server, request }) => {
      const values = query.bbox.split(',').map(Number);
      if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) {
        return ratingErrorResponse('Neplatný bbox.', 400);
      }
      const [minLng, minLat, maxLng, maxLat] = values;
      if (minLng > maxLng || minLat > maxLat) return ratingErrorResponse('Neplatný bbox.', 400);
      const ip = server?.requestIP(request)?.address ?? 'unknown';
      return ratingJsonResponse(await getAggregatesInBbox({
        minLng, minLat, maxLng, maxLat,
      }, ip));
    },
    {
      query: t.Object({ bbox: t.String() }),
      response: t.Array(roadRatingResponseSchema),
    },
  )

  .get(
    '/road-ratings/:wayId',
    async ({ params, server, request }) => {
      const ip = server?.requestIP(request)?.address ?? 'unknown';
      return ratingJsonResponse(await getAggregateByWayId(params.wayId, ip));
    },
    {
      params: t.Object({ wayId: t.Integer() }),
      response: t.Nullable(roadRatingResponseSchema),
    },
  )
  .get('/road-ratings/:wayId/comments', async ({ params, query }) => (
    getCommentsByWayId(params.wayId, Math.max(0, Number(query.offset) || 0))
  ), {
    params: t.Object({ wayId: t.Integer() }),
    query: t.Object({ offset: t.Optional(t.String()) }),
    response: t.Object({
      comments: t.Array(t.Object({
        type: t.Union([t.Literal('prefer'), t.Literal('demote')]),
        subtypes: t.Array(t.String()),
        comment: t.String(),
        updatedAt: t.String(),
      })),
      hasMore: t.Boolean(),
    }),
  })

  .post(
    '/road-ratings',
    async ({ body, server, request }) => {
      if (!validateSubtypes(body.type, body.subtypes)) {
        return ratingErrorResponse('Neplatné podtypy hodnocení.', 400);
      }
      const ip = server?.requestIP(request)?.address ?? 'unknown';
      const throttle = checkRatingThrottle(ip);
      if (!throttle.ok) {
        return ratingErrorResponse(
          'Příliš mnoho hodnocení. Zkuste to později.',
          429,
          throttle.retryAfterSec,
        );
      }
      try {
        return ratingJsonResponse(await saveRating({ ...body, subtypes: body.subtypes, ip }));
      } catch (error) {
        if (error instanceof Error && isRoadRatingRoadIndexUnavailable(error)) {
          return ratingErrorResponse('Index cest pro hodnocení není vygenerovaný.', 503);
        }
        if (error instanceof RoadGeometryNotFoundError) {
          return ratingErrorResponse('Geometrii cesty se nepodařilo najít.', 422);
        }
        throw error;
      }
    },
    {
      body: t.Object({
        wayId: t.Integer(),
        name: t.Optional(t.String({ maxLength: 200 })),
        type: t.Union([t.Literal('prefer'), t.Literal('demote')]),
        subtypes: t.Array(t.String()),
        comment: t.Optional(t.String({ maxLength: 1000 })),
      }),
      response: roadRatingResponseSchema,
    },
  )

  .delete(
    '/road-ratings/:wayId',
    async ({ params, server, request }) => {
      const ip = server?.requestIP(request)?.address ?? 'unknown';
      const throttle = checkRatingThrottle(ip);
      if (!throttle.ok) {
        return ratingErrorResponse(
          'Příliš mnoho hodnocení. Zkuste to později.',
          429,
          throttle.retryAfterSec,
        );
      }
      try {
        return ratingJsonResponse(await deleteRating(Number(params.wayId), ip));
      } catch (error) {
        if (error instanceof RoadGeometryNotFoundError) {
          return ratingErrorResponse('Hodnocení cesty nebylo nalezeno.', 404);
        }
        throw error;
      }
    },
    {
      params: t.Object({ wayId: t.String() }),
      response: roadRatingResponseSchema,
    },
  )

  .onError(async ({ code, error, request }) => {
    const msg = error instanceof Error ? error.message : String(error);
    const corsHeaders = corsHeadersForRequest(request);

    if (error instanceof RateLimitError) {
      return new Response(JSON.stringify({ message: msg }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    if (code === 'VALIDATION') {
      return new Response(JSON.stringify({ message: msg }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    if (code === 'NOT_FOUND') {
      // SPA fallback: serve static FE files for non-API paths
      const url = new URL(request.url);
      const reqPath = url.pathname;
      if (!reqPath.startsWith('/api/')) {
        const FE_DIST = resolve(PROJECT_ROOT, 'src', 'fe', 'dist');
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
        };
        const cleanPath = reqPath.replace(/\.\./g, '');
        const candidate = resolve(FE_DIST, cleanPath === '/' ? 'index.html' : cleanPath.slice(1));
        // Guard against path traversal — candidate must stay within FE_DIST
        if (!candidate.startsWith(FE_DIST)) {
          return new Response('Forbidden', { status: 403, headers: corsHeaders });
        }
        try {
          const file = Bun.file(candidate);
          if (await file.exists()) {
            const ext = candidate.slice(candidate.lastIndexOf('.'));
            const headers: Record<string, string> = {
              'Content-Type': MIME[ext] ?? 'application/octet-stream',
              ...corsHeaders,
            };
            if (ext === '.html') headers['Cache-Control'] = 'no-cache';
            else headers['Cache-Control'] = 'public, max-age=86400';
            return new Response(file, { status: 200, headers });
          }
        } catch {
          /* fall through */
        }
        // SPA index.html fallback
        try {
          const index = Bun.file(resolve(FE_DIST, 'index.html'));
          if (await index.exists()) {
            return new Response(index, {
              status: 200,
              headers: {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-cache',
                ...corsHeaders,
              },
            });
          }
        } catch {
          /* dev mode — no dist */
        }
      }
      return new Response('Not Found', { status: 404, headers: corsHeaders });
    }

    // Unknown error - return 500
    return new Response(JSON.stringify({ message: msg }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  })

  .get(
    '/geocode',
    async ({ query, store }) => {
      const { pino } = store as PinoStore;
      pino.debug({ q: query.q }, 'Geocode request');

      // ── GPS coordinate detection: reverse-geocode if input looks like coords ──
      const gpsCoord = detectAndParseGPS(query.q);
      if (gpsCoord) {
        pino.debug({ lat: gpsCoord.lat, lng: gpsCoord.lng }, 'GPS detected');

        try {
          const reverseRes = await fetchPhoton(`/reverse?lon=${gpsCoord.lng}&lat=${gpsCoord.lat}`);
          const reverseData = await reverseRes.json() as PhotonResponse;
          const features = reverseData.features ?? [];
          pino.debug({ count: features.length }, 'Reverse geocode results');
          if (features.length > 0) {
            return [mapPhotonFeature(features[0])];
          }
        } catch (err) {
          pino.error({ error: (err as Error).message }, 'Photon reverse geocode failed');
        }

        // Fallback: return raw coordinate as a GeocodeResult
        return [
          {
            lat: gpsCoord.lat,
            lng: gpsCoord.lng,
            name: `${gpsCoord.lat}, ${gpsCoord.lng}`,
            displayName: `${gpsCoord.lat}, ${gpsCoord.lng}`,
          },
        ];
      }

      pino.debug('GPS: no match, forward geocode');

      // ── Forward geocode via local Photon ──
      // viewbox/bounded accepted for backward compat but ignored by Photon
      let photonPath = `/api?q=${encodeURIComponent(query.q)}&limit=5`;

      // Apply Photon location bias when lat/lon are provided by the frontend
      if (query.lat && query.lon) {
        const biasZoom = Math.round(parseFloat(query.zoom || '14'));
        photonPath += `&lat=${query.lat}&lon=${query.lon}&zoom=${biasZoom}&location_bias_scale=0.2`;
        pino.debug(
          { lat: query.lat, lon: query.lon, zoom: biasZoom },
          'Location bias applied to Photon geocode',
        );
      }

      let data: PhotonResponse;
      try {
        const res = await fetchPhoton(photonPath);
        data = await res.json() as PhotonResponse;
      } catch (err) {
        pino.error({ error: (err as Error).message }, 'Photon geocode failed');
        throw new Error('Geocode service unavailable');
      }

      const features = data.features ?? [];
      const results: GeocodeResult[] = features.map(mapPhotonFeature);

      pino.debug({ q: query.q, count: results.length }, 'Geocode results');
      return results;
    },
    {
      query: t.Object({
        q: t.String({ minLength: 1 }),
        viewbox: t.Optional(t.String()),
        bounded: t.Optional(t.String()),
        lat: t.Optional(t.String()),
        lon: t.Optional(t.String()),
        zoom: t.Optional(t.String()),
      }),
      response: t.Array(
        t.Object({
          lat: t.Number(),
          lng: t.Number(),
          name: t.String(),
          displayName: t.String(),
        }),
      ),
    },
  )

  .post(
    '/route',
    async ({ body, store }) => {
      const { pino } = store as PinoStore;
      const {
        stops,
        elevationCoefficient,
        roadAvoidanceCoefficient,
        cyclewayCoefficient,
        showPOI = false,
        useRoadRatings = false,
      } = body;

      pino.info(
        {
          stopCount: stops.length,
          elevCoeff: elevationCoefficient,
          roadAvoid: roadAvoidanceCoefficient,
          cycleway: cyclewayCoefficient,
          showPOI,
        },
        'Route request',
      );

      let roadRatingBuckets: RoadRatingBucket[] = [];
      if (useRoadRatings) {
        // Community routing is opt-in: never silently substitute an unrated
        // route when its persisted data, database, or model preparation fails.
        try {
          const votedRoads = await getVotedRoadsInCorridor(stops);
          roadRatingBuckets = bucketizeRoads(votedRoads);
          pino.debug({ roadCount: votedRoads.length }, 'Community road ratings loaded');
        } catch (ratingErr) {
          const message = ratingErr instanceof Error ? ratingErr.message : String(ratingErr);
          pino.error({ error: message }, 'Community ratings unavailable');
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw httpStatus(422, { message: `Chyba dat hodnocení cest: ${message}` });
        }
      }

      let customModel: ReturnType<typeof buildCustomModel>;
      try {
        customModel = buildCustomModel(
          elevationCoefficient,
          roadAvoidanceCoefficient,
          cyclewayCoefficient,
          roadRatingBuckets,
        );
      } catch (ratingErr) {
        if (!useRoadRatings) throw ratingErr;
        const message = ratingErr instanceof Error ? ratingErr.message : String(ratingErr);
        pino.error({ error: message }, 'Community ratings model failed');
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw httpStatus(422, { message: `Chyba modelu hodnocení cest: ${message}` });
      }
      pino.debug({ customModel }, 'Custom model built');

      // Stage 1: Compute route (with post-hoc ascent guard when elevation avoidance is active)
      const t0 = performance.now();
      let ghResult: Awaited<ReturnType<typeof fetchRouteFromGH>>;

      if (elevationCoefficient > 0) {
        // Post-hoc ascent guard: compute two routes in parallel —
        // one with elevation penalty, one with only constant steep penalty (coeff=0).
        // Return whichever has less total ascent, guaranteeing ascent never increases.
        const baseModel = buildCustomModel(
          0,
          roadAvoidanceCoefficient,
          cyclewayCoefficient,
          roadRatingBuckets,
        );
        const [elevResult, baseResult] = await Promise.all([
          fetchRouteFromGH(stops, customModel),
          fetchRouteFromGH(stops, baseModel),
        ]);

        ghResult = applyAscentGuard(elevResult, baseResult);
        if (ghResult === elevResult) {
          pino.debug('Ascent guard: elevation route selected');
        } else {
          pino.info('Ascent guard: base route selected (penalized route had more ascent)');
        }
      } else {
        ghResult = await fetchRouteFromGH(stops, customModel);
      }

      const routeData = convertGHToRouteResponse(ghResult);
      const elapsed = Math.round(performance.now() - t0);

      pino.info(
        {
          distance: routeData.distance,
          duration: routeData.duration,
          gain: routeData.elevationGain,
          loss: routeData.elevationLoss,
          points: routeData.geometry.length,
          profilePoints: routeData.elevationProfile.length,
          surfaceSegments: routeData.surfaceSegments.length,
          elapsedMs: elapsed,
        },
        'Route calculated',
      );

      // Stage 2 (conditional): query POIs along route for map display
      const finalRouteData = routeData;
      if (showPOI) {
        try {
          pino.info('Querying POIs along route');
          const routeLengthM = routeData.distance * 1000;
          const sampleInterval = Math.max(500, Math.min(2000, routeLengthM / 20));
          const samplePoints = sampleRouteGeometry(routeData.geometry, sampleInterval, 50);
          const allPOIs: POILocation[] = [];
          const poiGroups = await Promise.all(
            samplePoints.map(([lat, lng]) => queryLocalPOIs(lat, lng, 2000)),
          );
          poiGroups.forEach((pois) => allPOIs.push(...pois));
          finalRouteData.allPOILocations = deduplicatePOIs(allPOIs);
          pino.info({ poiCount: finalRouteData.allPOILocations.length }, 'POI query complete');
        } catch (poiErr) {
          pino.error({ error: (poiErr as Error).message }, 'POI query failed');
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
        });
        pino.debug('Route saved to DB');
      } catch (dbErr) {
        pino.error({ error: (dbErr as Error).message }, 'Failed to save route to DB');
        // Don't fail the request - route data is still valid
      }

      if (body.shadowDateTime && hasTerrainData()) {
        try {
          finalRouteData.shadowProfile = computeShadowProfile(
            finalRouteData.geometry,
            body.shadowDateTime,
            {
              durationMs: finalRouteData.duration * 1000,
            },
          );
        } catch (shadowErr) {
          pino.warn({ error: (shadowErr as Error).message }, 'Shadow profile computation failed');
        }
      }

      return finalRouteData;
    },
    {
      body: t.Object({
        stops: t.Array(
          t.Object({
            lat: t.Number(),
            lng: t.Number(),
            name: t.String(),
          }),
        ),
        elevationCoefficient: t.Number({ minimum: 0, maximum: 1 }),
        roadAvoidanceCoefficient: t.Number({ minimum: 0, maximum: 1 }),
        cyclewayCoefficient: t.Number({ minimum: 0, maximum: 1 }),
        showPOI: t.Optional(t.Boolean()),
        shadowDateTime: t.Optional(t.String()),
        useRoadRatings: t.Optional(t.Boolean()),
      }),
      response: t.Object({
        geometry: t.Array(t.Array(t.Number())),
        distance: t.Number(),
        duration: t.Number(),
        elevationGain: t.Number(),
        elevationLoss: t.Number(),
        elevationProfile: t.Array(
          t.Object({
            distance: t.Number(),
            elevation: t.Number(),
          }),
        ),
        surfaceSegments: t.Array(
          t.Object({
            from: t.Number(),
            to: t.Number(),
            surface: t.String(),
          }),
        ),
        roadClassSegments: t.Array(
          t.Object({
            from: t.Number(),
            to: t.Number(),
            roadClass: t.String(),
          }),
        ),
        roadEnvSegments: t.Array(
          t.Object({
            from: t.Number(),
            to: t.Number(),
            roadClass: t.String(),
          }),
        ),
        poiLocations: t.Array(
          t.Object({
            lat: t.Number(),
            lng: t.Number(),
            name: t.String(),
            type: t.String(),
          }),
        ),
        allPOILocations: t.Array(
          t.Object({
            lat: t.Number(),
            lng: t.Number(),
            name: t.String(),
            type: t.String(),
          }),
        ),
        shadowProfile: t.Optional(
          t.Array(
            t.Object({
              distance: t.Number(),
              shadow: t.Boolean(),
              sunExposure: t.Number(),
            }),
          ),
        ),
        slopeBasedTimes: t.Optional(t.Array(t.Number())),
      }),
    },
  )

  .get('/history', async () => db.select().from(routes).orderBy(routes.createdAt).all())

  .get('/cycleroutes', async () => {
    const filePath = resolve(PROJECT_ROOT, 'data', 'cycleroutes.geojson');
    try {
      const data = await readFile(filePath, 'utf-8');
      return new Response(data, {
        headers: {
          'Content-Type': 'application/geo+json',
          'Cache-Control': 'public, max-age=86400',
        },
      });
    } catch {
      return new Response('Cycle routes data not found. Run pnpm extract-routes first.', {
        status: 404,
        headers: { 'Content-Type': 'text/plain' },
      });
    }
  });

// Membership backfill MUST complete before the server accepts routing
// requests — exact osm_way_id rules depend on persisted member IDs.
{
  const result = backfillRatedRoadMembers();
  if (result.memberWrites > 0 || result.rekeys > 0) {
    console.log(
      `[road-ratings] backfill: ${result.memberWrites} membership writes, ${result.rekeys} rekeys`,
    );
  }
}

app.listen(3002);

export type App = typeof app;
