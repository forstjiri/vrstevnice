import { resolve } from 'node:path'
import { inflateSync } from 'node:zlib'
import { Database as SqliteDb } from 'bun:sqlite'
import {
  computeGeometryDistances,
  findPositionAtDistance,
  parseLocalDateTime,
  type ShadowPoint,
} from '@vrstevnice/shared'

const PROJECT_ROOT = resolve(import.meta.dir, '..', '..')
const TERRAIN_MBTILES = resolve(PROJECT_ROOT, 'data', 'cz-terrain.mbtiles')
const TERRAIN_ZOOM = 14
const MAX_LAT = 85.05112878
const TILE_CACHE_LIMIT = 256
const HEIGHT_CACHE_LIMIT = 8192
const SAMPLE_INTERVAL_M = 50
const STEP_M = 40
const MAX_RAY_M = 6000
const LOW_SUN_ALTITUDE_DEG = 12
const VERY_LOW_SUN_ALTITUDE_DEG = 6
const LOW_SUN_RAY_M = 12_000
const VERY_LOW_SUN_RAY_M = 20_000
const SUN_EXPOSURE_FULL_MARGIN_DEG = 8
const SUN_EXPOSURE_ZERO_MARGIN_DEG = -1

interface DecodedTile {
  width: number
  height: number
  pixels: Uint8Array
}

interface ShadowProfileOptions {
  sampleIntervalM?: number
  stepM?: number
  maxRayM?: number
  durationMs?: number
}

let terrainDb: SqliteDb | null = null
try {
  terrainDb = new SqliteDb(TERRAIN_MBTILES, { readonly: true })
  console.log(`[terrain] Loaded ${TERRAIN_MBTILES}`)
} catch {
  console.warn(`[terrain] No mbtiles at ${TERRAIN_MBTILES}, terrain shadow disabled`)
}

const tileCache = new Map<string, DecodedTile | null>()
const heightCache = new Map<string, number | null>()

export function hasTerrainData(): boolean {
  return terrainDb !== null
}

export function readTerrainTile(z: number, x: number, y: number): Buffer | null {
  if (!terrainDb) return null
  try {
    const tmsY = (1 << z) - 1 - y
    const row = terrainDb.prepare(
      'SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?',
    ).get(z, x, tmsY) as { tile_data: Uint8Array } | undefined
    if (!row?.tile_data || row.tile_data.length === 0) return null
    return Buffer.from(row.tile_data)
  } catch (error) {
    console.error('[terrain] mbtiles read error:', error)
    return null
  }
}

export function computeShadowProfile(
  geometry: [number, number][],
  datetime: string,
  options: ShadowProfileOptions = {},
): ShadowPoint[] {
  if (!terrainDb || geometry.length < 2) return []

  const date = parseLocalDateTime(datetime)
  if (!date) return []

  const geometryDistances = computeGeometryDistances(geometry)
  const totalDistance = geometryDistances[geometryDistances.length - 1] ?? 0
  if (totalDistance <= 0) return []

  const sampleInterval = clampPositive(options.sampleIntervalM, SAMPLE_INTERVAL_M)
  const configuredStepM = clampPositive(options.stepM, STEP_M)
  const configuredMaxRayM = clampPositive(options.maxRayM, MAX_RAY_M)
  const durationMs = typeof options.durationMs === 'number' && Number.isFinite(options.durationMs) && options.durationMs > 0
    ? options.durationMs
    : 0

  const profile: ShadowPoint[] = []
  for (let distance = 0; distance <= totalDistance; distance += sampleInterval) {
    const pos = findPositionAtDistance(geometry, geometryDistances, distance)
    if (!pos) continue
    const sampleDate = durationMs > 0
      ? new Date(date.getTime() + (distance / totalDistance) * durationMs)
      : date
    const sun = getSunPosition(sampleDate, pos[0], pos[1])
    const sunExposure = computeSunExposureAtPoint(pos[0], pos[1], sun.altitudeDeg, sun.azimuthDeg, configuredStepM, configuredMaxRayM)
    profile.push({
      distance,
      shadow: sunExposure < 0.5,
      sunExposure,
    })
  }

  if (profile.length === 0 || profile[profile.length - 1].distance < totalDistance) {
    const pos = findPositionAtDistance(geometry, geometryDistances, totalDistance)
    if (pos) {
      const sampleDate = durationMs > 0 ? new Date(date.getTime() + durationMs) : date
      const sun = getSunPosition(sampleDate, pos[0], pos[1])
      const sunExposure = computeSunExposureAtPoint(pos[0], pos[1], sun.altitudeDeg, sun.azimuthDeg, configuredStepM, configuredMaxRayM)
      profile.push({
        distance: totalDistance,
        shadow: sunExposure < 0.5,
        sunExposure,
      })
    }
  }

  return profile
}

