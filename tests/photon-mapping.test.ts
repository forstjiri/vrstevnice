import { describe, it, expect } from 'vitest'
import { mapPhotonFeature } from '../src/be/geocode'

describe('mapPhotonFeature', () => {
  it('swaps GeoJSON [lon, lat] → Leaflet [lat, lng]', () => {
    const feature = {
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [15.0742, 50.7671], // [lon, lat] in GeoJSON
      },
      properties: {
        name: 'Liberec',
        city: 'Liberec',
        country: 'Czechia',
      },
    }

    const result = mapPhotonFeature(feature)

    expect(result.lat).toBe(50.7671)
    expect(result.lng).toBe(15.0742)
  })

  it('constructs displayName from name + city + country', () => {
    const feature = {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [14.42, 50.08] },
      properties: {
        name: 'Praha',
        city: 'Praha',
        country: 'Česko',
      },
    }

    const result = mapPhotonFeature(feature)

    expect(result.displayName).toBe('Praha, Praha, Česko')
    expect(result.name).toBe('Praha')
  })

  it('falls back to street when name is missing', () => {
    const feature = {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [16.6, 49.2] },
      properties: {
        street: 'Husova',
        city: 'Brno',
        country: 'Czechia',
      },
    }

    const result = mapPhotonFeature(feature)

    expect(result.name).toBe('Husova')
  })

  it('falls back to "Unknown" when both name and street are missing', () => {
    const feature = {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [14.42, 50.08] },
      properties: {
        city: 'Praha',
      },
    }

    const result = mapPhotonFeature(feature)

    expect(result.name).toBe('Unknown')
  })

  it('handles feature with only coordinates and minimal properties', () => {
    const feature = {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [12.0, 48.0] },
      properties: {},
    }

    const result = mapPhotonFeature(feature)

    expect(result.lat).toBe(48.0)
    expect(result.lng).toBe(12.0)
    expect(result.name).toBe('Unknown')
    expect(result.displayName).toBe('Unknown location')
  })

  it('handles missing geometry with default [0, 0]', () => {
    const feature = {
      type: 'Feature',
      properties: { name: 'Test' },
    }

    const result = mapPhotonFeature(feature)

    expect(result.lat).toBe(0)
    expect(result.lng).toBe(0)
  })

  it('includes housenumber and postcode in displayName when present', () => {
    const feature = {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [14.42, 50.08] },
      properties: {
        name: 'Kavárna',
        street: 'Vaclavské náměstí',
        housenumber: '42',
        city: 'Praha',
        postcode: '11000',
        country: 'Česko',
      },
    }

    const result = mapPhotonFeature(feature)

    expect(result.displayName).toBe(
      'Kavárna, Vaclavské náměstí, 42, Praha, 11000, Česko',
    )
  })

  it('filters out empty string and null properties from displayName', () => {
    const feature = {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [14.42, 50.08] },
      properties: {
        name: 'Test',
        street: '',
        city: null as unknown as string,
        country: 'CZ',
      },
    }

    const result = mapPhotonFeature(feature)

    // Only name and country should appear
    expect(result.displayName).toBe('Test, CZ')
  })
})
