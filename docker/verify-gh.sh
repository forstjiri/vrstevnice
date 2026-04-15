#!/usr/bin/env bash
set -euo pipefail

# Verify GraphHopper routing with custom models and elevation
# Usage: ./docker/verify-gh.sh [BASE_URL]
# BASE_URL defaults to http://localhost:8989

BASE_URL="${1:-http://localhost:8989}"
PASSED=0
FAILED=0

pass() { echo "✅ $1"; PASSED=$((PASSED + 1)); }
fail() { echo "❌ $1"; FAILED=$((FAILED + 1)); }

echo "=== GraphHopper Routing Verification ==="
echo "Target: $BASE_URL"
echo ""

# --- Step 1: Wait for GH readiness ---
echo "--- Step 1: Waiting for GH readiness ---"
MAX_WAIT=600  # 10 minutes max (GH needs time to import)
WAITED=0
while [ $WAITED -lt $MAX_WAIT ]; do
    if curl -sf "$BASE_URL/health" > /dev/null 2>&1; then
        echo "GH is healthy after ${WAITED}s"
        break
    fi
    sleep 5
    WAITED=$((WAITED + 5))
    # Show import progress from container logs
    if [ $((WAITED % 30)) -eq 0 ]; then
        echo "  Still waiting... (${WAITED}s elapsed)"
        docker compose logs --tail=3 graphhopper 2>/dev/null | sed 's/^/  /' || true
    fi
done

if [ $WAITED -ge $MAX_WAIT ]; then
    echo "❌ GH did not become healthy within ${MAX_WAIT}s"
    echo "Last container logs:"
    docker compose logs --tail=20 graphhopper 2>/dev/null || true
    exit 1
fi

# Quick /info check
INFO=$(curl -sf "$BASE_URL/info")
echo "Available profiles: $(echo "$INFO" | python3 -c 'import sys,json; profiles=[p["name"] for p in json.load(sys.stdin).get("profiles",[])]; print(", ".join(profiles) if profiles else "none")' 2>/dev/null || echo 'parse-failed')"
echo ""

# --- Step 2: Route request with elevation ---
echo "--- Step 2: Route Prague → Brno with bike + elevation ---"

ROUTE_JSON=$(curl -sf "$BASE_URL/route" \
    -H "Content-Type: application/json" \
    -d '{
        "points": [[14.4378, 50.0755], [16.6068, 49.1951]],
        "profile": "bike",
        "ch.disable": true,
        "elevation": true,
        "points_encoded": false,
        "custom_model": {
            "distance_influence": 70,
            "priority": [
                {"if": "road_class == MOTORWAY || road_class == TRUNK", "multiply_by": "0.1"}
            ]
        }
    }' 2>&1)

if [ $? -ne 0 ]; then
    fail "POST /route returned non-zero exit code"
    echo "$ROUTE_JSON"
    exit 1
fi

# Parse response fields
DISTANCE=$(echo "$ROUTE_JSON" | python3 -c 'import sys,json; d=json.load(sys.stdin)["paths"][0]["distance"]; print(d)')
TIME=$(echo "$ROUTE_JSON" | python3 -c 'import sys,json; d=json.load(sys.stdin)["paths"][0]["time"]; print(d)')
ASCEND=$(echo "$ROUTE_JSON" | python3 -c 'import sys,json; d=json.load(sys.stdin)["paths"][0]["ascend"]; print(d)')
DESCEND=$(echo "$ROUTE_JSON" | python3 -c 'import sys,json; d=json.load(sys.stdin)["paths"][0]["descend"]; print(d)')
COORD_COUNT=$(echo "$ROUTE_JSON" | python3 -c 'import sys,json; pts=json.load(sys.stdin)["paths"][0]["points"]["coordinates"]; print(len(pts))')

echo "  distance: ${DISTANCE}m"
echo "  time: ${TIME}ms"
echo "  ascend: ${ASCEND}m"
echo "  descend: ${DESCEND}m"
echo "  coordinate count: ${COORD_COUNT}"
echo ""

