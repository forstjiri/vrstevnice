/* eslint-disable import-x/no-relative-packages, import-x/no-unresolved */
import { Database } from 'bun:sqlite';
import { mock } from 'bun:test';
import {
  afterEach, describe, expect, it,
} from 'vitest';
import { seedRoadRatingsMnisek } from '../../scripts/seed-road-ratings-mnisek';
import { BIKE_TYPES } from '../../src/shared';

// db.ts initializes its live handle at module load. Redirect precisely that
// handle before dynamically loading production persistence modules, while
// retaining the real Bun Database class for every test database below.
let redirectedLiveDatabase = false;
class IsolatedDatabase extends Database {
  constructor(filename?: string, options?: ConstructorParameters<typeof Database>[1]) {
    if (filename?.endsWith('/data/data.db')) {
      redirectedLiveDatabase = true;
      super(':memory:', options);
      return;
    }
    super(filename, options);
  }
}
mock.module('bun:sqlite', () => ({ Database: IsolatedDatabase }));

const { initializeRoadRatingSchema } = await import('../../src/be/db');
const {
  applyMemberBackfill,
  applySaveRating,
  backfillRatedRoadMembersFor,
  getVotedRoadsInCorridor,
  getAggregatesInBbox,
  RoadRatingIntegrityError,
} = await import('../../src/be/road-ratings');
const { rawSqlite } = await import('../../src/be/db');

const databases: Database[] = [];
const memory = () => {
  const sqlite = new Database(':memory:');
  databases.push(sqlite);
  return sqlite;
};
const rows = (sqlite: Database, table: string) => sqlite
  .query(`SELECT * FROM ${table} ORDER BY 1, 2`)
  .all();
const snapshot = (sqlite: Database) => JSON.stringify({
  roads: rows(sqlite, 'rated_roads'),
  members: rows(sqlite, 'rated_road_members'),
  ratings: rows(sqlite, 'road_ratings'),
});
const geometry = {
  type: 'LineString' as const,
  coordinates: [[14, 50], [14.01, 50.01]] as [number, number][],
};
const resolved = (wayId: number, memberIds: number[], extra = {}) => ({
  wayId,
  memberIds,
  name: 'Road',
  geometry: JSON.stringify(geometry),
  anchorLat: 50,
  anchorLng: 14,
  ...extra,
});

afterEach(() => {
  databases.splice(0).forEach((sqlite) => sqlite.close());
});

