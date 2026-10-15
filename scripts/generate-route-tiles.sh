#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="$PROJECT_ROOT/data"
PBF="$DATA_DIR/czech-republic-latest.osm.pbf"
OUTPUT="$DATA_DIR/routes-overlay.mbtiles"
TIPPECANOE_IMAGE="ghcr.io/openwatersio/tippecanoe:2.79.0@sha256:c872aef007c8900c0cb81e41238968bb88bdfe8ba579753bd03ce3657b6316c5"
VENV="$DATA_DIR/.venv-extract"
WORK_DIR=""

die() {
  echo "❌ $*" >&2
  exit 1
}

[[ -s "$PBF" ]] || die "Chybí OSM PBF: $PBF"
command -v uv >/dev/null 2>&1 || die "Chybí uv (instalace: https://docs.astral.sh/uv/)"
command -v docker >/dev/null 2>&1 || die "Chybí Docker"
command -v python3 >/dev/null 2>&1 || die "Chybí Python 3"

mkdir -p "$DATA_DIR"
WORK_DIR="$(mktemp -d "$DATA_DIR/.routes-overlay.XXXXXX")"
WORK_NAME="$(basename "$WORK_DIR")"
cleanup() {
  if [[ -n "$WORK_DIR" && -d "$WORK_DIR" ]]; then
    rm -rf -- "$WORK_DIR"
  fi
}
trap cleanup EXIT

if [[ ! -x "$VENV/bin/python" ]]; then
  uv venv "$VENV"
fi
if ! "$VENV/bin/python" -c 'import osmium' >/dev/null 2>&1; then
  uv pip install --python "$VENV/bin/python" osmium -q
fi

echo "🗺️  Extracting routes and streaming them into Tippecanoe..."
"$VENV/bin/python" "$SCRIPT_DIR/extract_route_overlay.py" "$PBF" \
  | docker run --rm -i \
      -v "$DATA_DIR:/data" \
      -u "$(id -u):$(id -g)" \
      "$TIPPECANOE_IMAGE" \
      tippecanoe \
      --minimum-zoom=9 \
      --maximum-zoom=14 \
      --output="/data/$WORK_NAME/routes-overlay.mbtiles"

python3 - "$WORK_DIR/routes-overlay.mbtiles" <<'PY'
import json
import sqlite3
import sys

path = sys.argv[1]
with sqlite3.connect(path) as db:
    metadata = dict(db.execute("SELECT name, value FROM metadata"))
    tile_count = db.execute("SELECT COUNT(*) FROM tiles").fetchone()[0]

if tile_count == 0:
    raise SystemExit("Generated route overlay archive contains no tiles")

try:
    vector_layers = json.loads(metadata["json"])["vector_layers"]
    layer_info = {layer["id"]: layer for layer in vector_layers}
except (KeyError, TypeError, json.JSONDecodeError) as error:
    raise SystemExit(f"Generated route overlay archive has invalid layer metadata: {error}")

expected = {"cycleroutes", "hikingroutes", "guideposts"}
if set(layer_info) != expected:
    raise SystemExit(f"Expected vector layers {sorted(expected)}, got {sorted(layer_info)}")
if any(layer.get("minzoom") != 9 or layer.get("maxzoom") != 14 for layer in layer_info.values()):
    raise SystemExit("Generated route overlay archive has unexpected zoom metadata")

print(f"✅ Validated {tile_count} tiles and layers: {', '.join(sorted(layer_info))}")
PY

mv -f -- "$WORK_DIR/routes-overlay.mbtiles" "$OUTPUT"
echo "✅ Generated: $OUTPUT ($(du -h "$OUTPUT" | cut -f1))"