function computeSunExposureAtPoint(
  lat: number,
  lng: number,
  altitudeDeg: number,
  azimuthDeg: number,
  configuredStepM: number,
  configuredMaxRayM: number,
): number {
  if (altitudeDeg <= 0) return 0

  const baseElevation = getTerrainElevation(lat, lng)
  if (baseElevation === null) return 0

  const maxRayM = getEffectiveMaxRayMeters(altitudeDeg, configuredMaxRayM)
  const stepM = getEffectiveStepMeters(altitudeDeg, configuredStepM, maxRayM)

  let maxHorizonDeg = -90
  for (let rayDistance = stepM; rayDistance <= maxRayM; rayDistance += stepM) {
    const sample = destinationPoint(lat, lng, azimuthDeg, rayDistance)
    const sampleElevation = getTerrainElevation(sample.lat, sample.lng)
    if (sampleElevation === null) continue
    const horizonDeg = radiansToDegrees(Math.atan2(sampleElevation - baseElevation, rayDistance))
    if (horizonDeg > maxHorizonDeg) maxHorizonDeg = horizonDeg
  }

  const marginDeg = altitudeDeg - maxHorizonDeg
  return smoothstep(SUN_EXPOSURE_ZERO_MARGIN_DEG, SUN_EXPOSURE_FULL_MARGIN_DEG, marginDeg)
}

function getTerrainElevation(lat: number, lng: number): number | null {
  const key = `${lat.toFixed(5)},${lng.toFixed(5)}`
  const cached = heightCache.get(key)
  if (cached !== undefined) return cached

  const sample = sampleTerrarium(lat, lng, TERRAIN_ZOOM)
  if (heightCache.size >= HEIGHT_CACHE_LIMIT) {
    const oldestKey = heightCache.keys().next().value
    if (oldestKey) heightCache.delete(oldestKey)
  }
  heightCache.set(key, sample)
  return sample
}

function sampleTerrarium(lat: number, lng: number, zoom: number): number | null {
  const n = 1 << zoom
  const clampedLat = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat))
  const normalizedLng = ((lng + 180) % 360 + 360) % 360 - 180
  const latRad = degreesToRadians(clampedLat)
  const x = ((normalizedLng + 180) / 360) * n
  const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) * 0.5 * n

  const tileX = Math.min(n - 1, Math.max(0, Math.floor(x)))
  const tileY = Math.min(n - 1, Math.max(0, Math.floor(y)))
  const tile = getDecodedTile(zoom, tileX, tileY)
  if (!tile) return null

  const pixelX = Math.min(tile.width - 1, Math.max(0, Math.floor((x - tileX) * tile.width)))
  const pixelY = Math.min(tile.height - 1, Math.max(0, Math.floor((y - tileY) * tile.height)))
  const offset = (pixelY * tile.width + pixelX) * 3
  const r = tile.pixels[offset]
  const g = tile.pixels[offset + 1]
  const b = tile.pixels[offset + 2]
  return r * 256 + g + b / 256 - 32768
}