describe('road-rating SQLite persistence', () => {
  it('redirects db.ts import-time initialization away from live data/data.db', () => {
    expect(redirectedLiveDatabase).toBe(true);
  });
  it('creates fresh schema, upgrades geometry_version, and is a no-op when rerun', () => {
    const fresh = memory();
    initializeRoadRatingSchema(fresh);
    expect(rows(fresh, 'rated_roads')).toEqual([]);
    expect(fresh.query("SELECT sql FROM sqlite_master WHERE name = 'rated_road_members'").get())
      .toMatchObject({ sql: expect.stringContaining('UNIQUE (osm_way_id)') });
    initializeRoadRatingSchema(fresh);

    const legacy = memory();
    legacy.exec(`
      CREATE TABLE rated_roads (
        way_id INTEGER PRIMARY KEY,
        name TEXT,
        geometry TEXT NOT NULL,
        anchor_lat REAL NOT NULL,
        anchor_lng REAL NOT NULL,
        geometry_version INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE rated_road_members (
        rated_way_id INTEGER NOT NULL,
        osm_way_id INTEGER NOT NULL,
        UNIQUE (rated_way_id, osm_way_id)
      );
      CREATE TABLE road_ratings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        way_id INTEGER NOT NULL,
        ip TEXT NOT NULL,
        type TEXT NOT NULL,
        subtypes TEXT NOT NULL,
        multiplier REAL NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (way_id, ip)
      );
      INSERT INTO rated_roads (way_id, geometry, anchor_lat, anchor_lng) VALUES (1, '{}', 50, 14);
      INSERT INTO rated_road_members VALUES (1, 1);
      INSERT INTO road_ratings (
        way_id, ip, type, subtypes, multiplier
      ) VALUES (1, 'ip', 'prefer', '["nice"]', 1.5);
    `);
    initializeRoadRatingSchema(legacy);
    expect(legacy.query(
      "SELECT 1 FROM pragma_table_info('rated_roads') WHERE name = 'geometry_version'",
    ).get()).toBeNull();
    expect(legacy.query(
      'SELECT comment FROM road_ratings WHERE way_id = 1',
    ).get()).toEqual({ comment: null });
    expect(legacy.query('SELECT minimum_bike FROM road_ratings').get())
      .toEqual({ minimum_bike: null });
    const upgraded = snapshot(legacy);
    initializeRoadRatingSchema(legacy);
    expect(snapshot(legacy)).toBe(upgraded);
  });

  it('propagates schema audit errors without partially migrating legacy tables', () => {
    const sqlite = memory();
    sqlite.exec(`
      CREATE TABLE rated_roads (
        way_id INTEGER PRIMARY KEY,
        name TEXT,
        geometry TEXT NOT NULL,
        anchor_lat REAL NOT NULL,
        anchor_lng REAL NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE rated_road_members (
        rated_way_id INTEGER NOT NULL,
        osm_way_id INTEGER NOT NULL,
        UNIQUE (rated_way_id, osm_way_id)
      );
      CREATE TABLE road_ratings (
        id INTEGER PRIMARY KEY,
        way_id INTEGER NOT NULL,
        ip TEXT NOT NULL,
        type TEXT NOT NULL,
        subtypes TEXT NOT NULL,
        multiplier REAL NOT NULL,
        comment TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE (way_id, ip)
      );
      INSERT INTO road_ratings VALUES (1, 99, 'ip', 'prefer', '[]', 1, NULL, 'now');
    `);
    expect(() => initializeRoadRatingSchema(sqlite)).toThrow(/migration audit failed/);
    expect(sqlite.query("SELECT sql FROM sqlite_master WHERE name = 'road_ratings'").get())
      .toMatchObject({ sql: expect.not.stringContaining('REFERENCES rated_roads') });
  });

  it('rolls back migration work when a legacy schema fails during replacement', () => {
    const sqlite = memory();
    sqlite.exec(`
      CREATE TABLE rated_roads (
        way_id INTEGER PRIMARY KEY,
        name TEXT,
        geometry TEXT NOT NULL,
        anchor_lat REAL NOT NULL,
        anchor_lng REAL NOT NULL
      );
      CREATE TABLE rated_road_members (
        rated_way_id INTEGER NOT NULL,
        osm_way_id INTEGER NOT NULL,
        UNIQUE (rated_way_id, osm_way_id)
      );
      CREATE TABLE road_ratings (
        id INTEGER PRIMARY KEY,
        way_id INTEGER NOT NULL,
        ip TEXT NOT NULL,
        type TEXT NOT NULL,
        subtypes TEXT NOT NULL,
        multiplier REAL NOT NULL,
        comment TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE (way_id, ip)
      );
      INSERT INTO rated_roads VALUES (1, 'Road', '{}', 50, 14);
    `);
    expect(() => initializeRoadRatingSchema(sqlite)).toThrow(/created_at/);
    expect(sqlite.query(
      "SELECT 1 FROM sqlite_master WHERE name = 'rated_roads_new'",
    ).get()).toBeNull();
    expect(rows(sqlite, 'rated_roads')).toMatchObject([{ way_id: 1, name: 'Road' }]);
  });

  it('propagates non-idempotency schema errors', () => {
    const sqlite = memory();
    sqlite.exec('CREATE VIEW road_ratings AS SELECT 1 AS way_id');
    expect(() => initializeRoadRatingSchema(sqlite)).toThrow();
  });

  interface TestVote {
    type: 'prefer' | 'demote';
    subtypes: ['nice'] | ['dangerous'];
    comment?: string;
    ip: string;
  }
  const saveVote = (
    sqlite: Database,
    group: { wayId: number; memberIds: number[]; name: string | null },
    vote: TestVote,
  ) => applySaveRating(sqlite, group, {
    ...vote, minimumBike: vote.type === 'prefer' ? 'road' : undefined,
  }, geometry, [50, 14]);

  it('persists every bike enum, upserts it, and clears it for negative votes', () => {
    const sqlite = memory();
    initializeRoadRatingSchema(sqlite);
    const group = { wayId: 1, memberIds: [1, 2], name: 'A' };
    BIKE_TYPES.forEach((minimumBike) => {
      applySaveRating(sqlite, group, {
        type: 'prefer', subtypes: ['nice'], minimumBike, ip: 'ip',
      }, geometry, [50, 14]);
      expect(sqlite.query('SELECT minimum_bike FROM road_ratings').all())
        .toEqual([{ minimum_bike: minimumBike }]);
    });
    initializeRoadRatingSchema(sqlite);
    expect(sqlite.query('SELECT minimum_bike FROM road_ratings').get())
      .toEqual({ minimum_bike: 'freeride' });
    expect(() => sqlite.exec("UPDATE road_ratings SET minimum_bike = 'scooter'"))
      .toThrow(/CHECK constraint/);
    const before = snapshot(sqlite);
    expect(() => applySaveRating(sqlite, group, {
      type: 'prefer', subtypes: ['nice'], ip: 'other',
    }, geometry, [51, 15])).toThrow(/minimální kolo/);
    expect(snapshot(sqlite)).toBe(before);
    applySaveRating(sqlite, group, {
      type: 'demote', subtypes: ['dangerous'], ip: 'ip',
    }, geometry, [50, 14]);
    expect(sqlite.query('SELECT minimum_bike FROM road_ratings').all())
      .toEqual([{ minimum_bike: null }]);
  });

  it('upgrades an existing constrained schema without guessing bikes for old votes', () => {
    const sqlite = memory();
    initializeRoadRatingSchema(sqlite);
    sqlite.exec('ALTER TABLE road_ratings DROP COLUMN minimum_bike');
    sqlite.exec(`
      INSERT INTO rated_roads (way_id, geometry, anchor_lat, anchor_lng)
      VALUES (1, '{}', 50, 14);
      INSERT INTO road_ratings (way_id, ip, type, subtypes, multiplier, comment)
      VALUES (1, 'legacy', 'prefer', '["nice"]', 1.5, 'Keep me');
    `);
    initializeRoadRatingSchema(sqlite);
    expect(rows(sqlite, 'road_ratings')).toMatchObject([{
      ip: 'legacy', multiplier: 1.5, comment: 'Keep me', minimum_bike: null,
    }]);
    const upgraded = snapshot(sqlite);
    initializeRoadRatingSchema(sqlite);
    expect(snapshot(sqlite)).toBe(upgraded);
  });

  it.each([1, 4, 5, 9, 10])('displays and routes with %i persisted bike votes', async (count) => {
    const clear = () => rawSqlite.exec(`
      DELETE FROM road_ratings; DELETE FROM rated_road_members; DELETE FROM rated_roads;
    `);
    clear();
    try {
      const group = { wayId: 1, memberIds: [1, 2], name: 'A' };
      const corridor = [{ name: 'A', lat: 50, lng: 14 }];
      for (let index = 0; index < count; index += 1) {
        applySaveRating(rawSqlite, group, {
          type: 'prefer', subtypes: ['nice'], minimumBike: 'mtb', ip: `ip-${index}`,
        }, geometry, [50, 14]);
      }
      const [aggregate] = await getAggregatesInBbox({
        minLat: 49, maxLat: 51, minLng: 13, maxLng: 15,
      }, 'ip-0');
      expect(aggregate.bikeRecommendation).toMatchObject({
        total: count, minimum: count >= 5 ? 'mtb' : null, counts: { mtb: count },
      });
      expect(aggregate.mine?.minimumBike).toBe('mtb');
      const [road] = await getVotedRoadsInCorridor(corridor, 200, 'road');
      const expected = new Map([[1, 1.5], [4, 1.5], [5, 0.8], [9, 0.8], [10, 0.2]]);
      expect(road).toEqual({ wayId: 1, memberIds: [1, 2], multiplier: expected.get(count) });
      const [mtb] = await getVotedRoadsInCorridor(corridor, 200, 'mtb');
      expect(mtb.multiplier).toBe(1.5);
    } finally {
      clear();
    }
  });

  it('refreshes stale members and cached data; keeps vote identity on rekey', () => {
    const sqlite = memory();
    initializeRoadRatingSchema(sqlite);
    saveVote(sqlite, { wayId: 10, memberIds: [10], name: 'Old' }, {
      type: 'prefer', subtypes: ['nice'], comment: 'keep', ip: 'ip',
    });
    saveVote(sqlite, { wayId: 10, memberIds: [10], name: 'Old' }, {
      type: 'demote', subtypes: ['dangerous'], comment: 'also keep', ip: 'other',
    });
    sqlite.query(
      "UPDATE road_ratings SET updated_at = ? WHERE way_id = 10 AND ip = 'ip'",
    ).run('2001-02-03 04:05:06');
    const votesBefore = (rows(sqlite, 'road_ratings') as {
      id: number;
      ip: string;
      comment: string | null;
      updated_at: string;
      minimum_bike: string | null;
    }[]).map(({
      id, ip, comment, updated_at, minimum_bike,
    }) => ({
      id, ip, comment, updated_at, minimum_bike,
    }));
    const result = backfillRatedRoadMembersFor(sqlite, (wayId) => (
      wayId === 10 ? resolved(11, [10, 11], { name: 'New', anchorLat: 51, anchorLng: 15 }) : null
    ));
    expect(result).toMatchObject({ memberWrites: 1, rekeys: 1 });
    expect(rows(sqlite, 'rated_roads')).toMatchObject([{
      way_id: 11, name: 'New', anchor_lat: 51, anchor_lng: 15,
    }]);
    expect(rows(sqlite, 'rated_road_members')).toEqual([
      { rated_way_id: 11, osm_way_id: 10 }, { rated_way_id: 11, osm_way_id: 11 },
    ]);
    expect((rows(sqlite, 'road_ratings') as {
      id: number;
      ip: string;
      comment: string | null;
      updated_at: string;
      way_id: number;
      minimum_bike: string | null;
    }[]).map(({
      id, ip, comment, updated_at, way_id, minimum_bike,
    }) => ({
      id, ip, comment, updated_at, way_id, minimum_bike,
    }))).toEqual(votesBefore.map((vote) => ({ ...vote, way_id: 11 })));
  });

  it('refreshes same-representative geometry and anchors; rerun is a no-op', () => {
    const sqlite = memory();
    initializeRoadRatingSchema(sqlite);
    applySaveRating(
      sqlite,
      { wayId: 10, memberIds: [10, 11], name: 'Old' },
      {
        type: 'prefer', subtypes: ['nice'], minimumBike: 'road', ip: 'ip',
      },
      geometry,
      [50, 14],
    );
    const current = resolved(10, [10, 11], {
      name: 'Current',
      geometry: JSON.stringify({ ...geometry, coordinates: [[15, 51], [15.1, 51.1]] }),
      anchorLat: 51,
      anchorLng: 15,
    });
    expect(backfillRatedRoadMembersFor(sqlite, () => current)).toMatchObject({
      memberWrites: 0,
      rekeys: 0,
    });
    expect(rows(sqlite, 'rated_roads')).toMatchObject([{
      name: 'Current', geometry: current.geometry, anchor_lat: 51, anchor_lng: 15,
    }]);
    const afterRefresh = snapshot(sqlite);
    backfillRatedRoadMembersFor(sqlite, () => current);
    expect(snapshot(sqlite)).toBe(afterRefresh);
  });

  it('returns structured preflight failures without any partial writes', () => {
    const sqlite = memory();
    initializeRoadRatingSchema(sqlite);
    const save = (wayId: number, ip: string) => applySaveRating(
      sqlite,
      { wayId, memberIds: [wayId], name: wayId === 1 ? 'A' : 'B' },
      {
        type: 'prefer', subtypes: ['nice'], minimumBike: 'road', ip,
      },
      geometry,
      [50, 14],
    );
    save(1, 'a');
    // Same IP on a destination row verifies that a rejected rekey cannot hit
    // the destination's (way_id, ip) uniqueness constraint mid-migration.
    save(2, 'a');
    const before = snapshot(sqlite);
    const failures = [
      (wayId: number) => (wayId === 1 ? resolved(2, [1, 2]) : resolved(wayId, [wayId])),
      (wayId: number) => resolved(3, [wayId, 3]),
      (wayId: number) => (wayId === 1 ? resolved(1, [1]) : resolved(wayId, [1])),
      () => null,
      (wayId: number) => (wayId === 1 ? resolved(1, [-1]) : null),
    ];
    const expectedCodes = [
      'rekey_conflict',
      'rekey_conflict',
      'membership_conflict',
      'unresolved_group',
      'invalid_group',
    ];
    failures.forEach((resolver, index) => {
      let error: Error | undefined;
      try {
        backfillRatedRoadMembersFor(sqlite, resolver);
      } catch (caught) {
        error = caught as Error;
      }
      expect(error).toBeInstanceOf(RoadRatingIntegrityError);
      const integrityError = error as InstanceType<typeof RoadRatingIntegrityError>;
      expect(integrityError.diagnostics.map(({ code }) => code)).toContain(expectedCodes[index]);
      expect(snapshot(sqlite)).toBe(before);
    });
  });

  it('enforces foreign keys behaviorally and cascades cached children on parent deletion', () => {
    const sqlite = memory();
    initializeRoadRatingSchema(sqlite);
    expect(() => sqlite.query('INSERT INTO rated_road_members VALUES (1, 1)').run()).toThrow();
    expect(() => sqlite.query(
      `INSERT INTO road_ratings (way_id, ip, type, subtypes, multiplier)
        VALUES (1, 'ip', 'prefer', '[]', 1)`,
    ).run()).toThrow();
    applySaveRating(
      sqlite,
      { wayId: 1, memberIds: [1], name: 'A' },
      {
        type: 'prefer', subtypes: ['nice'], minimumBike: 'road', ip: 'ip',
      },
      geometry,
      [50, 14],
    );
    sqlite.query('DELETE FROM rated_roads WHERE way_id = 1').run();
    expect(rows(sqlite, 'rated_road_members')).toEqual([]);
    expect(rows(sqlite, 'road_ratings')).toEqual([]);
  });

  it('rolls back injected member-backfill failures and save/update failures', () => {
    const sqlite = memory();
    initializeRoadRatingSchema(sqlite);
    applySaveRating(
      sqlite,
      { wayId: 1, memberIds: [1], name: 'A' },
      {
        type: 'prefer', subtypes: ['nice'], minimumBike: 'road', ip: 'ip',
      },
      geometry,
      [50, 14],
    );
    const before = snapshot(sqlite);
    const plan = {
      memberWrites: [{ ratedWayId: 1, memberIds: [1, 2] }],
      rekeys: [],
      conflicts: [],
      unresolved: [],
    };
    expect(() => applyMemberBackfill(sqlite, plan, [{
      wayId: 1, name: 'A', geometry: '{}', anchorLat: 50, anchorLng: 14,
    }], () => {
      throw new Error('injected');
    })).toThrow('injected');
    expect(snapshot(sqlite)).toBe(before);
    expect(() => applySaveRating(sqlite, { wayId: 1, memberIds: [1, 3], name: 'changed' }, {
      type: 'demote', subtypes: ['dangerous'], comment: 'changed', ip: 'ip',
    }, geometry, [51, 15], () => {
      throw new Error('injected');
    })).toThrow('injected');
    expect(snapshot(sqlite)).toBe(before);
  });

  it('rejects invalid and conflicting saves without partial writes', () => {
    const sqlite = memory();
    initializeRoadRatingSchema(sqlite);
    applySaveRating(
      sqlite,
      { wayId: 1, memberIds: [1], name: 'A' },
      {
        type: 'prefer', subtypes: ['nice'], minimumBike: 'road', ip: 'ip',
      },
      geometry,
      [50, 14],
    );
    const before = snapshot(sqlite);
    expect(() => applySaveRating(
      sqlite,
      { wayId: 2, memberIds: [1], name: 'B' },
      {
        type: 'prefer', subtypes: ['nice'], minimumBike: 'road', ip: 'other',
      },
      geometry,
      [50, 14],
    )).toThrow(RoadRatingIntegrityError);
    expect(() => applySaveRating(
      sqlite,
      { wayId: -1, memberIds: [-1], name: 'Bad' },
      {
        type: 'prefer', subtypes: ['nice'], minimumBike: 'road', ip: 'other',
      },
      geometry,
      [50, 14],
    )).toThrow(RoadRatingIntegrityError);
    expect(snapshot(sqlite)).toBe(before);
  });

  it('rejects persisted multiplier and custom-model member-limit domain violations', async () => {
    const clearRatings = [
      'DELETE FROM road_ratings',
      'DELETE FROM rated_road_members',
      'DELETE FROM rated_roads',
    ].join('; ');
    rawSqlite.exec(clearRatings);
    try {
      rawSqlite.query(`
        INSERT INTO rated_roads (way_id, geometry, anchor_lat, anchor_lng)
        VALUES (1, '{}', 50, 14)
      `).run();
      rawSqlite.query('INSERT INTO rated_road_members VALUES (1, 1)').run();
      rawSqlite.query(`
        INSERT INTO road_ratings (way_id, ip, type, subtypes, multiplier)
        VALUES (1, 'ip', 'prefer', '[]', 9)
      `).run();
      const corridor = [
        { name: 'A', lat: 50, lng: 14 },
        { name: 'B', lat: 50.01, lng: 14.01 },
      ];
      await expect(getVotedRoadsInCorridor(corridor)).rejects.toMatchObject({
        diagnostics: [expect.objectContaining({ code: 'invalid_multiplier' })],
      });

      rawSqlite.exec(clearRatings);
      rawSqlite.query(`
        INSERT INTO rated_roads (way_id, geometry, anchor_lat, anchor_lng)
        VALUES (1, '{}', 50, 14)
      `).run();
      rawSqlite.query(`
        INSERT INTO road_ratings (way_id, ip, type, subtypes, multiplier)
        VALUES (1, 'ip', 'prefer', '[]', 1)
      `).run();
      for (let wayId = 1; wayId <= 501; wayId += 1) {
        rawSqlite.query('INSERT INTO rated_road_members VALUES (1, ?)').run(wayId);
      }
      await expect(getVotedRoadsInCorridor(corridor)).rejects.toMatchObject({
        diagnostics: [expect.objectContaining({ code: 'model_limit' })],
      });
    } finally {
      rawSqlite.exec(clearRatings);
    }
  });

  it('seeds with correct parameter order and removes stale seed members', () => {
    const app = memory();
    const index = memory();
    initializeRoadRatingSchema(app);
    index.exec(`
      CREATE TABLE roads (osm_id INTEGER PRIMARY KEY, name TEXT, geometry TEXT);
      CREATE TABLE roads_rtree (
        osm_id INTEGER,
        min_lng REAL,
        max_lng REAL,
        min_lat REAL,
        max_lat REAL
      );
    `);
    for (let id = 1; id <= 24; id += 1) {
      index.query('INSERT INTO roads VALUES (?, NULL, ?)').run(
        id,
        JSON.stringify({
          type: 'LineString',
          coordinates: [[15.01 + id / 1000, 50.81], [15.011 + id / 1000, 50.811]],
        }),
      );
      index.query('INSERT INTO roads_rtree VALUES (?, 15, 15.1, 50.8, 50.88)').run(id);
    }
    applySaveRating(
      app,
      { wayId: 99, memberIds: [99], name: 'stale' },
      {
        type: 'prefer', subtypes: ['nice'], minimumBike: 'road', ip: 'seed-mnisek-old',
      },
      geometry,
      [50, 14],
    );
    applySaveRating(
      app,
      { wayId: 100, memberIds: [100], name: 'Real rating' },
      {
        type: 'prefer', subtypes: ['nice'], minimumBike: 'gravel', ip: 'real-user',
      },
      geometry,
      [50, 14],
    );
    const realVote = app.query("SELECT * FROM road_ratings WHERE ip = 'real-user'").get();
    const result = seedRoadRatingsMnisek(app, index);
    expect(result.roads).toHaveLength(24);
    expect(result).toMatchObject({ users: 30, votes: 436 });
    expect(app.query(
      'SELECT count(*) count FROM rated_roads WHERE way_id = 99',
    ).get()).toEqual({ count: 0 });
    expect(app.query(`
      SELECT multiplier, comment, minimum_bike FROM road_ratings
      WHERE ip LIKE 'seed-mnisek-%' ORDER BY id LIMIT 1
    `).get()).toEqual({
      multiplier: 0.2, comment: 'Pozor na nebezpečný úsek a provoz.', minimum_bike: null,
    });
    expect(app.query('SELECT count(*) count FROM rated_road_members').get()).toEqual({ count: 25 });
    expect(app.query(`
      SELECT count(*) count FROM road_ratings
      WHERE ip LIKE 'seed-mnisek-%' AND (
        (type = 'prefer' AND minimum_bike IS NULL)
        OR (type = 'demote' AND minimum_bike IS NOT NULL)
      )
    `).get()).toEqual({ count: 0 });
    expect(app.query(`
      SELECT DISTINCT minimum_bike FROM road_ratings
      WHERE ip LIKE 'seed-mnisek-%' AND minimum_bike IS NOT NULL ORDER BY minimum_bike
    `).all()).toEqual(
      ['freeride', 'gravel', 'mtb', 'road'].map((bike) => ({ minimum_bike: bike })),
    );
    const evidence = app.query(`
      SELECT sum(type = 'prefer') recommendations FROM road_ratings
      WHERE ip LIKE 'seed-mnisek-%' GROUP BY way_id
    `).all() as { recommendations: number }[];
    expect(evidence.filter((road) => road.recommendations < 5)).toHaveLength(4);
    expect(evidence.filter((road) => road.recommendations >= 5 && road.recommendations < 10))
      .toHaveLength(4);
    expect(evidence.filter((road) => road.recommendations >= 10)).toHaveLength(16);
    expect(app.query("SELECT * FROM road_ratings WHERE ip = 'real-user'").get()).toEqual(realVote);
    expect(seedRoadRatingsMnisek(app, index)).toEqual(result);
    expect(app.query("SELECT count(*) count FROM road_ratings WHERE ip LIKE 'seed-mnisek-%'").get())
      .toEqual({ count: 436 });
    expect(app.query("SELECT * FROM road_ratings WHERE ip = 'real-user'").get()).toEqual(realVote);
    expect(app.query('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
