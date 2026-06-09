#!/usr/bin/env python3
"""
Generate terrain-rgb mbtiles from ČÚZK DMR 5G (Digital Terrain Model 5th Gen).

Downloads elevation data from ČÚZK ArcGIS Image Server in tiles,
reprojects from EPSG:5514 (S-JTSK) to EPSG:4326 (WGS84),
and generates terrain-rgb mbtiles for MapLibre hillshade.

DMR 5G: 5 m grid, LiDAR-based, ±0.3 m vertical accuracy.
Source: https://ags.cuzk.cz/arcgis2/rest/services/dmr5g/ImageServer

Usage:
  # Full Czech Republic (slow, ~5-10 GB output):
  python3 generate-terrain-tiles-dmr5g.py --output data/cz-terrain.mbtiles

  # Custom bbox and zoom:
  python3 generate-terrain-tiles-dmr5g.py \
    --bbox 14.0 49.8 15.0 50.2 \
    --min-z 0 --max-z 14 \
    --output data/cz-terrain.mbtiles

Requirements:
  uv venv .venv-terrain && source .venv-terrain/bin/activate
  uv pip install rasterio mercantile Pillow numpy
"""

import argparse
import io
import math
import os
import sqlite3
import sys
import time

import numpy as np
import mercantile
import rasterio
from rasterio.crs import CRS
from rasterio.transform import from_bounds
from rasterio.warp import reproject, Resampling, calculate_default_transform, transform_bounds
from PIL import Image

# ČÚZK ArcGIS Image Server for DMR 5G
DMR5G_URL = "https://ags.cuzk.cz/arcgis2/rest/services/dmr5g/ImageServer/exportImage"

# Czech Republic approximate bounds (WGS84)
CR_BBOX = (12.0, 48.5, 18.9, 51.1)

# S-JTSK bounds for Czech Republic (EPSG:5514)
# These cover slightly more than CR to avoid edge artifacts
SJTSK_BBOX = (-930000, -1240000, -400000, -920000)

# Tile download parameters
TILE_SIZE_PX = 2048  # Pixels per download tile (larger = fewer requests but more memory)
REQUEST_DELAY = 0.1  # Seconds between requests to be polite to ČÚZK


def download_elevation_tile(sjtsk_bbox: tuple, px_size: int = TILE_SIZE_PX) -> np.ndarray:
    """Download elevation data from ČÚZK ArcGIS Image Server.

    Returns a 2D float32 numpy array with elevation in meters.
    CRS: EPSG:5514 (S-JTSK / Krovak East North)
    """
    xmin, ymin, xmax, ymax = sjtsk_bbox
    bbox_str = f"{xmin},{ymin},{xmax},{ymax}"

    url = (
        f"{DMR5G_URL}"
        f"?bbox={bbox_str}"
        f"&bboxSR=5514"
        f"&imageSR=5514"
        f"&size={px_size},{px_size}"
        f"&format=tiff"
        f"&pixelType=F32"
        f"&noData=0"
        f"&f=image"
    )

    import urllib.request
    for attempt in range(3):
        try:
            resp = urllib.request.urlopen(url, timeout=60)
            data = resp.read()
            break
        except Exception as e:
            if attempt < 2:
                time.sleep(2 ** attempt)
            else:
                raise RuntimeError(f"Failed to download tile after 3 attempts: {e}") from e

    with rasterio.open(io.BytesIO(data)) as src:
        elev = src.read(1).astype(np.float32)

    return elev


