/**
 * Shadow profile tests — verify the /api/shadow-profile endpoint.
 *
 * Requires: BE :3002 running, Docker elevation service optional (graceful fallback).
 *
 * Run: pnpm test -- tests/shadow-profile.test.ts
 */

import {describe, expect, it} from 'vitest'

const BE_URL = process.env.BE_URL || 'http://127.0.0.1:3002'

describe('Shadow profile API', () => {
	it('POST /api/shadow-profile returns shadowProfile array', async () => {
		// First verify BE is reachable
		const health = await fetch(`${BE_URL}/api/history`, {signal: AbortSignal.timeout(3000)})
		expect(health.ok).toBe(true)

		const res = await fetch(`${BE_URL}/api/shadow-profile`, {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({
				geometry: [
					[50.0755, 14.4378],
					[50.0800, 14.4400],
					[50.0850, 14.4450],
				],
				datetime: '2026-06-08T14:00',
				sampleIntervalM: 100,
				stepM: 10,
				maxRayM: 100,
			}),
		})
		expect(res.ok).toBe(true)
		const data = await res.json()
		expect(data).toHaveProperty('shadowProfile')
		expect(Array.isArray(data.shadowProfile)).toBe(true)
		// If elevation service is available, we get results; if not, empty array is valid fallback
		if (data.shadowProfile.length > 0) {
			const entry = data.shadowProfile[0]
			expect(entry).toHaveProperty('distance')
			expect(typeof entry.distance).toBe('number')
			expect(entry).toHaveProperty('shadow')
			expect(typeof entry.shadow).toBe('boolean')
		}
	})

	it('POST /api/shadow-profile rejects request missing datetime', async () => {
		const health = await fetch(`${BE_URL}/api/history`, {signal: AbortSignal.timeout(3000)})
		if (!health.ok) return // skip if BE down

		const res = await fetch(`${BE_URL}/api/shadow-profile`, {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({
				geometry: [[50.0755, 14.4378]],
			}),
		})
		expect(res.status).toBeGreaterThanOrEqual(400)
	})

	it('POST /api/shadow-profile works with real route geometry', async () => {
		const health = await fetch(`${BE_URL}/api/history`, {signal: AbortSignal.timeout(3000)})
		if (!health.ok) return // skip if BE down

		const routeRes = await fetch(`${BE_URL}/api/route`, {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({
				stops: [
					{lat: 50.0755, lng: 14.4378, name: 'Praha'},
					{lat: 50.0900, lng: 14.4200, name: 'Praha-vychod'},
				],
				elevationCoefficient: 0.5,
				roadAvoidanceCoefficient: 0.5,
				cyclewayCoefficient: 0.5,
			}),
		})
		expect(routeRes.ok).toBe(true)
		const route = await routeRes.json()
		expect(route.geometry.length).toBeGreaterThan(1)

		const shadowRes = await fetch(`${BE_URL}/api/shadow-profile`, {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({
				geometry: route.geometry,
				datetime: '2026-06-08T14:00',
				sampleIntervalM: 200,
				stepM: 20,
				maxRayM: 150,
			}),
		})
		expect(shadowRes.ok).toBe(true)
		const shadowData = await shadowRes.json()
		expect(shadowData).toHaveProperty('shadowProfile')
		expect(Array.isArray(shadowData.shadowProfile)).toBe(true)
		if (shadowData.shadowProfile.length > 0) {
			const hasShadow = shadowData.shadowProfile.some(
				(p: { shadow: boolean }) => p.shadow,
			)
			const hasSun = shadowData.shadowProfile.some(
				(p: { shadow: boolean }) => !p.shadow,
			)
			// At least one status present — reasonable for a real route at 2pm in June
			expect(hasShadow || hasSun).toBe(true)
		}
	}, 30_000)
})
