import { drizzle } from 'drizzle-orm/bun-sqlite'
import { sql } from 'drizzle-orm/sql'
import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { sqliteTable, text, real, integer } from 'drizzle-orm/sqlite-core'

/**
 * Safely add a column to an existing table. No-op if column already exists.
 */
function ensureColumn(table: string, column: string, definition: string) {
  try {
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  } catch {
    // Column already exists — ignore
  }
}

const PROJECT_ROOT = resolve(import.meta.dir, '..', '..')
const DATA_DIR = resolve(PROJECT_ROOT, 'data')

mkdirSync(DATA_DIR, { recursive: true })

const sqlite = new Database(resolve(DATA_DIR, 'data.db'))
sqlite.exec('PRAGMA journal_mode=WAL')
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
`)

ensureColumn('routes', 'surface_segments', 'TEXT')
ensureColumn('routes', 'road_class_segments', 'TEXT')

export const db = drizzle(sqlite)

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
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
})