def elevation_to_rgb(elevation: np.ndarray):
    """MapLibre terrarium encoding: (height + 32768) * 256 → R, G, B."""
    enc = np.clip(elevation, -10000, 10000)
    enc = enc + 32768.0
    enc_int = np.floor(enc)
    r = np.minimum(enc_int // 256, 255).astype(np.uint8)
    g = np.minimum(enc_int % 256, 255).astype(np.uint8)
    enc_frac = (enc - enc_int) * 256
    b = np.minimum(np.floor(enc_frac), 255).astype(np.uint8)
    return r, g, b


def png_to_bytes(r: np.ndarray, g: np.ndarray, b: np.ndarray) -> bytes:
    """Encode RGB arrays as PNG bytes."""
    rgb = np.stack([r, g, b], axis=-1)
    img = Image.fromarray(rgb, mode='RGB')
    buf = io.BytesIO()
    img.save(buf, format='PNG', compress_level=1)
    return buf.getvalue()


def create_mbtiles(output_path: str, min_zoom: int, max_zoom: int, bbox: tuple):
    """Create mbtiles database with metadata."""
    if os.path.exists(output_path):
        os.remove(output_path)

    conn = sqlite3.connect(output_path)
    cur = conn.cursor()
    cur.execute('CREATE TABLE metadata (name text, value text)')
    cur.execute('CREATE TABLE tiles (zoom_level integer, tile_column integer, tile_row integer, tile_data blob)')
    cur.execute('CREATE UNIQUE INDEX idx_tiles ON tiles (zoom_level, tile_column, tile_row)')
    cur.execute('CREATE INDEX idx_metadata ON metadata (name)')

    cur.execute("INSERT INTO metadata VALUES ('name', 'cz-terrain')")
    cur.execute("INSERT INTO metadata VALUES ('type', 'terrain')")
    cur.execute("INSERT INTO metadata VALUES ('version', '2')")
    cur.execute("INSERT INTO metadata VALUES ('description', 'ČÚZK DMR 5G terrain-rgb (terrarium encoding)')")
    cur.execute("INSERT INTO metadata VALUES ('format', 'png')")
    west, south, east, north = bbox
    center_lon = (west + east) / 2
    center_lat = (south + north) / 2
    center_zoom = min(max_zoom, max(min_zoom, 7))
    cur.execute("INSERT INTO metadata VALUES ('bounds', ?)", (f'{west},{south},{east},{north}',))
    cur.execute("INSERT INTO metadata VALUES ('center', ?)", (f'{center_lon},{center_lat},{center_zoom}',))
    cur.execute("INSERT INTO metadata VALUES ('minzoom', ?)", (str(min_zoom),))
    cur.execute("INSERT INTO metadata VALUES ('maxzoom', ?)", (str(max_zoom),))

    conn.commit()
    return conn


class DEMTileCache:
    """Downloads and caches DMR 5G tiles as EPSG:5514 rasters.

    Splits the download area into a grid of large tiles to balance
    download speed vs memory usage. Each cached tile is reused when
    multiple output mbtile tiles overlap it.
    """

    def __init__(self, cache_dir: str = "data/dem-dmr5g"):
        self.cache_dir = cache_dir
        os.makedirs(cache_dir, exist_ok=True)
        self._mem_cache = {}

    def _tile_path(self, tx: int, ty: int) -> str:
        return os.path.join(self.cache_dir, f"dmr5g_{tx}_{ty}.tif")

    def get_tile(self, tx: int, ty: int) -> np.ndarray:
        """Get elevation data for a grid tile. Downloads if not cached."""
        if (tx, ty) in self._mem_cache:
            return self._mem_cache[(tx, ty)]

        path = self._tile_path(tx, ty)
        if os.path.exists(path):
            with rasterio.open(path) as src:
                data = src.read(1).astype(np.float32)
        else:
            # Calculate S-JTSK bounds for this tile
            xsize = 50000  # 50 km per grid tile
            ysize = 50000
            xmin = SJTSK_BBOX[0] + tx * xsize
            ymin = SJTSK_BBOX[1] + ty * ysize
            xmax = xmin + xsize
            ymax = ymin + ysize

            # Skip tiles outside Czech Republic
            if xmax < SJTSK_BBOX[0] or xmin > SJTSK_BBOX[2]:
                return None
            if ymax < SJTSK_BBOX[1] or ymin > SJTSK_BBOX[3]:
                return None

            print(f"    Downloading DMR 5G tile ({tx},{ty}) "
                  f"S-JTSK [{xmin:.0f},{ymin:.0f}]-[{xmax:.0f},{ymax:.0f}]...", end='', flush=True)
            data = download_elevation_tile((xmin, ymin, xmax, ymax))
            print(f" {data.shape}, elev {np.nanmin(data):.0f}-{np.nanmax(data):.0f}m", flush=True)

            # Save to disk cache
            h, w = data.shape
            transform = rasterio.transform.from_bounds(xmin, ymin, xmax, ymax, w, h)
            with rasterio.open(
                path, 'w', driver='GTiff', height=h, width=w, count=1,
                dtype='float32', crs=CRS.from_epsg(5514),
                transform=transform, nodata=0, compress='LZW',
            ) as dst:
                dst.write(data, 1)

            time.sleep(REQUEST_DELAY)

        self._mem_cache[(tx, ty)] = data
        return data


def read_elevation_from_cache(
    cache: DEMTileCache,
    wgs84_bounds: tuple,
    width: int,
    height: int,
) -> np.ndarray:
    """Read elevation for a WGS84 bounding box by reprojecting from S-JTSK.

    Reprojects the WGS84 bounds to S-JTSK, reads from the cached DMR 5G tiles,
    then reprojects the elevation data to the output grid in WGS84.
    """
    west, south, east, north = wgs84_bounds

    # Transform WGS84 bounds to S-JTSK (EPSG:5514)
    src_crs = CRS.from_epsg(4326)
    dst_crs = CRS.from_epsg(5514)

    try:
        sjtsk_bounds = transform_bounds(src_crs, dst_crs, west, south, east, north)
    except Exception:
        return np.full((height, width), np.nan, dtype=np.float32)

    sjtsk_west, sjtsk_south, sjtsk_east, sjtsk_north = sjtsk_bounds

    # Find which cache tiles overlap. Use floor/ceil with a 1-tile buffer so
    # border tiles are not truncated away by integer rounding.
    xsize = 50000
    ysize = 50000
    tx_min = max(0, math.floor((sjtsk_west - SJTSK_BBOX[0]) / xsize) - 1)
    tx_max = math.ceil((sjtsk_east - SJTSK_BBOX[0]) / xsize)
    ty_min = max(0, math.floor((sjtsk_south - SJTSK_BBOX[1]) / ysize) - 1)
    ty_max = math.ceil((sjtsk_north - SJTSK_BBOX[1]) / ysize)

    max_tx = math.ceil((SJTSK_BBOX[2] - SJTSK_BBOX[0]) / xsize) - 1
    max_ty = math.ceil((SJTSK_BBOX[3] - SJTSK_BBOX[1]) / ysize) - 1
    tx_max = min(max_tx, tx_max)
    ty_max = min(max_ty, ty_max)

    # If no overlapping tiles, return nodata
    if tx_max < 0 or ty_max < 0 or tx_min > max_tx or ty_min > max_ty or tx_min > tx_max or ty_min > ty_max:
        return np.full((height, width), np.nan, dtype=np.float32)

    # Merge overlapping cache tiles. Each tile reprojects into a temporary
    # array with src_nodata=0 so that nodata source pixels → NaN in the temp.
    # We then copy only valid (non-NaN) pixels into result — this prevents a
    # later tile's nodata areas from overwriting valid data from an earlier tile.
    result = np.full((height, width), np.nan, dtype=np.float32)
    has_data = False

    for tx in range(tx_min, tx_max + 1):
        for ty in range(ty_min, ty_max + 1):
            tile_data = cache.get_tile(tx, ty)
            if tile_data is None:
                continue

            # Build a rasterio dataset from the cached tile for reprojection
            tile_path = cache._tile_path(tx, ty)
            try:
                with rasterio.open(tile_path) as src:
                    out_transform = from_bounds(west, south, east, north, width, height)
                    temp = np.full((height, width), np.nan, dtype=np.float32)
                    reproject(
                        source=rasterio.band(src, 1),
                        destination=temp,
                        src_transform=src.transform,
                        src_crs=src.crs,
                        dst_transform=out_transform,
                        dst_crs=CRS.from_epsg(4326),
                        resampling=Resampling.bilinear,
                        src_nodata=0,
                        dst_nodata=np.nan,
                    )
                    # Copy only valid (non-NaN, non-zero) pixels — keeps
                    # earlier tiles' data where this tile has no coverage.
                    valid = ~np.isnan(temp) & (temp > 0)
                    if np.any(valid):
                        has_data = True
                    result[valid] = temp[valid]
            except Exception as e:
                print(f"    Warning: reprojection failed for tile ({tx},{ty}): {e}", file=sys.stderr)

    if not has_data:
        return np.full((height, width), np.nan, dtype=np.float32)

    return result


def main():
    parser = argparse.ArgumentParser(
        description='Generate terrain-rgb mbtiles from ČÚZK DMR 5G',
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument('--output', required=True, help='Output mbtiles path')
    parser.add_argument('--bbox', nargs=4, type=float, default=list(CR_BBOX),
                        help='Bounding box WGS84: west south east north')
    parser.add_argument('--min-z', type=int, default=0)
    parser.add_argument('--max-z', type=int, default=14,
                        help='Max zoom level (14 recommended for 5m DMR 5G)')
    parser.add_argument('--cache-dir', default='data/dem-dmr5g',
                        help='Directory to cache downloaded DMR 5G tiles')
    args = parser.parse_args()

    west, south, east, north = args.bbox
    print(f"  DMR 5G → terrain-rgb mbtiles")
    print(f"  Bounding box (WGS84): {west},{south},{east},{north}")
    print(f"  Zoom range: {args.min_z}-{args.max_z}")
    print()

    cache = DEMTileCache(args.cache_dir)

    conn = create_mbtiles(args.output, args.min_z, args.max_z, args.bbox)
    cur = conn.cursor()

    # Count total tiles
    total_tiles = sum(
        len(list(mercantile.tiles(west, south, east, north, zooms=[z])))
        for z in range(args.min_z, args.max_z + 1)
    )
    print(f"  Total tiles to generate: {total_tiles}")
    print()

    processed = 0
    for z in range(args.min_z, args.max_z + 1):
        tiles = list(mercantile.tiles(west, south, east, north, zooms=[z]))
        print(f"  Zoom {z}: {len(tiles)} tiles", end='', flush=True)

        for i, tile in enumerate(tiles):
            bounds = mercantile.bounds(tile)
            elev = read_elevation_from_cache(cache, bounds, 256, 256)

            valid = ~np.isnan(elev)
            if not np.any(valid):
                continue

            if np.any(~valid):
                filled = elev.copy()
                filled[~valid] = 0
                elev = filled

            r, g, b = elevation_to_rgb(elev)
            png_data = png_to_bytes(r, g, b)

            tms_y = (2 ** z) - 1 - tile.y
            cur.execute(
                'INSERT OR REPLACE INTO tiles VALUES (?, ?, ?, ?)',
                (z, tile.x, tms_y, png_data)
            )
            processed += 1

            if (i + 1) % 100 == 0 or (i + 1) == len(tiles):
                print(f' {i+1}/{len(tiles)}', end='', flush=True)

        conn.commit()
        print(f" ✓")

    conn.close()
    size_mb = os.path.getsize(args.output) / (1024 * 1024)
    print(f"\n  Done: {processed} tiles, {size_mb:.1f} MB → {args.output}")


if __name__ == '__main__':
    main()
