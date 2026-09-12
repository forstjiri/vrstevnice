import { Database } from 'bun:sqlite';
import { resolve } from 'node:path';
import { connectedRoadWayGroup, type OSMRoadWay } from '../src/shared';

const PROJECT_ROOT = resolve(import.meta.dir, '..');
const APP_DB_PATH = resolve(PROJECT_ROOT, 'data', 'data.db');
const ROAD_INDEX_PATH = resolve(PROJECT_ROOT, 'data', 'road-rating-roads.sqlite');
const SEED_IP_PREFIX = 'seed-mnisek-';
const USER_COUNT = 10;
const ROAD_COUNT = 8;
const BBOX = {
  minLng: 15.0,
  minLat: 50.80,
  maxLng: 15.10,
  maxLat: 50.88,
};

interface IndexedRoad {
  osm_id: number;
  name: string | null;
  geometry: string;
}

interface RoadGroup {
  wayId: number;
  name: string | null;
  lines: [number, number][][];
}

function pseudoRandom(index: number): number {
  const value = Math.sin(index * 12.9898) * 43_758.5453;
  return value - Math.floor(value);
}

function parseLine(geometry: string): [number, number][] {
  return JSON.parse(geometry).coordinates as [number, number][];
}

function resolveGroup(index: Database, row: IndexedRoad): RoadGroup | null {
  const selectedLine = parseLine(row.geometry);
  if (selectedLine.length < 2) return null;
  if (!row.name) return { wayId: row.osm_id, name: null, lines: [selectedLine] };
  const sameNamed = index.query(
    'SELECT osm_id, name, geometry FROM roads WHERE name = ?',
  ).all(row.name) as IndexedRoad[];
  const roads: OSMRoadWay[] = sameNamed.map((road) => ({
    osmId: road.osm_id,
    name: road.name,
    coordinates: parseLine(road.geometry),
  })).filter((road) => road.coordinates.length >= 2);
  const members = connectedRoadWayGroup(row.osm_id, roads);
  if (members.length === 0) return null;
  return {
    wayId: Math.min(...members.map((road) => road.osmId)),
    name: row.name,
    lines: members.map((road) => road.coordinates),
  };
}

function anchor(lines: [number, number][][]): [number, number] {
  const line = lines.reduce((longest, candidate) => (
    candidate.length > longest.length ? candidate : longest
  ));
  const point = line[Math.floor(line.length / 2)];
  return [point[1], point[0]];
}

function vote(index: number): { type: 'prefer' | 'demote'; subtypes: string[]; multiplier: number; comment: string | null } {
  const prefers = [['nice'], ['safe'], ['fast'], ['nice', 'safe'], ['nice', 'fast']];
  const demotes = [['dangerous'], ['unpassable'], ['bad_terrain'], ['dangerous', 'bad_terrain']];
  const type = index % 3 === 0 ? 'demote' : 'prefer';
  const subtypes = type === 'prefer'
    ? prefers[index % prefers.length]
    : demotes[index % demotes.length];
  const multipliers: Record<string, number> = {
    nice: 1.5, safe: 1.7, fast: 1.4, dangerous: 0.2, unpassable: 0.05, bad_terrain: 0.4,
  };
  const sorted = subtypes.map((subtype) => multipliers[subtype]).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    type,
    subtypes,
    multiplier: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    comment: [
      'Příjemná cesta, minimum aut.',
      'Pozor na rozbitý povrch po dešti.',
      'Bezpečná cyklotrasa s pěkným výhledem.',
      'Krátký prudší úsek, jinak v pohodě.',
    ][index % 4],
  };
}

const index = new Database(ROAD_INDEX_PATH, { readonly: true });
const app = new Database(APP_DB_PATH);
const candidates = index.query(`
  SELECT roads.osm_id, roads.name, roads.geometry
  FROM roads_rtree
  JOIN roads ON roads.osm_id = roads_rtree.osm_id
  WHERE roads_rtree.max_lng >= ? AND roads_rtree.min_lng <= ?
    AND roads_rtree.max_lat >= ? AND roads_rtree.min_lat <= ?
`).all(BBOX.minLng, BBOX.maxLng, BBOX.minLat, BBOX.maxLat) as IndexedRoad[];

const groups = new Map<number, RoadGroup>();
candidates.sort((left, right) => pseudoRandom(left.osm_id) - pseudoRandom(right.osm_id)).forEach((row) => {
  if (groups.size >= ROAD_COUNT) return;
  const group = resolveGroup(index, row);
  if (group) groups.set(group.wayId, group);
});
if (groups.size < ROAD_COUNT) throw new Error(`Only found ${groups.size} road groups in Mníšek`);

app.exec('BEGIN');
try {
  app.query('DELETE FROM road_ratings WHERE ip LIKE ?').run(`${SEED_IP_PREFIX}%`);
  app.query(`
    DELETE FROM rated_roads
    WHERE way_id NOT IN (SELECT DISTINCT way_id FROM road_ratings)
  `).run();

  [...groups.values()].forEach((group, roadIndex) => {
    const [lat, lng] = anchor(group.lines);
    const geometry = group.lines.length === 1
      ? { type: 'LineString', coordinates: group.lines[0] }
      : { type: 'MultiLineString', coordinates: group.lines };
    app.query(`
      INSERT INTO rated_roads (way_id, name, geometry, anchor_lat, anchor_lng)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(way_id) DO UPDATE SET
        name = excluded.name,
        geometry = excluded.geometry,
        anchor_lat = excluded.anchor_lat,
        anchor_lng = excluded.anchor_lng
    `).run(group.wayId, group.name, JSON.stringify(geometry), lat, lng);

    const voteCount = 1 + Math.floor(pseudoRandom(roadIndex + 100) * USER_COUNT);
    for (let userIndex = 0; userIndex < voteCount; userIndex += 1) {
      const rating = vote(roadIndex * USER_COUNT + userIndex);
      app.query(`
        INSERT INTO road_ratings (way_id, ip, type, subtypes, multiplier, comment)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        group.wayId,
        `${SEED_IP_PREFIX}${userIndex + 1}`,
        rating.type,
        JSON.stringify(rating.subtypes),
        rating.comment,
        rating.multiplier,
      );
    }
  });
  app.exec('COMMIT');
} catch (error) {
  app.exec('ROLLBACK');
  throw error;
}

console.log(JSON.stringify({
  roads: [...groups.values()].map((group) => ({ wayId: group.wayId, name: group.name })),
  users: USER_COUNT,
}, null, 2));
