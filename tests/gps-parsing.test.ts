import { describe, it, expect } from 'vitest'
import { detectAndParseGPS } from '@vrstevnice/shared'

describe('detectAndParseGPS', () => {
  // ── Decimal Degrees (DD) ──
  describe('Decimal Degrees', () => {
    it('parses "50.7671, 15.0742" (comma+space separator)', () => {
      expect(detectAndParseGPS('50.7671, 15.0742')).toEqual({
        lat: 50.7671,
        lng: 15.0742,
      })
    })

    it('parses "50.7671,15.0742" (comma separator, no space)', () => {
      expect(detectAndParseGPS('50.7671,15.0742')).toEqual({
        lat: 50.7671,
        lng: 15.0742,
      })
    })

    it('parses "50.7671  15.0742" (multiple spaces separator)', () => {
      expect(detectAndParseGPS('50.7671  15.0742')).toEqual({
        lat: 50.7671,
        lng: 15.0742,
      })
    })

    it('parses "50.7671 15.0742" (single space separator)', () => {
      expect(detectAndParseGPS('50.7671 15.0742')).toEqual({
        lat: 50.7671,
        lng: 15.0742,
      })
    })
  })

  // ── Degrees Decimal Minutes (DDM) ──
  describe('Degrees Decimal Minutes (DDM)', () => {
    it('parses "50°46.026\'N 15°04.452\'E"', () => {
      const result = detectAndParseGPS("50°46.026'N 15°04.452'E")
      expect(result).not.toBeNull()
      expect(result!.lat).toBeCloseTo(50.7671, 3)
      expect(result!.lng).toBeCloseTo(15.0742, 3)
    })

    it('parses "50°46.026\'N, 15°04.452\'E" (comma separator)', () => {
      const result = detectAndParseGPS("50°46.026'N, 15°04.452'E")
      expect(result).not.toBeNull()
      expect(result!.lat).toBeCloseTo(50.7671, 3)
      expect(result!.lng).toBeCloseTo(15.0742, 3)
    })
  })

  // ── Degrees Minutes Seconds (DMS) ──
  describe('Degrees Minutes Seconds (DMS)', () => {
    it('parses "50°46\'01.6\\"N 15°04\'27.1\\"E"', () => {
      const result = detectAndParseGPS('50°46\'01.6"N 15°04\'27.1"E')
      expect(result).not.toBeNull()
      expect(result!.lat).toBeCloseTo(50.76711, 4)
      expect(result!.lng).toBeCloseTo(15.07419, 4)
    })

    it('parses DMS with integer seconds', () => {
      const result = detectAndParseGPS('50°46\'01"N 15°04\'27"E')
      expect(result).not.toBeNull()
      expect(result!.lat).toBeCloseTo(50.767, 2)
      expect(result!.lng).toBeCloseTo(15.074, 2)
    })

    it('parses DMS with Unicode ″ (double prime) for seconds', () => {
      const result = detectAndParseGPS('50°46′01.6″N 15°04′27.1″E')
      expect(result).not.toBeNull()
      expect(result!.lat).toBeCloseTo(50.76711, 4)
      expect(result!.lng).toBeCloseTo(15.07419, 4)
    })

    it('parses DMS with Unicode ′ (prime) for minutes', () => {
      const result = detectAndParseGPS("50°46′01.6\"N 15°04′27.1\"E")
      expect(result).not.toBeNull()
      expect(result!.lat).toBeCloseTo(50.76711, 4)
      expect(result!.lng).toBeCloseTo(15.07419, 4)
    })
  })

  // ── Negative coordinates (S/W hemisphere) ──
  describe('Negative coordinates', () => {
    it('parses DD with negative lat (southern hemisphere)', () => {
      expect(detectAndParseGPS('-33.8688, 151.2093')).toEqual({
        lat: -33.8688,
        lng: 151.2093,
      })
    })

    it('parses DD with negative lng (western hemisphere)', () => {
      expect(detectAndParseGPS('40.7128, -74.006')).toEqual({
        lat: 40.7128,
        lng: -74.006,
      })
    })

    it('parses DDM with S/W directions', () => {
      const result = detectAndParseGPS("33°52.128'S 151°12.558'E")
      expect(result).not.toBeNull()
      expect(result!.lat).toBeCloseTo(-33.8688, 3)
      expect(result!.lng).toBeCloseTo(151.2093, 3)
    })

    it('parses DMS with S/W directions', () => {
      const result = detectAndParseGPS('33°52\'07.7"S 151°12\'33.5"E')
      expect(result).not.toBeNull()
      expect(result!.lat).toBeCloseTo(-33.8688, 3)
      expect(result!.lng).toBeCloseTo(151.2093, 3)
    })
  })

  // ── Boundary values ──
  describe('Boundary values', () => {
    it('parses lat=90 (north pole)', () => {
      expect(detectAndParseGPS('90, 0')).toEqual({ lat: 90, lng: 0 })
    })

    it('parses lat=-90 (south pole)', () => {
      expect(detectAndParseGPS('-90, 0')).toEqual({ lat: -90, lng: 0 })
    })

    it('parses lng=180 (date line)', () => {
      expect(detectAndParseGPS('0, 180')).toEqual({ lat: 0, lng: 180 })
    })

    it('parses lng=-180 (date line)', () => {
      expect(detectAndParseGPS('0, -180')).toEqual({ lat: 0, lng: -180 })
    })

    it('parses lat=0, lng=0 (null island)', () => {
      expect(detectAndParseGPS('0, 0')).toEqual({ lat: 0, lng: 0 })
    })
  })

  // ── Invalid inputs ──
  describe('Invalid inputs', () => {
    it('returns null for lat out of range (91)', () => {
      expect(detectAndParseGPS('91, 15')).toBeNull()
    })

    it('returns null for lng out of range (200)', () => {
      expect(detectAndParseGPS('50, 200')).toBeNull()
    })

    it('returns null for non-coordinate text', () => {
      expect(detectAndParseGPS('Liberec')).toBeNull()
    })

    it('returns null for single number only', () => {
      expect(detectAndParseGPS('50.7671')).toBeNull()
    })

    it('returns null for empty string', () => {
      expect(detectAndParseGPS('')).toBeNull()
    })

    it('returns null for whitespace-only string', () => {
      expect(detectAndParseGPS('   ')).toBeNull()
    })

    it('returns null for city name with comma', () => {
      expect(detectAndParseGPS('New York, NY')).toBeNull()
    })
  })

  // ── URL-encoded characters ──
  describe('URL-encoded characters', () => {
    it('decodes %C2%B0 as degree sign in DDM', () => {
      const result = detectAndParseGPS(
        '50%C2%B046.026%27N 15%C2%B004.452%27E',
      )
      expect(result).not.toBeNull()
      expect(result!.lat).toBeCloseTo(50.7671, 3)
      expect(result!.lng).toBeCloseTo(15.0742, 3)
    })

    it('decodes %C2%B0, %22, %27 in DMS', () => {
      const result = detectAndParseGPS(
        '50%C2%B046%2701.6%22N 15%C2%B004%2727.1%22E',
      )
      expect(result).not.toBeNull()
      expect(result!.lat).toBeCloseTo(50.76711, 4)
      expect(result!.lng).toBeCloseTo(15.07419, 4)
    })

    it('decodes %2C as comma in DD', () => {
      expect(detectAndParseGPS('50.7671%2C15.0742')).toEqual({
        lat: 50.7671,
        lng: 15.0742,
      })
    })

    it('decodes %20 as space in DD', () => {
      expect(detectAndParseGPS('50.7671%2015.0742')).toEqual({
        lat: 50.7671,
        lng: 15.0742,
      })
    })

    it('decodes + as space in DD', () => {
      expect(detectAndParseGPS('50.7671+15.0742')).toEqual({
        lat: 50.7671,
        lng: 15.0742,
      })
    })
  })

  // ── Quote variations ──
  describe('Quote variations for seconds', () => {
    it('parses DMS with ASCII " for seconds', () => {
      const result = detectAndParseGPS('50°46\'01.6"N 15°04\'27.1"E')
      expect(result).not.toBeNull()
      expect(result!.lat).toBeCloseTo(50.76711, 4)
      expect(result!.lng).toBeCloseTo(15.07419, 4)
    })

    it('parses DMS with Unicode ″ (double prime) for seconds', () => {
      const result = detectAndParseGPS('50°46′01.6″N 15°04′27.1″E')
      expect(result).not.toBeNull()
      expect(result!.lat).toBeCloseTo(50.76711, 4)
      expect(result!.lng).toBeCloseTo(15.07419, 4)
    })

    it('parses DMS with two single quotes \'\' for seconds', () => {
      const result = detectAndParseGPS("50°46'01.6''N 15°04'27.1''E")
      expect(result).not.toBeNull()
      expect(result!.lat).toBeCloseTo(50.76711, 4)
      expect(result!.lng).toBeCloseTo(15.07419, 4)
    })
  })
})
