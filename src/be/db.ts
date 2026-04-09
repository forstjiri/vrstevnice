import { drizzle } from 'drizzle-orm/bun-sqlite'
import { sql } from 'drizzle-orm/sql'
import { Database } from 'bun:sqlite'
import { sqliteTable, text, real, integer } from 'drizzle-orm/sqlite-core'

const sqlite = new Database('data.db')
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
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)

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
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
})
