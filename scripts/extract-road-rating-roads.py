#!/usr/bin/env python3
"""Build a local spatial index of original OSM road ways for road ratings.

Each row represents exactly one OSM way.  It is deliberately independent of
the display-oriented OpenMapTiles `transportation` layer, which can merge and
split geometries while generating vector tiles.
"""

import json
import os
import sqlite3
import sys
import time


SKIPPED_HIGHWAYS = {"abandoned", "construction", "proposed", "raceway", "steps"}
BATCH_SIZE = 2_000


def main():
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} INPUT.osm.pbf OUTPUT.sqlite", file=sys.stderr)
        sys.exit(1)

    pbf_path, output_path = sys.argv[1:]
    if not os.path.isfile(pbf_path):
        print(f"Input PBF not found: {pbf_path}", file=sys.stderr)
        sys.exit(1)

    import osmium

    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    if os.path.exists(output_path):
        os.remove(output_path)
    db = sqlite3.connect(output_path)
    db.executescript("""
        PRAGMA journal_mode=WAL;
        CREATE TABLE roads (
          osm_id INTEGER PRIMARY KEY,
          name TEXT,
          geometry TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE roads_rtree USING rtree(
          osm_id, min_lng, max_lng, min_lat, max_lat
        );
    """)

    class RoadCollector(osmium.SimpleHandler):
        def __init__(self):
            super().__init__()
            self.rows = []
            self.count = 0

        def flush(self):
            if not self.rows:
                return
            db.executemany(
                "INSERT INTO roads (osm_id, name, geometry) VALUES (?, ?, ?)",
                [(way_id, name, geometry) for way_id, name, geometry, _ in self.rows],
            )
            db.executemany(
                "INSERT INTO roads_rtree VALUES (?, ?, ?, ?, ?)",
                [(way_id, min_lng, max_lng, min_lat, max_lat)
                 for way_id, _, _, (min_lng, max_lng, min_lat, max_lat) in self.rows],
            )
            db.commit()
            self.rows.clear()

        def way(self, way):
            highway = way.tags.get("highway")
            if not highway or highway in SKIPPED_HIGHWAYS:
                return
            coordinates = [
                (node.location.lon, node.location.lat)
                for node in way.nodes
                if node.location.valid()
            ]
            if len(coordinates) < 2:
                return
            lngs, lats = zip(*coordinates)
            self.rows.append((
                way.id,
                way.tags.get("name:cs") or way.tags.get("name"),
                json.dumps({"type": "LineString", "coordinates": coordinates}, separators=(",", ":")),
                (min(lngs), max(lngs), min(lats), max(lats)),
            ))
            self.count += 1
            if len(self.rows) >= BATCH_SIZE:
                self.flush()

    started = time.monotonic()
    collector = RoadCollector()
    collector.apply_file(pbf_path, locations=True)
    collector.flush()
    db.execute("CREATE INDEX roads_name_idx ON roads(name)")
    db.execute("VACUUM")
    db.close()
    size_mb = os.path.getsize(output_path) / (1024 * 1024)
    print(f"Wrote {collector.count} OSM ways to {output_path} ({size_mb:.1f} MB) in {time.monotonic() - started:.1f}s")


if __name__ == "__main__":
    main()