# Validate response structure
[ "$(echo "$DISTANCE" | awk '{print ($1 > 0)}')" = "1" ] && pass "distance > 0 (${DISTANCE}m)" || fail "distance not > 0 (${DISTANCE}m)"
[ "$(echo "$TIME" | awk '{print ($1 > 0)}')" = "1" ] && pass "time > 0 (${TIME}ms)" || fail "time not > 0 (${TIME}ms)"
[ "$(echo "$ASCEND" | awk '{print ($1 >= 0)}')" = "1" ] && pass "ascend >= 0 (${ASCEND}m)" || fail "ascend not >= 0 (${ASCEND}m)"
[ "$(echo "$DESCEND" | awk '{print ($1 >= 0)}')" = "1" ] && pass "descend >= 0 (${DESCEND}m)" || fail "descend not >= 0 (${DESCEND}m)"
[ "$(echo "$COORD_COUNT" | awk '{print ($1 > 0)}')" = "1" ] && pass "coordinates count > 0 (${COORD_COUNT})" || fail "coordinates count not > 0 (${COORD_COUNT})"

DISTANCE_1=$DISTANCE

echo ""

# --- Step 3: Verify elevation is present in coordinates ---
echo "--- Step 3: Verify elevation in coordinates ---"

HAS_ELEVATION=$(echo "$ROUTE_JSON" | python3 -c '
import sys, json
pts = json.load(sys.stdin)["paths"][0]["points"]["coordinates"]
has_3d = any(len(p) >= 3 and p[2] != 0 for p in pts[:50])
print("yes" if has_3d else "no")
')

if [ "$HAS_ELEVATION" = "yes" ]; then
    # Show first few elevation values
    ELEV_SAMPLES=$(echo "$ROUTE_JSON" | python3 -c '
import sys, json
pts = json.load(sys.stdin)["paths"][0]["points"]["coordinates"]
for p in pts[:5]:
    if len(p) >= 3:
        print(f"  ({p[0]:.5f}, {p[1]:.5f}, ele={p[2]:.1f}m)")
')
    echo "$ELEV_SAMPLES"
    pass "Elevation data present in coordinates"
else
    fail "No elevation data found in coordinates"
fi

echo ""

# --- Step 4: Route with MOTORWAY/TRUNK penalization ---
echo "--- Step 4: Route with heavy MOTORWAY/TRUNK penalization ---"

ROUTE2_JSON=$(curl -sf "$BASE_URL/route" \
    -H "Content-Type: application/json" \
    -d '{
        "points": [[14.4378, 50.0755], [16.6068, 49.1951]],
        "profile": "bike",
        "ch.disable": true,
        "elevation": true,
        "points_encoded": false,
        "custom_model": {
            "distance_influence": 70,
            "priority": [
                {"if": "road_class == MOTORWAY || road_class == TRUNK", "multiply_by": "0.01"}
            ]
        }
    }' 2>&1)

DISTANCE_2=$(echo "$ROUTE2_JSON" | python3 -c 'import sys,json; d=json.load(sys.stdin)["paths"][0]["distance"]; print(d)')

echo "  Route 1 distance (0.1 penalty): ${DISTANCE_1}m"
echo "  Route 2 distance (0.01 penalty): ${DISTANCE_2}m"

# With stronger penalization, GH should avoid highways more aggressively
# This may result in longer distance or similar distance if no highways on optimal bike route
if [ "$(echo "$DISTANCE_2" | awk '{print ($1 > 0)}')" = "1" ]; then
    pass "Second route has valid distance (${DISTANCE_2}m)"
else
    fail "Second route distance invalid (${DISTANCE_2}m)"
fi

echo ""

# --- Summary ---
echo "=== Results: $PASSED passed, $FAILED failed ==="
if [ $FAILED -gt 0 ]; then
    exit 1
fi
exit 0
