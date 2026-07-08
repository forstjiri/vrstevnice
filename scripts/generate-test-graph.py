#!/usr/bin/env python3
"""
Not needed unless we want to create new test graph based on changes in this scripts
---
Generate tests/fixtures/test-graph.osm — synthetic spiderweb for routing tests.

Three interconnected paths from START to END, covering every road_class rule.

Geometry:
  All paths share START (50.060, 14.440) and END (50.100, 14.440).
  Each path has 4 intermediate nodes (5 segments) with zigzag.
  Cross-links at levels 2 and 4 connect all three paths into one component.

Paths:
  A — direct (lon=14.440, 4.5 km) — trunk/primary/secondary/tertiary — PENALIZED
  B — medium (lon=14.450, 5.0 km) — unclassified — NOT in custom model, no penalty
  C — long (lon=14.480, 9.0 km) — cycleway — NO road penalty, CYCLEWAY boost
"""
import os

OUT = os.path.normpath(os.path.join(
    os.path.dirname(__file__), '..', 'tests', 'fixtures', 'test-graph.osm'))

# ---------------------------------------------------------------------------
# Geometry constants
# ---------------------------------------------------------------------------
# At lat 50°: 1°lon≈71.5km, 1°lat≈111.3km
START_LAT, START_LON = 50.060, 14.440
END_LAT,   END_LON   = 50.100, 14.440

A_LON = 14.440   # center — Path A (direct, penalized)
B_LON = 14.450   # +0.010° ≈ 0.7 km east — Path B (unclassified, ~5.0 km)
C_LON = 14.480   # +0.040° ≈ 2.9 km east — Path C (cycleway, long)

# 4 intermediate nodes → 5 segments covering 0.040° lat
LATS = [50.068, 50.076, 50.084, 50.092]

# Zigzag: alternate lon offset at each level
def zz(i, base_lon):
    return base_lon + (0.001 if i % 2 == 0 else -0.001)

# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------
next_id = 1
def nid():
    global next_id
    v = next_id
    next_id += 1
    return v

nodes = []  # (id, lat, lon, name[, extra_tags])
ways  = []  # (id, [nds], tags)

def add_node(lat, lon, name, **tags):
    id_ = nid()
    nodes.append((id_, lat, lon, name, tags))
    return id_

def add_way(nds, **tags):
    id_ = nid()
    ways.append((id_, nds, tags))
    return id_

# ---------------------------------------------------------------------------
# Nodes
# ---------------------------------------------------------------------------
start_id = add_node(START_LAT, START_LON, 'Start')
end_id   = add_node(END_LAT, END_LON, 'End')

# Path A: trunk → primary → secondary → tertiary (4 nodes)
# Each segment has different road_type + way-level extra tags
a_road_types = [
    ('A_Trunk',     'trunk',      {'bicycle': 'designated'}),
    ('A_Primary',   'primary',    {'cycleway': 'lane'}),
    ('A_Secondary', 'secondary',  {'cycleway': 'track'}),
    ('A_Tertiary',  'tertiary',   {}),
]
a_ids = []
for i, (name, hwy, _way_extra) in enumerate(a_road_types):
    lat = LATS[i]
    lon = zz(i, A_LON)
    a_ids.append(add_node(lat, lon, name, highway=hwy))

# Path B: unclassified (4 nodes) — NOT in any custom model rule
# Always at full priority, acts as the "neutral" middle-distance option.
b_ids = []
for i in range(len(LATS)):
    lat = LATS[i]
    lon = zz(i, B_LON)
    b_ids.append(add_node(lat, lon, f'B_Unc{i+1}', highway='unclassified'))

# Path C: cycleway (4 nodes)
c_ids = []
for i in range(len(LATS)):
    lat = LATS[i]
    lon = zz(i, C_LON)
    c_ids.append(add_node(lat, lon, f'C_Cyc{i+1}', highway='cycleway', surface='paving_stones'))

# ---------------------------------------------------------------------------
# Ways
# ---------------------------------------------------------------------------
# Helper: build a path from start through node list to end
def build_path(start, node_ids, road_type, **extra_tags):
    prev = start
    for nd in node_ids:
        add_way([prev, nd], highway=road_type, **extra_tags)
        prev = nd
    add_way([prev, end_id], highway=road_type, **extra_tags)

# Path A: each segment has different road_type + extra tags
prev = start_id
for i, nd in enumerate(a_ids):
    hwy = a_road_types[i][1]
    extra = a_road_types[i][2]
    add_way([prev, nd], highway=hwy, name=f'A_{hwy}', **extra)
    prev = nd
add_way([prev, end_id], highway='tertiary', name='A_end')

# Path B: all unclassified (no custom model penalty rules)
build_path(start_id, b_ids, 'unclassified', name='B_unclassified')

# Path C: all cycleway
build_path(start_id, c_ids, 'cycleway', name='C_cycleway', surface='paving_stones')

# Cross-links at levels 1 and 3 (LATS[1]=50.076, LATS[3]=50.092)
# Connects A↔B and B↔C at these two levels
for li in [1, 3]:
    add_way([a_ids[li], b_ids[li]], highway='unclassified', name=f'X_AB_{li}')
    add_way([b_ids[li], c_ids[li]], highway='unclassified', name=f'X_BC_{li}')

# ---------------------------------------------------------------------------
# Write OSM XML
# ---------------------------------------------------------------------------
lines = []
lines.append('<?xml version="1.0" encoding="UTF-8"?>')
lines.append('<osm version="0.6">')
lines.append('')
lines.append('  <!--')
lines.append('    Synthetic test graph for Vrstevnice routing integration tests.')
lines.append('    Generated by scripts/generate-test-graph.py')
lines.append('')
lines.append('    Three interconnected paths from Start to End:')
lines.append('    Path A (direct, ~4.5 km): trunk→primary→secondary→tertiary')
lines.append('    Path B (medium, ~5.0 km): all unclassified')
lines.append('    Path C (long, ~9.0 km): all cycleway')
lines.append('    Cross-links at midpoints connect all paths.')
lines.append('  -->')
lines.append('')
lines.append('  <!-- ===== Nodes ===== -->')
for (id_, lat, lon, name, tags) in nodes:
    lines.append(f'  <node id="{id_}" lat="{lat:.6f}" lon="{lon:.6f}">')
    lines.append(f'    <tag k="name" v="{name}"/>')
    for k, v in tags.items():
        lines.append(f'    <tag k="{k}" v="{v}"/>')
    lines.append(f'  </node>')

lines.append('')
lines.append('  <!-- ===== Ways ===== -->')
for (id_, nds, tags) in ways:
    lines.append(f'  <way id="{id_}">')
    for nd in nds:
        lines.append(f'    <nd ref="{nd}"/>')
    for k, v in tags.items():
        lines.append(f'    <tag k="{k}" v="{v}"/>')
    lines.append(f'  </way>')

lines.append('')
lines.append('</osm>')

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, 'w', encoding='utf-8') as f:
    f.write('\n'.join(lines))

print(f"Written: {OUT}")
print(f"  Nodes: {len(nodes)}")
print(f"  Ways:  {len(ways)}")
print(f"  Path A nodes: {[n[3] for n in nodes if n[3].startswith('A_')]}")
print(f"  Path B nodes: {[n[3] for n in nodes if n[3].startswith('B_')]}")
print(f"  Path C nodes: {[n[3] for n in nodes if n[3].startswith('C_')]}")
print(f"  Cross-links: {[w[2].get('name') for w in ways if w[2].get('name', '').startswith('X_')]}")