function getDecodedTile(z: number, x: number, y: number): DecodedTile | null {
  const key = `${z}/${x}/${y}`
  if (tileCache.has(key)) return tileCache.get(key) ?? null
  const rawTile = readTerrainTile(z, x, y)
  const decoded = rawTile ? decodePngRgb(rawTile) : null
  if (tileCache.size >= TILE_CACHE_LIMIT) {
    const oldestKey = tileCache.keys().next().value
    if (oldestKey) tileCache.delete(oldestKey)
  }
  tileCache.set(key, decoded)
  return decoded
}

function decodePngRgb(png: Uint8Array): DecodedTile | null {
  if (png.length < 33) return null
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  for (let i = 0; i < signature.length; i++) {
    if (png[i] !== signature[i]) return null
  }

  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const idatParts: Uint8Array[] = []

  while (offset + 8 <= png.length) {
    const length = readUint32(png, offset)
    offset += 4
    const type = String.fromCharCode(png[offset], png[offset + 1], png[offset + 2], png[offset + 3])
    offset += 4
    if (offset + length + 4 > png.length) return null
    const chunk = png.subarray(offset, offset + length)
    offset += length + 4

    if (type === 'IHDR') {
      width = readUint32(chunk, 0)
      height = readUint32(chunk, 4)
      bitDepth = chunk[8]
      colorType = chunk[9]
      interlace = chunk[12]
    } else if (type === 'IDAT') {
      idatParts.push(chunk)
    } else if (type === 'IEND') {
      break
    }
  }

  if (!width || !height || bitDepth !== 8 || colorType !== 2 || interlace !== 0 || idatParts.length === 0) {
    return null
  }

  const compressed = concatUint8Arrays(idatParts)
  const inflated = new Uint8Array(inflateSync(compressed))
  const bytesPerPixel = 3
  const rowBytes = width * bytesPerPixel
  const expectedLength = height * (1 + rowBytes)
  if (inflated.length < expectedLength) return null

  const pixels = new Uint8Array(width * height * bytesPerPixel)
  let srcOffset = 0
  let dstOffset = 0
  let prevRow = new Uint8Array(rowBytes)
  const row = new Uint8Array(rowBytes)

  for (let y = 0; y < height; y++) {
    const filter = inflated[srcOffset++]
    row.set(inflated.subarray(srcOffset, srcOffset + rowBytes))
    srcOffset += rowBytes
    unfilterScanline(filter, row, prevRow, bytesPerPixel)
    pixels.set(row, dstOffset)
    dstOffset += rowBytes
    prevRow = row.slice()
  }

  return { width, height, pixels }
}

