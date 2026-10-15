#!/usr/bin/env python3
"""Stream cycling routes, KČT hiking routes, and guideposts as layered NDJSON.

The output is intended for Tippecanoe on stdout. OSM is scanned twice: once to
collect route relations and guideposts, then to collect route-way geometry and
the grid used to approximate trail colours at nearby guideposts.
"""

import json
import sys
import time
from collections import defaultdict

KCT_COLOURS = ("red", "blue", "green", "yellow")
CELL_SIZE = 0.001


def route_colour(tags):
    """Normalize a relation's marking to one of the KČT colours, or None."""
    colour = (tags.get("colour") or "").strip().lower()
    if not colour:
        colour = (tags.get("osmc:symbol") or "").split(":")[0].strip().lower()
    return colour if colour in KCT_COLOURS else None


def emit_feature(layer, properties, geometry):
    """Write one Tippecanoe-layered GeoJSON feature to stdout."""
    feature = {
        "type": "Feature",
        "tippecanoe": {"layer": layer},
        "properties": properties,
        "geometry": geometry,
    }
    sys.stdout.write(json.dumps(feature, separators=(",", ":")) + "\n")


def main():
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <input.pbf>", file=sys.stderr)
        return 2

    pbf_path = sys.argv[1]
    import osmium

    start = time.time()
    bicycle_relations = {}
    bicycle_member_ways = {}
    hiking_relations = {}
    hiking_member_ways = {}
    hiking_way_colours = {}
    guideposts = {}

    class RelationCollector(osmium.SimpleHandler):
        def relation(self, relation):
            tags = relation.tags
            route = tags.get("route")
            if tags.get("type") != "route" or route not in ("bicycle", "hiking"):
                return

            colour = route_colour(tags) if route == "hiking" else None
            if route == "hiking" and colour is None:
                return

            if route == "bicycle":
                properties = {"id": relation.id}
                for key in ("name", "ref", "network", "operator"):
                    value = tags.get(key)
                    if value:
                        properties[key] = value
                relations = bicycle_relations
                members_by_relation = bicycle_member_ways
            else:
                properties = {
                    "id": relation.id,
                    "name": tags.get("name"),
                    "ref": tags.get("ref"),
                    "network": tags.get("network"),
                    "colour": colour,
                }
                relations = hiking_relations
                members_by_relation = hiking_member_ways

            relations[relation.id] = properties
            seen = set()
            ways = []
            for member in relation.members:
                if member.type != "w" or member.ref in seen:
                    continue
                seen.add(member.ref)
                ways.append(member.ref)
                if route == "hiking":
                    hiking_way_colours.setdefault(member.ref, set()).add(colour)
            members_by_relation[relation.id] = ways

        def node(self, node):
            tags = node.tags
            if (tags.get("tourism") != "information"
                    or tags.get("information") != "guidepost"
                    or not node.location.valid()):
                return
            guideposts[node.id] = {
                "name": tags.get("name"),
                "ele": tags.get("ele"),
                "coordinates": (node.lon, node.lat),
                "colours": set(),
            }

    print("Pass 1/2: reading route relations and guideposts...", file=sys.stderr)
    RelationCollector().apply_file(pbf_path)

    bicycle_ways = {
        way_id
        for member_ways in bicycle_member_ways.values()
        for way_id in member_ways
    }
    hiking_ways = {
        way_id
        for member_ways in hiking_member_ways.values()
        for way_id in member_ways
    }
    needed_ways = bicycle_ways | hiking_ways
    print(
        f"  {len(bicycle_relations)} bicycle relations, "
        f"{len(hiking_relations)} KČT hiking relations, "
        f"{len(guideposts)} guideposts; {len(needed_ways)} unique route ways",
        file=sys.stderr,
    )

    way_coords = {}
    cell_colours = defaultdict(set)

    class WayGeometryCollector(osmium.SimpleHandler):
        def way(self, way):
            colours = hiking_way_colours.get(way.id)
            if colours:
                for node in way.nodes:
                    if node.location.valid():
                        cell = (
                            round(node.location.lon / CELL_SIZE),
                            round(node.location.lat / CELL_SIZE),
                        )
                        cell_colours[cell].update(colours)

            if way.id not in needed_ways:
                return
            coords = [
                (node.location.lon, node.location.lat)
                for node in way.nodes
                if node.location.valid()
            ]
            if coords:
                way_coords[way.id] = coords

    print("Pass 2/2: reading route-way geometry...", file=sys.stderr)
    WayGeometryCollector().apply_file(pbf_path, locations=True)
    print(f"  {len(way_coords)} route ways have geometry", file=sys.stderr)

    for data in guideposts.values():
        lon, lat = data["coordinates"]
        cx, cy = round(lon / CELL_SIZE), round(lat / CELL_SIZE)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                data["colours"].update(cell_colours.get((cx + dx, cy + dy), ()))

    skipped_bicycle = 0
    for relation_id, properties in bicycle_relations.items():
        coordinates = [
            way_coords[way_id]
            for way_id in bicycle_member_ways[relation_id]
            if way_id in way_coords
        ]
        if not coordinates:
            skipped_bicycle += 1
            continue
        emit_feature(
            "cycleroutes",
            properties,
            {"type": "MultiLineString", "coordinates": coordinates},
        )

    skipped_hiking = 0
    for relation_id, properties in hiking_relations.items():
        coordinates = [
            way_coords[way_id]
            for way_id in hiking_member_ways[relation_id]
            if way_id in way_coords
        ]
        if not coordinates:
            skipped_hiking += 1
            continue
        emit_feature(
            "hikingroutes",
            properties,
            {"type": "MultiLineString", "coordinates": coordinates},
        )

    for node_id, data in guideposts.items():
        emit_feature(
            "guideposts",
            {
                "id": node_id,
                "name": data["name"],
                "ele": data["ele"],
                "colours": sorted(data["colours"]),
            },
            {"type": "Point", "coordinates": data["coordinates"]},
        )

    print(
        f"Done in {time.time() - start:.1f}s; skipped {skipped_bicycle} bicycle "
        f"and {skipped_hiking} hiking relations without geometry",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
