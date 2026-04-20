/**
 * Pure mapping functions for Photon geocode responses.
 * No runtime dependencies — safe to import in Vitest (Node) tests.
 */

interface GeocodeResult {
  lat: number
  lng: number
  name: string
  displayName: string
}

/** Map a single Photon GeoJSON feature to a GeocodeResult. */
export function mapPhotonFeature(feature: any): GeocodeResult {
  const props = feature.properties ?? {}
  const coordinates = feature.geometry?.coordinates ?? [0, 0]

  // IMPORTANT: GeoJSON [lon, lat] → Leaflet [lat, lng] (Decision D032)
  const lat = coordinates[1]
  const lng = coordinates[0]

  const displayName = [
    props.name,
    props.street,
    props.housenumber,
    props.city,
    props.postcode,
    props.country,
  ]
    .filter((v: string | undefined) => v != null && v !== '')
    .join(', ')

  return {
    lat,
    lng,
    name: props.name || props.street || 'Unknown',
    displayName: displayName || 'Unknown location',
  }
}
