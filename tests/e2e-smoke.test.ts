/**
 * E2E smoke tests — verify the app loads and endpoints respond.
 *
 * Requires: FE :5173, BE :3002, Docker services running.
 * File is dynamically skipped if services are not reachable.
 *
 * Run: pnpm test -- tests/e2e-smoke.test.ts
 */

import { describe, it, expect } from 'vitest';

const FE_URL = process.env.FE_URL || 'http://localhost:5173';
const BE_URL = process.env.BE_URL || 'http://localhost:3002';

async function checkServices(): Promise<{ ok: boolean; reason: string }> {
  const errors: string[] = [];
  try {
    const res = await fetch(FE_URL, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) errors.push(`FE ${res.status}`);
  } catch (e) {
    errors.push(`FE: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const res = await fetch(`${BE_URL}/api/history`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) errors.push(`BE ${res.status}`);
  } catch (e) {
    errors.push(`BE: ${e instanceof Error ? e.message : String(e)}`);
  }
  return errors.length > 0 ? { ok: false, reason: errors.join('; ') } : { ok: true, reason: '' };
}

// Evaluate at module load — Vitest supports top-level await in test files
const { ok: servicesOk } = await checkServices();

describe('E2E smoke', () => {
  it.skipIf(!servicesOk)('FE serves HTML with Vite SPA root', async () => {
    const res = await fetch(FE_URL);
    expect(res.ok).toBe(true);
    const html = await res.text();
    expect(html).toContain('Vrstevnice');
    expect(html).toContain('id="app"'); // SolidJS root div
  });

  it.skipIf(!servicesOk)('BE: /api/geocode forward search for "Praha"', async () => {
    const res = await fetch(`${BE_URL}/api/geocode?q=Praha`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
    expect(data[0]).toHaveProperty('lat');
    expect(data[0]).toHaveProperty('lng');
    expect(data[0]).toHaveProperty('name');
  });

  it.skipIf(!servicesOk)('BE: /api/geocode reverse geocoding (coordinates)', async () => {
    const res = await fetch(`${BE_URL}/api/geocode?q=50.08,14.42`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  it.skipIf(!servicesOk)('BE: /api/history returns array', async () => {
    const res = await fetch(`${BE_URL}/api/history`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  it.skipIf(!servicesOk)('BE: POST /api/route rejects invalid input', async () => {
    // Missing required fields — Elysia should return 4xx
    const res = await fetch(`${BE_URL}/api/route`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bad: 'payload' }),
    });
    // Accept 400, 422, or any 4xx — just not 5xx or 200
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it.skipIf(!servicesOk)('BE: POST /api/route computes a real route with all fields', async () => {
    const res = await fetch(`${BE_URL}/api/route`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stops: [
          { lat: 50.0755, lng: 14.4378, name: 'Praha' },
          { lat: 50.09, lng: 14.42, name: 'Praha-vychod' },
        ],
        elevationCoefficient: 0.5,
        roadAvoidanceCoefficient: 0.5,
        cyclewayCoefficient: 0.5,
      }),
    });
    expect(res.ok).toBe(true);
    const data = await res.json();

    // All required fields present
    expect(data).toHaveProperty('geometry');
    expect(data).toHaveProperty('distance');
    expect(data).toHaveProperty('duration');
    expect(data).toHaveProperty('elevationProfile');
    expect(data).toHaveProperty('surfaceSegments');
    expect(data).toHaveProperty('roadClassSegments');
    expect(data).toHaveProperty('roadEnvSegments');

    // Geometry is [lat, lng] pairs
    expect(Array.isArray(data.geometry)).toBe(true);
    expect(data.geometry.length).toBeGreaterThan(1);
    expect(data.geometry[0]).toHaveLength(2);

    // Reasonable distance
    expect(data.distance).toBeGreaterThan(0);

    // Elevation profile
    expect(Array.isArray(data.elevationProfile)).toBe(true);
    expect(data.elevationProfile.length).toBeGreaterThan(0);

    // Segments present
    expect(Array.isArray(data.surfaceSegments)).toBe(true);
    expect(Array.isArray(data.roadClassSegments)).toBe(true);
    expect(Array.isArray(data.roadEnvSegments)).toBe(true);
  });
});
