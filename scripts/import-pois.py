#!/usr/bin/env python3
"""Extract amenity nodes (pubs, bars, restaurants, cafes, biergartens) from an OSM PBF
into a SQLite database for fast spatial queries from the BE.

Schema:
  pois(id INTEGER PRIMARY KEY, lat REAL, lng REAL, name TEXT, type TEXT)
  idx_pois_lat_lng ON pois(lat, lng)  -- bounding-box pre-filter

Idempotent: drops and recreates the table on each run.

Usage:
    python3 scripts/import-pois.py data/czech-republic-latest.osm.pbf data/cz-pois.sqlite
"""

import sys
import time
import os
import sqlite3


# Amenity tags we care about for "Limonádová cesta" — POIs you might want to stop at
AMENITY_TYPES = {"pub", "bar", "restaurant", "cafe", "biergarten"}


def main():
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <input.pbf> <output.sqlite>", file=sys.stderr)
        sys.exit(1)

    pbf_path = sys.argv[1]
    sqlite_path = sys.argv[2]

    import osmium

    if not os.path.exists(pbf_path):
        print(f"ERROR: PBF file not found: {pbf_path}", file=sys.stderr)
        sys.exit(1)

    print(f"Reading {pbf_path}...")
    start = time.time()

    # ── Pass 1: collect amenity nodes matching our types ──
    nodes = []

    class AmenityCollector(osmium.SimpleHandler):
        def node(self, n):
            amenity = n.tags.get("amenity")
            if amenity not in AMENITY_TYPES:
                return
            name = n.tags.get("name")
            if not name:
                # Skip unnamed POIs — useless for the lemonade pipeline
                return
            loc = n.location
            if not loc.valid():
                return
            nodes.append((n.id, loc.lat, loc.lon, name, amenity))

    collector = AmenityCollector()
    collector.apply_file(pbf_path, locations=True)
    print(f"  Pass 1: collected {len(nodes)} amenity nodes")

    # ── Write to SQLite (idempotent) ──
    conn = sqlite3.connect(sqlite_path)
    try:
        cur = conn.cursor()
        cur.execute("DROP TABLE IF EXISTS pois")
        cur.execute(
            """
            CREATE TABLE pois (
                id INTEGER PRIMARY KEY,
                lat REAL NOT NULL,
                lng REAL NOT NULL,
                name TEXT NOT NULL,
                type TEXT NOT NULL
            )
            """
        )
        cur.executemany(
            "INSERT INTO pois (id, lat, lng, name, type) VALUES (?, ?, ?, ?, ?)",
            nodes,
        )
        cur.execute("CREATE INDEX idx_pois_lat_lng ON pois(lat, lng)")
        conn.commit()

        row_count = cur.execute("SELECT COUNT(*) FROM pois").fetchone()[0]
        size_mb = os.path.getsize(sqlite_path) / (1024 * 1024)
        elapsed = time.time() - start
        print(
            f"  Wrote {row_count} POIs to {sqlite_path} ({size_mb:.1f} MB) in {elapsed:.1f}s"
        )
    finally:
        conn.close()


if __name__ == "__main__":
    main()
