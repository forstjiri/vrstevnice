#!/usr/bin/env bash
set -euo pipefail

# Generate vector tiles (cz.mbtiles) from Czech Republic .osm.pbf using planetiler
# Usage: ./scripts/generate-tiles.sh

DATA_DIR="$(dirname "$0")/../data"
INPUT="$DATA_DIR/czech-republic-latest.osm.pbf"
OUTPUT="$DATA_DIR/cz.mbtiles"

mkdir -p "$DATA_DIR"

# Verify input PBF exists
if [ ! -f "$INPUT" ]; then
    echo "❌ Input PBF not found: $INPUT"
    echo "   Run ./scripts/download-pbf.sh first."
    exit 1
fi

input_size=$(du -h "$INPUT" | cut -f1)
echo "📦 Input PBF: $INPUT ($input_size)"

# Skip if output already exists
if [ -f "$OUTPUT" ]; then
    size=$(du -h "$OUTPUT" | cut -f1)
    echo "✅ MBTiles already exists: $OUTPUT ($size)"
    echo "   Delete it and re-run to regenerate."
    exit 0
fi

echo "🗺️  Generating vector tiles with planetiler-openmaptiles..."
echo "   This takes 15-30 minutes and downloads ~200-300 MB of ancillary data on first run."

docker run --rm \
  -v "$(cd "$DATA_DIR" && pwd)":/data \
  -u "$(id -u):$(id -g)" \
  openmaptiles/planetiler-openmaptiles:latest \
  --osm_path=/data/czech-republic-latest.osm.pbf \
  --output=/data/cz.mbtiles \
  --download \
  --force

size=$(du -h "$OUTPUT" | cut -f1)
echo "✅ Generated: $OUTPUT ($size)"
