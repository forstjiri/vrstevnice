import { drizzle } from 'drizzle-orm/bun-sqlite';
import { sql } from 'drizzle-orm/sql';
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  sqliteTable, text, real, integer,
} from 'drizzle-orm/sqlite-core';

/**
 * Safely add a column to an existing table. No-op if column already exists.
 */
const PROJECT_ROOT = resolve(import.meta.dir, '..', '..');
const DATA_DIR = resolve(PROJECT_ROOT, 'data');

mkdirSync(DATA_DIR, { recursive: true });

const sqlite = new Database(resolve(DATA_DIR, 'data.db'));

function ensureColumn(table: string, column: string, definition: string) {
  try {
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch {
    // Column already exists — ignore
  }
}

sqlite.exec('PRAGMA journal_mode=WAL');
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

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS rated_roads (
    way_id INTEGER PRIMARY KEY,
    name TEXT,
    geometry TEXT NOT NULL,
    anchor_lat REAL NOT NULL,
    anchor_lng REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
    UNIQUE (way_id, ip)
  );
`);

ensureColumn('routes', 'surface_segments', 'TEXT');
ensureColumn('routes', 'road_class_segments', 'TEXT');

export const db = drizzle(sqlite);

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

ensureColumn('road_ratings', 'comment', 'TEXT');
