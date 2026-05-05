#!/usr/bin/env python3
"""
Generate terrain-rgb mbtiles from Copernicus DEM GeoTIFF tiles.

Uses rasterio VRT for consistent, single-grid reads — eliminating
per-tile merge artifacts that caused 275m elevation jumps at tile
boundaries (visible hillshade seams).

Usage: python3 generate-terrain-tiles.py --dem-dir data/dem --output data/cz-terrain.mbtiles
"""

import argparse
import glob
import os
import sqlite3
import sys
import numpy as np
from typing import Tuple

import rasterio
from rasterio.vrt import WarpedVRT
from rasterio.crs import CRS
from rasterio.merge import merge as rio_merge
from rasterio.transform import from_bounds
from rasterio.warp import reproject, Resampling
import mercantile


def elevation_to_rgb(elevation: np.ndarray):
    enc = np.clip(elevation, -10000, 10000)
    enc = enc + 32768.0
    enc_int = np.floor(enc)
    r = np.minimum(enc_int // 256, 255).astype(np.uint8)
    g = np.minimum(enc_int % 256, 255).astype(np.uint8)
    enc_frac = (enc - enc_int) * 256
    b = np.minimum(np.floor(enc_frac), 255).astype(np.uint8)
    return r, g, b


def png_to_bytes(r: np.ndarray, g: np.ndarray, b: np.ndarray) -> bytes:
    from PIL import Image
    import io
    rgb = np.stack([r, g, b], axis=-1)
    img = Image.fromarray(rgb, mode='RGB')
    buf = io.BytesIO()
    img.save(buf, format='PNG', compress_level=1)
    return buf.getvalue()


def open_dem_sources(dem_dir: str):
    files = sorted(glob.glob(os.path.join(dem_dir, "*.tif")))
    if not files:
        print(f"No .tif files found in {dem_dir}", file=sys.stderr)
        sys.exit(1)
    print(f"   Found {len(files)} DEM tiles")
    return [rasterio.open(f) for f in files]


def build_merged_geotiff(sources, bbox: Tuple[float, float, float, float], out_path: str):
    """Merge all DEM sources into a single GeoTIFF with a consistent grid.
    
    This eliminates per-tile merge artifacts: when rio_merge is called
    separately for each output tile, the input pixel→output pixel mapping
    differs slightly between tiles, causing 100+ meter elevation jumps
    at tile boundaries. By merging once into a single raster, all tiles
    read from the same grid.
    """
    west, south, east, north = bbox

    merged, out_transform = rio_merge(
        sources,
        bounds=(west, south, east, north),
        nodata=0,
    )

    h, w = merged.shape[1], merged.shape[2]
    print(f"   Merged mosaic: {w}x{h} pixels")

    with rasterio.open(
        out_path, 'w',
        driver='GTiff',
        height=h, width=w,
        count=1,
        dtype=merged.dtype,
        crs=CRS.from_epsg(4326),
        transform=out_transform,
        nodata=0,
        compress='LZW',
        tiled=True,
        blockxsize=256,
        blockysize=256,
    ) as dst:
        dst.write(merged)

    print(f"   Saved merged DEM to {out_path}")
    return out_path


def read_elevation(merged_path: str, bounds: Tuple[float, float, float, float],
                   width: int, height: int) -> np.ndarray:
    """Read elevation from the pre-merged GeoTIFF — consistent grid."""
    west, south, east, north = bounds

    with rasterio.open(merged_path) as src:
        out_transform = from_bounds(west, south, east, north, width, height)
        data = np.zeros((height, width), dtype=np.float32)
        reproject(
            source=rasterio.band(src, 1),
            destination=data,
            src_transform=src.transform,
            src_crs=src.crs,
            dst_transform=out_transform,
            dst_crs=CRS.from_epsg(4326),
            resampling=Resampling.bilinear,
        )
    return data


def create_mbtiles(output_path: str):
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
    cur.execute("INSERT INTO metadata VALUES ('version', '1')")
    cur.execute("INSERT INTO metadata VALUES ('description', 'Copernicus DEM terrain-rgb (terrarium)')")
    cur.execute("INSERT INTO metadata VALUES ('format', 'png')")
    cur.execute("INSERT INTO metadata VALUES ('bounds', '12.0,48.5,18.9,51.1')")
    cur.execute("INSERT INTO metadata VALUES ('center', '15.45,49.8,7')")
    cur.execute("INSERT INTO metadata VALUES ('minzoom', '0')")
    cur.execute("INSERT INTO metadata VALUES ('maxzoom', '12')")

    conn.commit()
    return conn


def main():
    parser = argparse.ArgumentParser(description='Generate terrain-rgb mbtiles from DEM tiles')
    parser.add_argument('--dem-dir', required=True, help='Directory with DEM GeoTIFF tiles')
    parser.add_argument('--output', required=True, help='Output mbtiles path')
    parser.add_argument('--bbox', nargs=4, type=float, default=[12.0, 48.5, 18.9, 51.1],
                        help='Bounding box: west south east north')
    parser.add_argument('--min-z', type=int, default=0, help='Minimum zoom level')
    parser.add_argument('--max-z', type=int, default=12, help='Maximum zoom level')
    args = parser.parse_args()

    west, south, east, north = args.bbox
    print(f"   Bounding box: {west},{south},{east},{north}")
    print(f"   Zoom range: {args.min_z}-{args.max_z}")

    sources = open_dem_sources(args.dem_dir)

    merged_path = os.path.join(args.dem_dir, "cz-merged.tif")
    build_merged_geotiff(sources, args.bbox, merged_path)

    for src in sources:
        src.close()

    conn = create_mbtiles(args.output)
    cur = conn.cursor()

    total_tiles = sum(
        len(list(mercantile.tiles(west, south, east, north, zooms=[z])))
        for z in range(args.min_z, args.max_z + 1)
    )
    print(f"   Total tiles to generate: {total_tiles}")

    processed = 0
    for z in range(args.min_z, args.max_z + 1):
        tiles = list(mercantile.tiles(west, south, east, north, zooms=[z]))
        print(f"   Zoom {z}: {len(tiles)} tiles", end='', flush=True)

        for i, tile in enumerate(tiles):
            bounds = mercantile.bounds(tile)
            elev = read_elevation(merged_path, bounds, 256, 256)

            r, g, b = elevation_to_rgb(elev)
            png_data = png_to_bytes(r, g, b)

            tms_y = (2 ** z) - 1 - tile.y
            cur.execute(
                'INSERT OR REPLACE INTO tiles VALUES (?, ?, ?, ?)',
                (z, tile.x, tms_y, png_data)
            )
            processed += 1

            if (i + 1) % 20 == 0 or (i + 1) == len(tiles):
                print(f' {i+1}/{len(tiles)}', end='', flush=True)

        conn.commit()
        print(f" ✓")

    conn.close()
    print(f"   Done: {processed} tiles written to {args.output}")


if __name__ == '__main__':
    main()
