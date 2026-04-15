#!/usr/bin/env bash
set -euo pipefail

# Download Czech Republic .pbf data from Geofabrik
# Usage: ./docker/download-pbf.sh

GEOFABRIK_URL="https://download.geofabrik.de/europe/czech-republic-latest.osm.pbf"
DATA_DIR="$(dirname "$0")/../data"
OUTPUT="$DATA_DIR/czech-republic-latest.osm.pbf"

mkdir -p "$DATA_DIR"

if [ -f "$OUTPUT" ]; then
    size=$(du -h "$OUTPUT" | cut -f1)
    echo "✅ PBF already exists: $OUTPUT ($size)"
    echo "   Delete it and re-run to re-download."
    exit 0
fi

echo "⬇️  Downloading Czech Republic OSM data (~500MB)..."
curl -L -o "$OUTPUT" "$GEOFABRIK_URL"

size=$(du -h "$OUTPUT" | cut -f1)
echo "✅ Downloaded: $OUTPUT ($size)"
