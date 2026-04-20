/**
 * Pure GPS coordinate parsing functions.
 * Detects and parses Decimal Degrees (DD), Degrees Decimal Minutes (DDM),
 * and Degrees Minutes Seconds (DMS) formats into {lat, lng}.
 * No runtime dependencies — safe to import in Vitest (Node) tests.
 */

export interface GpsCoord {
  lat: number
  lng: number
}

/**
 * Decode common URL-encoded characters that appear in GPS coordinates:
 * %C2%B0 → ° (UTF-8 encoded degree sign)
 * %27 → '
 * %22 → "
 * ″ → "
 */
function normalizeInput(input: string): string {
  return input
    .replace(/%C2%B0/gi, '°')
    .replace(/%2C/gi, ',')
    .replace(/%27/gi, "'")
    .replace(/%22/gi, '"')
    .replace(/%20/gi, ' ')
    .replace(/%09/gi, ' ')
    .replace(/%0A/gi, ' ')
    .replace(/%0D/gi, ' ')
    .replace(/\+/g, ' ')
    // Unicode smart quotes → ASCII equivalents
    .replace(/″/g, '"')
    .replace(/′/g, "'")
}

/**
 * Parse a DMS/DDM-style coordinate string like "50°46'01.6\"N" or "50°46.026'N".
 * Returns the decimal degrees value (negated for S/W), or NaN if no match.
 */
function parseDmsPart(s: string): number {
  // DMS: DD°MM'SS.s"Dir  → capture DD, MM, SS, direction
  // Supports " ″ '' and '' (two single quotes) as seconds delimiter
  let m = s.match(
    /^\s*(-?\d+(?:\.\d+)?)\s*°\s*(\d+(?:\.\d+)?)\s*'\s*(\d+(?:\.\d+)?)\s*(?:["″]|'')\s*([NSEWnsew])\s*$/,
  )
  if (m) {
    const dd = parseFloat(m[1])
    const mm = parseFloat(m[2])
    const ss = parseFloat(m[3])
    const dir = m[4].toUpperCase()
    let result = dd + mm / 60 + ss / 3600
    if (dir === 'S' || dir === 'W') result = -result
    return result
  }

  // DDM: DD°MM.mmm'Dir → capture DD, MM.mmm, direction
  m = s.match(
    /^\s*(-?\d+(?:\.\d+)?)\s*°\s*(\d+(?:\.\d+)?)\s*['′]\s*([NSEWnsew])\s*$/,
  )
  if (m) {
    const dd = parseFloat(m[1])
    const mm = parseFloat(m[2])
    const dir = m[3].toUpperCase()
    let result = dd + mm / 60
    if (dir === 'S' || dir === 'W') result = -result
    return result
  }

  return NaN
}

/**
 * Detect and parse GPS coordinates from a string.
 * Supports three formats:
 *   1. Decimal Degrees: "50.7671, 15.0742"
 *   2. Degrees Decimal Minutes: "50°46.026'N 15°04.452'E"
 *   3. Degrees Minutes Seconds: "50°46'01.6"N 15°04'27.1"E"
 *
 * Returns {lat, lng} on success, null if the input doesn't look like GPS coordinates.
 */
export function detectAndParseGPS(input: string): GpsCoord | null {
  if (!input || input.trim().length === 0) return null

  const normalized = normalizeInput(input.trim())

  // ── DMS / DDM format ──
  // Two coordinate parts separated by spaces, each with directional suffix
  // Patterns: "A B" or "A, B" or "A  B"
  const parts = normalized.split(/[\s,]+/).filter((p) => p.length > 0)

  if (parts.length >= 2) {
    // Try to detect DMS/DDM by looking for the first part containing °
    if (parts[0].includes('°')) {
      // Find where the first coordinate ends and second begins.
      // Strategy: greedily consume tokens for part1 until we hit another number followed by °
      let part1End = 1
      for (let i = 1; i < parts.length; i++) {
        if (parts[i].includes('°')) {
          part1End = i
          break
        }
        part1End = i + 1
      }

      const part1 = parts.slice(0, part1End).join(' ')
      const part2 = parts.slice(part1End).join(' ')

      if (part1.length > 0 && part2.length > 0) {
        const v1 = parseDmsPart(part1)
        const v2 = parseDmsPart(part2)

        if (!isNaN(v1) && !isNaN(v2)) {
          // Determine which is lat vs lng based on direction letters
          const dir1 = part1.toUpperCase()
          const dir2 = part2.toUpperCase()

          const isLat1 = dir1.includes('N') || dir1.includes('S')
          const isLng1 = dir1.includes('E') || dir1.includes('W')

          let lat: number
          let lng: number

          if (isLat1) {
            lat = v1
            lng = v2
          } else if (isLng1) {
            lng = v1
            lat = v2
          } else {
            // No direction hint — assume first is lat, second is lng
            lat = v1
            lng = v2
          }

          if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
            return { lat, lng }
          }
        }
      }
    }
  }

  // ── Decimal Degrees (DD): pair of floats ──
  // Accepts: "lat, lng", "lat lng", "lat,lng"
  const ddMatch = normalized.match(
    /^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/,
  )
  if (ddMatch) {
    const a = parseFloat(ddMatch[1])
    const b = parseFloat(ddMatch[2])

    // Validate range — at least one must be valid lat, the other valid lng
    const pairs: [number, number][] = [[a, b]]
    for (const [candidateLat, candidateLng] of pairs) {
      if (
        Math.abs(candidateLat) <= 90 &&
        Math.abs(candidateLng) <= 180
      ) {
        return { lat: candidateLat, lng: candidateLng }
      }
    }
  }

  return null
}
