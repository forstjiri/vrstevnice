#!/usr/bin/env python3
"""
Render tests/fixtures/test-graph.osm as SVG for visualization.

Reads the OSM file, parses nodes and ways, and produces a color-coded SVG.
Cross-links rendered as thin dashed lines.
"""
import re
import os
import svgwrite

OSM_PATH = os.path.normpath(os.path.join(
    os.path.dirname(__file__), '..', 'tests', 'fixtures', 'test-graph.osm'))
OUT_PATH = os.path.normpath(os.path.join(
    os.path.dirname(__file__), '..', 'tests', 'fixtures', 'test-graph.svg'))

with open(OSM_PATH) as f:
    xml = f.read()

# Parse nodes: id -> (lat, lon, name, {tag: val})
nodes = {}
for m in re.finditer(r'<node\s+id="(\d+)"\s+lat="([^"]+)"\s+lon="([^"]+)">(.*?)</node>', xml, re.DOTALL):
    nid = m.group(1)
    lat = float(m.group(2))
    lon = float(m.group(3))
    inner = m.group(4)
    name = re.search(r'<tag k="name" v="([^"]+)"', inner)
    name = name.group(1) if name else f'nid_{nid}'
    tags = dict(re.findall(r'<tag k="([^"]+)" v="([^"]+)"', inner))
    nodes[nid] = {'lat': lat, 'lon': lon, 'name': name, 'tags': tags}

# Parse ways: [way_id, nds, {tag:val}]
ways = []
for m in re.finditer(r'<way\s+id="\d+">(.*?)</way>', xml, re.DOTALL):
    inner = m.group(1)
    nds = re.findall(r'<nd\s+ref="(\d+)"', inner)
    tags = dict(re.findall(r'<tag k="([^"]+)" v="([^"]+)"', inner))
    ways.append((nds, tags))

# Bounding box with padding
lons = [n['lon'] for n in nodes.values()]
lats = [n['lat'] for n in nodes.values()]
min_lon, max_lon = min(lons) - 0.002, max(lons) + 0.002
min_lat, max_lat = min(lats) - 0.002, max(lats) + 0.002

# Canvas
W, H = 900, 700

def proj(lon, lat):
    x = ((lon - min_lon) / (max_lon - min_lon)) * (W - 60) + 30
    y = H - ((lat - min_lat) / (max_lat - min_lat)) * (H - 60) - 30
    return x, y

dw = svgwrite.Drawing(size=(W, H))
dw.add(dw.rect(insert=(0, 0), size=(W, H), fill='white'))

# Colors for highway types
COLORS = {
    'trunk': '#e74c3c',
    'primary': '#e67e22',
    'secondary': '#f1c40f',
    'tertiary': '#2ecc71',
    'cycleway': '#3498db',
    'unclassified': '#95a5a6',
}
COLORS_DEFAULT = '#7f8c8d'

# Draw ways (first pass: cross-links dashed, then main ways)
for nds, tags in ways:
    hwy = tags.get('highway', '')
    color = COLORS.get(hwy, COLORS_DEFAULT)
    is_cross = tags.get('name', '').startswith('X_')
    
    pts = []
    for ref in nds:
        if ref in nodes:
            n = nodes[ref]
            pts.append(proj(n['lon'], n['lat']))
    
    if len(pts) < 2:
        continue
    
    for i in range(len(pts) - 1):
        kwargs = {
            'stroke': color,
            'stroke_width': 1.5 if not is_cross else 1.0,
            'fill': 'none',
            'stroke_linecap': 'round',
            'stroke_linejoin': 'round',
        }
        if is_cross:
            kwargs['stroke_dasharray'] = '6,4'
            kwargs['stroke_opacity'] = 0.6
        else:
            kwargs['stroke_opacity'] = 0.9
        
        dw.add(dw.line(start=pts[i], end=pts[i+1], **kwargs))

# Draw nodes
for nid, n in nodes.items():
    name = n['name']
    x, y = proj(n['lon'], n['lat'])
    
    # Color by path
    if name == 'Start':
        fill = '#27ae60'
        r = 8
    elif name == 'End':
        fill = '#c0392b'
        r = 8
    elif name.startswith('A_'):
        fill = '#e74c3c'
        r = 6
    elif name.startswith('B_'):
        fill = '#2ecc71'
        r = 6
    elif name.startswith('C_'):
        fill = '#3498db'
        r = 6
    elif name.startswith('X_'):
        fill = '#95a5a6'
        r = 4
    else:
        fill = '#7f8c8d'
        r = 5
    
    dw.add(dw.circle(center=(x, y), r=r, fill=fill, stroke='#333', stroke_width=1))
    dw.add(dw.text(text=name, insert=(x + 10, y + 4), font_size=8,
                 fill='#222', font_family='sans-serif', font_weight='bold'))

# Legend
legend_x = W - 130
legend_y = 20
for i, (label, color) in enumerate([
    ('Path A: trunk', '#e74c3c'),
    ('Path A: primary', '#e67e22'),
    ('Path A: secondary', '#f1c40f'),
    ('Path A: tertiary', '#2ecc71'),
    ('Path B: unclassified', '#95a5a6'),
    ('Path C: cycleway', '#3498db'),
    ('Cross-link', '#95a5a6'),
]):
    lx = legend_x
    ly = legend_y + i * 18
    sw = 1.5
    dash = '6,4' if label == 'Cross-link' else None
    kwargs = {'stroke': color, 'stroke_width': sw, 'fill': 'none'}
    if dash:
        kwargs['stroke_dasharray'] = dash
    dw.add(dw.line(start=(lx, ly), end=(lx + 20, ly), **kwargs))
    dw.add(dw.text(text=label, insert=(lx + 26, ly + 3), font_size=8, fill='#444', font_family='sans-serif'))

dw.saveas(OUT_PATH)
print(f"Saved to {OUT_PATH}")
print(f"  Nodes: {len(nodes)}, Ways: {len(ways)}")
