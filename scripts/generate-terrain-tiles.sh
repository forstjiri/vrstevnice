#!/usr/bin/env bash
set -euo pipefail

# Generate terrain-rgb mbtiles (cz-terrain.mbtiles) from Copernicus DEM GLO-30
# elevation data using rio-rgbify (Python, runs locally).
#
# Data source: Copernicus DEM GLO-30 (30m resolution, free, no auth required)
# Hosted on AWS Open Data: https://copernicus-dem-30m.s3.eu-central-1.amazonaws.com
#
# Prerequisites: Python venv with rasterio + rio-rgbify (run setup-terrain-venv.sh first)
# Usage: ./scripts/generate-terrain-tiles.sh

SCRIPT_DIR="$(dirname "$0")"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="$PROJECT_DIR/data"
DEM_DIR="$DATA_DIR/dem"
MERGED_TIF="$DATA_DIR/cz-dem.tif"
OUTPUT="$DATA_DIR/cz-terrain.mbtiles"
VENV_DIR="$PROJECT_DIR/.venv-terrain"

# CZ bounding box (approx, 1° tiles)
LAT_MIN=48
LAT_MAX=51
LON_MIN=12
LON_MAX=18

# Copernicus DEM base URL (public AWS Open Data, no auth)
BASE_URL="https://copernicus-dem-30m.s3.eu-central-1.amazonaws.com"

mkdir -p "$DEM_DIR"

# ── Step 1: Download Copernicus DEM GeoTIFF tiles ──
echo "📥 Checking Copernicus DEM GLO-30 tiles in $DEM_DIR ..."

downloaded=0
skipped=0
failed=0
for lat in $(seq $LAT_MIN $LAT_MAX); do
  lat_pad=$(printf "%02d" $lat)
  for lon in $(seq $LON_MIN $LON_MAX); do
    lon_pad=$(printf "%03d" $lon)
    # Copernicus naming: Copernicus_DSM_COG_10_N49_00_E014_00_DEM
    tile_name="Copernicus_DSM_COG_10_N${lat_pad}_00_E${lon_pad}_00_DEM"
    filename="${tile_name}.tif"
    filepath="$DEM_DIR/$filename"

    if [ -f "$filepath" ]; then
      skipped=$((skipped + 1))
      continue
    fi

    url="${BASE_URL}/${tile_name}/${filename}"
    echo "   Downloading $filename ..."
    http_code=$(curl -sL -w '%{http_code}' -o "$filepath" "$url") || true
    if [ "$http_code" = "200" ] && [ -s "$filepath" ]; then
      downloaded=$((downloaded + 1))
    else
      echo "   ⚠️  ${tile_name} not available (HTTP $http_code), skipping"
      rm -f "$filepath"
      failed=$((failed + 1))
    fi
  done
done

echo "   Downloaded: $downloaded, Skipped (already present): $skipped, Failed: $failed"

tif_count=$(ls "$DEM_DIR"/*.tif 2>/dev/null | wc -l)
if [ "$tif_count" -eq 0 ]; then
    echo "❌ No DEM .tif files found in $DEM_DIR"
    exit 1
fi

# ── Step 2: Merge + Convert to terrain-rgb mbtiles ──
if [ -f "$OUTPUT" ]; then
    size=$(du -h "$OUTPUT" | cut -f1)
    echo "✅ Terrain mbtiles already exists: $OUTPUT ($size)"
    echo "   Delete it and re-run to regenerate."
    exit 0
fi

# Activate venv with rasterio + rio-rgbify
if [ ! -f "$VENV_DIR/bin/activate" ]; then
    echo "❌ Python venv not found at $VENV_DIR"
    echo "   Run: uv venv $VENV_DIR && source $VENV_DIR/bin/activate && uv pip install rasterio rio-rgbify"
    exit 1
fi

source "$VENV_DIR/bin/activate"

echo "🎨 Converting DEM to terrain-rgb mbtiles ..."
echo "   Merging tiles → terrain-rgb → mbtiles (this takes a few minutes) ..."

python3 "$SCRIPT_DIR/generate-terrain-tiles.py" \
    --dem-dir "$DEM_DIR" \
    --output "$OUTPUT" \
    --bbox 12.0 48.5 18.9 51.1 \
    --min-z 0 --max-z 11

size=$(du -h "$OUTPUT" | cut -f1)
echo "✅ Generated: $OUTPUT ($size)"
