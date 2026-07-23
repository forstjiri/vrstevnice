/**
 * Local POI lookup — queries data/cz-pois.sqlite (extracted from OSM PBF by
 * scripts/import-pois.py). Replaces the external Overpass API used previously.
 *
 * SQLite is opened read-only (immutable=1) and shared as a module-level singleton.
 * Each query uses a bounding-box pre-filter (cheap with idx_pois_lat_lng) followed
 * by an exact haversine post-filter.
 */
import { Database } from 'bun:sqlite';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { haversineMeters, type POILocation } from '@vrstevnice/shared';

const PROJECT_ROOT = resolve(import.meta.dir, '..', '..');
const POI_DB_PATH = resolve(PROJECT_ROOT, 'data', 'cz-pois.sqlite');

// Read-only + immutable=1 → safe shared handle, no WAL journaling overhead
let db: Database | null = null;

function getDb(): Database | null {
  if (db) return db;
  if (!existsSync(POI_DB_PATH)) {
    return null;
  }
  try {
    db = new Database(POI_DB_PATH, { readonly: true });
    return db;
  } catch {
    return null;
  }
}

/**
 * Query POIs within `radius` meters of (lat, lng).
 *
 * Bounding-box pre-filter:
 *   1° lat ≈ 111 km → dLat = radius / 111_000
 *   1° lng ≈ 111 km × cos(lat) → dLng shrinks toward poles
 * Bounding box is widened by 5% to compensate for the rectilinear → circular
 * conversion (corners of the bbox extend further than the inscribed circle).
 *
 * Then haversine post-filter trims to the actual radius circle.
 *
 * Graceful fallback: returns [] if the DB file is missing or unreadable.
 */
export default async function queryLocalPOIs(
  lat: number,
  lng: number,
  radius: number,
): Promise<POILocation[]> {
  const handle = getDb();
  if (!handle) return [];

  // Bounding box: widen by 5% to cover circle corners
  const dLat = (radius / 111_000) * 1.05;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const dLng = (radius / (111_000 * Math.max(0.1, cosLat))) * 1.05;

  const minLat = lat - dLat;
  const maxLat = lat + dLat;
  const minLng = lng - dLng;
  const maxLng = lng + dLng;

  const stmt = handle.query<POILocation, [number, number, number, number]>(
    `SELECT lat, lng, name, type FROM pois
     WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?`,
  );

  const results: POILocation[] = [];
  stmt.all(minLat, maxLat, minLng, maxLng).forEach((row) => {
    if (haversineMeters(lat, lng, row.lat, row.lng) <= radius) {
      results.push(row);
    }
  });
  return results;
}
