import type { RouteResponse, ElevationPoint } from '@vrstevnice/shared'
import { computeGeometryDistances } from '@vrstevnice/shared'

/**
 * Interleave geometry points with elevation data by matching cumulative distances.
 *
 * For each geometry point, finds the closest elevation sample by cumulative distance
 * and merges the elevation value. Uses Math.min to guard against index overflow.
 */
function mergeElevation(
  geometry: [number, number][],
  elevationProfile: ElevationPoint[],
): { lat: number; lon: number; ele: number }[] {
  if (elevationProfile.length === 0) {
    return geometry.map(([lat, lon]) => ({ lat, lon, ele: 0 }))
  }

  // Pre-compute cumulative distances for geometry
  const geoDistances = computeGeometryDistances(geometry)

  // Elevation profile distances are already cumulative
  const elevDistances = elevationProfile.map(e => e.distance)

  return geometry.map(([lat, lon], i) => {
    const dist = geoDistances[i]

    // Find closest elevation sample by distance
    // For large profiles, binary search would be better, but profiles are typically < 1000
    let bestIdx = 0
    let bestDelta = Math.abs(elevDistances[0] - dist)
    for (let j = 1; j < elevDistances.length; j++) {
      const delta = Math.abs(elevDistances[j] - dist)
      if (delta < bestDelta) {
        bestDelta = delta
        bestIdx = j
      }
    }

    // Safety: Math.min to guard against any index overflow
    const safeIdx = Math.min(bestIdx, elevationProfile.length - 1)
    const ele = Math.round(elevationProfile[safeIdx].elevation)

    return { lat, lon, ele }
  })
}

/**
 * Build a GPX XML string from a RouteResponse.
 *
 * Includes route metadata (distance, duration, elevation gain/loss)
 * and track points with latitude, longitude, and elevation data
 * interleaved from the geometry and elevationProfile.
 */
function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function generateGPX(route: RouteResponse): string {
  const merged = mergeElevation(route.geometry, route.elevationProfile)
  const time = new Date().toISOString()

  const trackpoints = merged
    .map(p => `      <trkpt lat="${p.lat}" lon="${p.lon}"><ele>${p.ele}</ele></trkpt>`)
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Vrstevnice"
  xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>Vrstevnice Route</name>
    <time>${time}</time>
    <desc>${escapeXml(`${(route.distance / 1000).toFixed(1)} km, ${Math.round(route.duration / 60)} min, ↑${route.elevationGain}m ↓${route.elevationLoss}m`)}</desc>
  </metadata>
  <trk>
    <name>Route</name>
    <trkseg>
${trackpoints}
    </trkseg>
  </trk>
</gpx>
`
}

/**
 * Trigger a browser download of a GPX file.
 *
 * Creates a Blob from the GPX string, generates a temporary download URL,
 * clicks a hidden anchor to trigger the download, then revokes the URL.
 */
export function downloadGPX(route: RouteResponse, filename?: string): void {
  const xml = generateGPX(route)
  const blob = new Blob([xml], { type: 'application/gpx+xml' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename || `vrstevnice-${Date.now()}.gpx`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
