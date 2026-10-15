#!/usr/bin/env python3
"""Extract KČT hiking route relations and guideposts from an OSM PBF file.

Outputs two GeoJSON FeatureCollections:

1. Hiking routes (`route=hiking`, KČT four-colour palette only) as one
   MultiLineString feature per relation with properties: id, name, ref,
   network, colour (red|blue|green|yellow).
2. Guideposts (`tourism=information` + `information=guidepost`) as points
   with properties: id, name, ele, colours (sorted list of KČT colours whose
   routes pass close to the post — approximated via a fixed spatial grid).

Usage:
    python3 scripts/extract_hiking_routes.py <input.pbf> <routes.geojson> <guideposts.geojson>
"""

import sys
import json
import os
import time
from collections import defaultdict

# KČT four-colour palette — relations marked with any other colour are skipped.
KCT_COLOURS = ("red", "blue", "green", "yellow")

# Guidepost colour approximation grid: ~0.001° cells (~70 m), posts collect
# colours from their own cell + the 8 neighbours (≈ up to ~140 m away).
CELL_SIZE = 0.001


def route_colour(tags):
    """Normalize a relation's marking to one of the KČT colours, or None."""
    colour = (tags.get("colour") or "").strip().lower()
    if not colour:
        # osmc:symbol first segment is the background/way colour, e.g.
        # "red:white:red_bar" → red.
        colour = (tags.get("osmc:symbol") or "").split(":")[0].strip().lower()
    return colour if colour in KCT_COLOURS else None


def main():
    if len(sys.argv) != 4:
        print(f"Usage: {sys.argv[0]} <input.pbf> <routes.geojson> <guideposts.geojson>",
              file=sys.stderr)
        sys.exit(1)

    pbf_path, routes_path, guideposts_path = sys.argv[1], sys.argv[2], sys.argv[3]

    import osmium

    print(f"Reading {pbf_path}...")
    start = time.time()

    # ── Pass 1: hiking route relations + guidepost nodes ──
    relations = {}           # rel_id -> {properties incl. colour}
    rel_member_ways = {}     # rel_id -> ordered deduplicated way ids
    way_colours = {}         # way_id -> set of colours of relations containing it
    guideposts = {}          # node_id -> {"name": ..., "ele": ..., "colours": set()}

    class Collector(osmium.SimpleHandler):
        def relation(self, r):
            if r.tags.get("type") != "route" or r.tags.get("route") != "hiking":
                return
            colour = route_colour(r.tags)
            if colour is None:
                return
            relations[r.id] = {
                "id": r.id,
                "name": r.tags.get("name"),
                "ref": r.tags.get("ref"),
                "network": r.tags.get("network"),
                "colour": colour,
            }
            seen = set()
            ways = []
            for m in r.members:
                if m.type == "w" and m.ref not in seen:
                    seen.add(m.ref)
                    ways.append(m.ref)
                    way_colours.setdefault(m.ref, set()).add(colour)
            rel_member_ways[r.id] = ways

        def node(self, n):
            t = n.tags
            if t.get("tourism") == "information" and t.get("information") == "guidepost":
                guideposts[n.id] = {
                    "name": t.get("name"),
                    "ele": t.get("ele"),
                    "colours": set(),
                }

    c = Collector()
    c.apply_file(pbf_path)
    print(f"  Pass 1: {len(relations)} KČT hiking relations, "
          f"{len(guideposts)} guideposts, "
          f"{sum(len(v) for v in rel_member_ways.values())} member ways")

    needed_ways = set()
    for ways in rel_member_ways.values():
        needed_ways.update(ways)
    print(f"  Unique ways needed: {len(needed_ways)}")

    # ── Pass 2: node locations, way geometries, guidepost colour aggregation ──
    way_coords = {}          # way_id -> list of (lon, lat)
    # colour aggregation grid: cell -> set of colours passing through it
    cell_colours = defaultdict(set)

    class GeomCollector(osmium.SimpleHandler):
        def __init__(self):
            super().__init__()
            self.node_locs = {}

        def node(self, n):
            if n.location.valid():
                self.node_locs[n.id] = (n.lon, n.lat)

        def way(self, w):
            colours = way_colours.get(w.id)
            if colours:
                for node in w.nodes:
                    if node.location.valid():
                        cell = (
                            round(node.location.lon / CELL_SIZE),
                            round(node.location.lat / CELL_SIZE),
                        )
                        cell_colours[cell].update(colours)
            if w.id not in needed_ways:
                return
            coords = []
            for node in w.nodes:
                loc = self.node_locs.get(node.ref)
                if loc:
                    coords.append(loc)
            if coords:
                way_coords[w.id] = coords

    gc = GeomCollector()
    gc.apply_file(pbf_path, locations=True)
    print(f"  Pass 2: {len(gc.node_locs)} nodes cached, {len(way_coords)} ways with geometry")

    # Guidepost colours from the 3×3 grid neighbourhood of each post.
    for node_id, data in guideposts.items():
        loc = gc.node_locs.get(node_id)
        if not loc:
            continue
        cx, cy = round(loc[0] / CELL_SIZE), round(loc[1] / CELL_SIZE)
        colours = set()
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                colours.update(cell_colours.get((cx + dx, cy + dy), ()))
        data["colours"] = colours

    # ── Assemble route features ──
    features = []
    skipped_no_geom = 0
    for rel_id, props in relations.items():
        all_coords = [
            way_coords[way_id]
            for way_id in rel_member_ways.get(rel_id, [])
            if way_id in way_coords
        ]
        if not all_coords:
            skipped_no_geom += 1
            continue
        features.append({
            "type": "Feature",
            "properties": props,
            "geometry": {"type": "MultiLineString", "coordinates": all_coords},
        })

    if skipped_no_geom:
        print(f"  Skipped {skipped_no_geom} relations with no geometry")

    for path, collection in (
        (routes_path, {"type": "FeatureCollection", "features": features}),
        (guideposts_path, {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "properties": {
                        "id": node_id,
                        "name": data["name"],
                        "ele": data["ele"],
                        "colours": sorted(data["colours"]),
                    },
                    "geometry": {"type": "Point", "coordinates": gc.node_locs[node_id]},
                }
                for node_id, data in guideposts.items()
                if node_id in gc.node_locs
            ],
        }),
    ):
        with open(path, "w") as f:
            json.dump(collection, f)
        size_mb = os.path.getsize(path) / (1024 * 1024)
        print(f"  Wrote {len(collection['features'])} features to {path} ({size_mb:.1f} MB)")

    print(f"Done in {time.time() - start:.1f}s")


if __name__ == "__main__":
    main()
