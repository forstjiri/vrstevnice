#!/usr/bin/env python3
"""Extract bicycle route relations from an OSM PBF file into a GeoJSON FeatureCollection.

Each relation becomes a MultiLineString feature with properties:
  id, name, ref, network, operator

Usage:
    python3 scripts/extract_bicycle_routes.py data/czech-republic-latest.osm.pbf data/cycleroutes.geojson
"""

import sys
import json
import time
import os
from collections import defaultdict


def main():
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <input.pbf> <output.geojson>", file=sys.stderr)
        sys.exit(1)

    pbf_path = sys.argv[1]
    geojson_path = sys.argv[2]

    import osmium

    print(f"Reading {pbf_path}...")
    start = time.time()

    # ── Pass 1: Collect bicycle route relations and their member way IDs ──
    relations = {}           # rel_id -> {properties}
    rel_member_ways = {}     # rel_id -> list of way_id (ordered, deduplicated)

    class RelationCollector(osmium.SimpleHandler):
        def relation(self, r):
            if r.tags.get("type") != "route" or r.tags.get("route") != "bicycle":
                return
            props = {"id": r.id}
            for k in ("name", "ref", "network", "operator"):
                v = r.tags.get(k)
                if v:
                    props[k] = v
            relations[r.id] = props

            # Collect ordered, deduplicated member way IDs
            seen = set()
            ways = []
            for m in r.members:
                if m.type == "w" and m.ref not in seen:
                    seen.add(m.ref)
                    ways.append(m.ref)
            rel_member_ways[r.id] = ways

    rc = RelationCollector()
    rc.apply_file(pbf_path)
    print(f"  Pass 1: {len(relations)} bicycle route relations, "
          f"{sum(len(v) for v in rel_member_ways.values())} member ways")

    # Build the set of all way IDs we need geometry for
    needed_ways = set()
    for ways in rel_member_ways.values():
        needed_ways.update(ways)
    print(f"  Unique ways needed: {len(needed_ways)}")

    # ── Pass 2: Collect node locations and build way geometries ──
    way_coords = {}          # way_id -> list of (lon, lat)

    class WayGeomCollector(osmium.SimpleHandler):
        def __init__(self):
            super().__init__()
            self.node_locs = {}

        def node(self, n):
            if n.location.valid():
                self.node_locs[n.id] = (n.lon, n.lat)

        def way(self, w):
            if w.id not in needed_ways:
                return
            coords = []
            for node in w.nodes:
                loc = self.node_locs.get(node.ref)
                if loc:
                    coords.append(loc)
            if coords:
                way_coords[w.id] = coords

    wc = WayGeomCollector()
    wc.apply_file(pbf_path, locations=True)
    print(f"  Pass 2: {len(wc.node_locs)} nodes cached, {len(way_coords)} ways with geometry")

    # ── Assemble GeoJSON features ──
    features = []
    skipped_no_geom = 0

    for rel_id, props in relations.items():
        member_ways = rel_member_ways.get(rel_id, [])
        all_coords = []
        for way_id in member_ways:
            coords = way_coords.get(way_id)
            if coords:
                all_coords.append(coords)

        if not all_coords:
            skipped_no_geom += 1
            continue

        feature = {
            "type": "Feature",
            "properties": props,
            "geometry": {
                "type": "MultiLineString",
                "coordinates": all_coords,
            },
        }
        features.append(feature)

    if skipped_no_geom:
        print(f"  Skipped {skipped_no_geom} relations with no geometry")

    geojson = {
        "type": "FeatureCollection",
        "features": features,
    }

    with open(geojson_path, "w") as f:
        json.dump(geojson, f)

    elapsed = time.time() - start
    size_mb = os.path.getsize(geojson_path) / (1024 * 1024)
    print(f"  Wrote {len(features)} features to {geojson_path} ({size_mb:.1f} MB) in {elapsed:.1f}s")


if __name__ == "__main__":
    main()
