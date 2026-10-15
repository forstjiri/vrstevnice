import { drizzle } from 'drizzle-orm/bun-sqlite';
import { sql } from 'drizzle-orm/sql';
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  sqliteTable, text, real, integer, unique,
} from 'drizzle-orm/sqlite-core';

/**
 * Safely add a column to an existing table. No-op if column already exists.
 */
const PROJECT_ROOT = resolve(import.meta.dir, '..', '..');
const DATA_DIR = resolve(PROJECT_ROOT, 'data');

mkdirSync(DATA_DIR, { recursive: true });

const sqlite = new Database(resolve(DATA_DIR, 'data.db'));

function enableForeignKeys(sqliteHandle: Database): void {
  sqliteHandle.exec('PRAGMA foreign_keys = ON');
  const enabled = sqliteHandle.query('PRAGMA foreign_keys').get() as
    | { foreign_keys?: number }
    | null;
  if (enabled?.foreign_keys !== 1) {
    throw new Error('SQLite foreign key enforcement could not be enabled');
  }
}

function ensureColumn(sqliteHandle: Database, table: string, column: string, definition: string) {
  try {
    sqliteHandle.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (error) {
    // Only the expected idempotency error is safe to ignore. A malformed or
    // otherwise inaccessible schema must fail initialization loudly.
    if (error instanceof Error && error.message.includes('duplicate column name')) return;
    throw error;
  }
}

sqlite.exec('PRAGMA journal_mode=WAL');
enableForeignKeys(sqlite);
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS routes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    stops TEXT NOT NULL,
    geometry TEXT NOT NULL,
    distance REAL,
    duration REAL,
    elevation_gain REAL,
    elevation_loss REAL,
    elevation_profile TEXT,
    surface_segments TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

/**
 * Initializes and upgrades the road-rating persistence schema on the supplied
 * SQLite handle. Kept injectable so migrations use the exact production SQL
 * in isolated regression tests.
 */
export function initializeRoadRatingSchema(sqliteHandle: Database): void {
  enableForeignKeys(sqliteHandle);
  sqliteHandle.exec(`
  CREATE TABLE IF NOT EXISTS rated_roads (
    way_id INTEGER PRIMARY KEY,
    name TEXT,
    geometry TEXT NOT NULL,
    anchor_lat REAL NOT NULL,
    anchor_lng REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS rated_road_members (
    rated_way_id INTEGER NOT NULL,
    osm_way_id INTEGER NOT NULL,
    UNIQUE (rated_way_id, osm_way_id),
    UNIQUE (osm_way_id),
    FOREIGN KEY (rated_way_id) REFERENCES rated_roads(way_id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS road_ratings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    way_id INTEGER NOT NULL,
    ip TEXT NOT NULL,
    type TEXT NOT NULL,
    subtypes TEXT NOT NULL,
    multiplier REAL NOT NULL,
    comment TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (way_id, ip),
    FOREIGN KEY (way_id) REFERENCES rated_roads(way_id) ON DELETE CASCADE
  );
`);

  /** Audit legacy rows before atomically enforcing FK and global ownership constraints. */
  const enforceRoadRatingConstraints = () => {
    const violations = sqliteHandle.query(`
    SELECT 'orphan_rating' AS kind, rr.way_id AS value
    FROM road_ratings rr
    LEFT JOIN rated_roads r ON r.way_id = rr.way_id
    WHERE r.way_id IS NULL
    UNION ALL SELECT 'orphan_member', m.osm_way_id
    FROM rated_road_members m
    LEFT JOIN rated_roads r ON r.way_id = m.rated_way_id
    WHERE r.way_id IS NULL
    UNION ALL SELECT 'overlapping_member', osm_way_id
    FROM rated_road_members
    GROUP BY osm_way_id
    HAVING count(DISTINCT rated_way_id) > 1
  `).all();
    if (violations.length) {
      throw new Error(`Road-rating migration audit failed: ${JSON.stringify(violations)}`);
    }
    const definition = sqliteHandle.query(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'rated_road_members'",
    ).get() as { sql?: string } | null;
    const ratingsDefinition = sqliteHandle.query(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'road_ratings'",
    ).get() as { sql?: string } | null;
    if (
      definition?.sql?.includes('REFERENCES rated_roads')
      && definition.sql.includes('UNIQUE (osm_way_id)')
      && ratingsDefinition?.sql?.includes('REFERENCES rated_roads')
    ) {
      ensureColumn(sqliteHandle, 'road_ratings', 'comment', 'TEXT');
      return;
    }
    sqliteHandle.transaction(() => {
      // Deferred checks let the replacement tables be populated and renamed
      // while FK enforcement remains enabled for this connection.
      sqliteHandle.exec('PRAGMA defer_foreign_keys = ON');
      ensureColumn(sqliteHandle, 'road_ratings', 'comment', 'TEXT');
      sqliteHandle.exec(`
       CREATE TABLE rated_roads_new (
         way_id INTEGER PRIMARY KEY,
         name TEXT,
         geometry TEXT NOT NULL,
         anchor_lat REAL NOT NULL,
         anchor_lng REAL NOT NULL,
         created_at TEXT NOT NULL DEFAULT (datetime('now'))
       );
       CREATE TABLE rated_road_members_new (
         rated_way_id INTEGER NOT NULL REFERENCES rated_roads_new(way_id) ON DELETE CASCADE,
         osm_way_id INTEGER NOT NULL,
         UNIQUE (rated_way_id, osm_way_id),
         UNIQUE (osm_way_id)
       );
       CREATE TABLE road_ratings_new (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         way_id INTEGER NOT NULL REFERENCES rated_roads_new(way_id) ON DELETE CASCADE,
         ip TEXT NOT NULL,
         type TEXT NOT NULL,
         subtypes TEXT NOT NULL,
         multiplier REAL NOT NULL,
         comment TEXT,
         updated_at TEXT NOT NULL DEFAULT (datetime('now')),
         UNIQUE (way_id, ip)
       );
       INSERT INTO rated_roads_new
         SELECT way_id, name, geometry, anchor_lat, anchor_lng, created_at FROM rated_roads;
       INSERT INTO rated_road_members_new
         SELECT rated_way_id, osm_way_id FROM rated_road_members;
       INSERT INTO road_ratings_new
         SELECT id, way_id, ip, type, subtypes, multiplier, comment, updated_at FROM road_ratings;
        DROP TABLE road_ratings; DROP TABLE rated_road_members; DROP TABLE rated_roads;
        ALTER TABLE rated_roads_new RENAME TO rated_roads;
        ALTER TABLE rated_road_members_new RENAME TO rated_road_members;
        ALTER TABLE road_ratings_new RENAME TO road_ratings;
      `);
    })();
    const fkErrors = sqliteHandle.query('PRAGMA foreign_key_check').all();
    if (fkErrors.length) {
      throw new Error(`Road-rating foreign-key check failed: ${JSON.stringify(fkErrors)}`);
    }
  };

  enforceRoadRatingConstraints();

  // Drop the polygon-era geometry_version column (no longer part of the schema).
  const column = sqliteHandle.query(
    "SELECT 1 FROM pragma_table_info('rated_roads') WHERE name = 'geometry_version'",
  ).get();
  if (column) {
    sqliteHandle.transaction(() => {
      sqliteHandle.exec('ALTER TABLE rated_roads DROP COLUMN geometry_version');
    })();
  }
  enableForeignKeys(sqliteHandle);
}

initializeRoadRatingSchema(sqlite);

ensureColumn(sqlite, 'routes', 'surface_segments', 'TEXT');
ensureColumn(sqlite, 'routes', 'road_class_segments', 'TEXT');

export const db = drizzle(sqlite);

/** Raw bun:sqlite handle (transactions for multi-statement atomic writes). */
export const rawSqlite = sqlite;

export const routes = sqliteTable('routes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  stops: text('stops').notNull(),
  geometry: text('geometry').notNull(),
  distance: real('distance'),
  duration: real('duration'),
  elevationGain: real('elevation_gain'),
  elevationLoss: real('elevation_loss'),
  elevationProfile: text('elevation_profile'),
  surfaceSegments: text('surface_segments'),
  roadClassSegments: text('road_class_segments'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const ratedRoads = sqliteTable('rated_roads', {
  wayId: integer('way_id').primaryKey(),
  name: text('name'),
  geometry: text('geometry').notNull(),
  anchorLat: real('anchor_lat').notNull(),
  anchorLng: real('anchor_lng').notNull(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

export const ratedRoadMembers = sqliteTable('rated_road_members', {
  ratedWayId: integer('rated_way_id').notNull(),
  osmWayId: integer('osm_way_id').notNull(),
}, (table) => [
  unique('rated_road_members_unique').on(table.ratedWayId, table.osmWayId),
]);

export const roadRatings = sqliteTable('road_ratings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  wayId: integer('way_id').notNull(),
  ip: text('ip').notNull(),
  type: text('type').notNull(),
  subtypes: text('subtypes').notNull(),
  multiplier: real('multiplier').notNull(),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
  comment: text('comment'),
});