function unfilterScanline(filter: number, row: Uint8Array, prevRow: Uint8Array, bytesPerPixel: number) {
  switch (filter) {
    case 0:
      return
    case 1:
      for (let i = 0; i < row.length; i++) {
        const left = i >= bytesPerPixel ? row[i - bytesPerPixel] : 0
        row[i] = (row[i] + left) & 0xff
      }
      return
    case 2:
      for (let i = 0; i < row.length; i++) {
        row[i] = (row[i] + prevRow[i]) & 0xff
      }
      return
    case 3:
      for (let i = 0; i < row.length; i++) {
        const left = i >= bytesPerPixel ? row[i - bytesPerPixel] : 0
        const up = prevRow[i]
        row[i] = (row[i] + Math.floor((left + up) / 2)) & 0xff
      }
      return
    case 4:
      for (let i = 0; i < row.length; i++) {
        const left = i >= bytesPerPixel ? row[i - bytesPerPixel] : 0
        const up = prevRow[i]
        const upLeft = i >= bytesPerPixel ? prevRow[i - bytesPerPixel] : 0
        row[i] = (row[i] + paethPredictor(left, up, upLeft)) & 0xff
      }
      return
    default:
      throw new Error(`Unsupported PNG filter type: ${filter}`)
  }
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

function readUint32(data: Uint8Array, offset: number): number {
  return ((data[offset] << 24) >>> 0) + (data[offset + 1] << 16) + (data[offset + 2] << 8) + data[offset + 3]
}

function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

function clampPositive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function degreesToRadians(deg: number): number {
  return (deg * Math.PI) / 180
}

function radiansToDegrees(rad: number): number {
  return (rad * 180) / Math.PI
}

function destinationPoint(lat: number, lng: number, bearingDeg: number, distanceM: number) {
  const angularDistance = distanceM / 6_371_000
  const bearing = degreesToRadians(bearingDeg)
  const lat1 = degreesToRadians(lat)
  const lng1 = degreesToRadians(lng)

  const sinLat1 = Math.sin(lat1)
  const cosLat1 = Math.cos(lat1)
  const sinAd = Math.sin(angularDistance)
  const cosAd = Math.cos(angularDistance)

  const lat2 = Math.asin(sinLat1 * cosAd + cosLat1 * sinAd * Math.cos(bearing))
  const lng2 = lng1 + Math.atan2(
    Math.sin(bearing) * sinAd * cosLat1,
    cosAd - sinLat1 * Math.sin(lat2),
  )

  return {
    lat: radiansToDegrees(lat2),
    lng: ((radiansToDegrees(lng2) + 540) % 360) - 180,
  }
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (x <= edge0) return 0
  if (x >= edge1) return 1
  const t = (x - edge0) / (edge1 - edge0)
  return t * t * (3 - 2 * t)
}

function getEffectiveMaxRayMeters(altitudeDeg: number, configuredMaxRayM: number): number {
  if (altitudeDeg <= VERY_LOW_SUN_ALTITUDE_DEG) return Math.max(configuredMaxRayM, VERY_LOW_SUN_RAY_M)
  if (altitudeDeg <= LOW_SUN_ALTITUDE_DEG) return Math.max(configuredMaxRayM, LOW_SUN_RAY_M)
  return configuredMaxRayM
}

function getEffectiveStepMeters(altitudeDeg: number, configuredStepM: number, maxRayM: number): number {
  if (altitudeDeg <= VERY_LOW_SUN_ALTITUDE_DEG) return Math.min(configuredStepM, Math.max(25, Math.round(maxRayM / 500)))
  if (altitudeDeg <= LOW_SUN_ALTITUDE_DEG) return Math.min(configuredStepM, Math.max(30, Math.round(maxRayM / 400)))
  return configuredStepM
}

function getSunPosition(date: Date, lat: number, lng: number) {
  const e = degreesToRadians(23.4397)
  const lw = degreesToRadians(-lng)
  const phi = degreesToRadians(lat)
  const d = toDays(date)
  const m = solarMeanAnomaly(d)
  const l = eclipticLongitude(m)
  const dec = declination(l, 0, e)
  const ra = rightAscension(l, 0, e)
  const h = siderealTime(d, lw) - ra
  const altitude = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(h))
  const azimuth = Math.atan2(Math.sin(h), Math.cos(h) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi))
  return {
    altitudeDeg: radiansToDegrees(altitude),
    azimuthDeg: (radiansToDegrees(azimuth) + 180 + 360) % 360,
  }
}

function toDays(date: Date): number {
  return date.valueOf() / 86_400_000 - 0.5 + 2_440_588 - 2_451_545
}

function solarMeanAnomaly(d: number): number {
  return degreesToRadians(357.5291 + 0.98560028 * d)
}

function eclipticLongitude(m: number): number {
  const c = degreesToRadians(1.9148) * Math.sin(m)
    + degreesToRadians(0.02) * Math.sin(2 * m)
    + degreesToRadians(0.0003) * Math.sin(3 * m)
  const p = degreesToRadians(102.9372)
  return m + c + p + Math.PI
}

function rightAscension(l: number, b: number, e: number): number {
  return Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l))
}

function declination(l: number, b: number, e: number): number {
  return Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l))
}

function siderealTime(d: number, lw: number): number {
  return degreesToRadians(280.16 + 360.9856235 * d) - lw
}
