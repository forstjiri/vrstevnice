#!/usr/bin/env bash
set -euo pipefail

# Verify end-to-end GraphHopper integration through the backend
# Usage: ./docker/verify-s02.sh [BE_URL] [GH_URL]
# BE_URL  defaults to http://localhost:3002
# GH_URL  defaults to http://localhost:8989

BE_URL="${1:-http://localhost:3002}"
GH_URL="${2:-http://localhost:8989}"
PASSED=0
FAILED=0

pass() { echo "✅ $1"; PASSED=$((PASSED + 1)); }
fail() { echo "❌ $1"; FAILED=$((FAILED + 1)); }

echo "=== S02 End-to-End Verification ==="
echo "Backend: $BE_URL"
echo "GraphHopper: $GH_URL"
echo ""

# --- Step 1: GH health check ---
echo "--- Step 1: GraphHopper health ---"
if curl -sf "$GH_URL/health" > /dev/null 2>&1; then
    pass "GraphHopper is healthy"
else
    fail "GraphHopper not reachable at $GH_URL/health"
    exit 1
fi
echo ""

# --- Step 2: Default route Praha → Brno ---
echo "--- Step 2: Default route Praha → Brno ---"

ROUTE_JSON=$(curl -sf "$BE_URL/api/route" \
    -H "Content-Type: application/json" \
    -d '{
        "stops": [
            {"lat": 50.0755, "lng": 14.4378, "name": "Praha"},
            {"lat": 49.1951, "lng": 16.6068, "name": "Brno"}
        ],
        "elevationCoefficient": 0.5,
        "roadAvoidanceCoefficient": 0.5
    }' 2>&1) || {
    fail "POST /api/route returned error (is BE running?)"
    echo "$ROUTE_JSON"
    exit 1
}

# Parse response fields
DIST=$(echo "$ROUTE_JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin)["distance"])')
DUR=$(echo "$ROUTE_JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin)["duration"])')
ELEV_GAIN=$(echo "$ROUTE_JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin)["elevationGain"])')
ELEV_LOSS=$(echo "$ROUTE_JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin)["elevationLoss"])')
GEO_COUNT=$(echo "$ROUTE_JSON" | python3 -c 'import sys,json; print(len(json.load(sys.stdin)["geometry"]))')

echo "  distance: ${DIST} km"
echo "  duration: ${DUR} s"
echo "  elevationGain: ${ELEV_GAIN} m"
echo "  elevationLoss: ${ELEV_LOSS} m"
echo "  geometry points: ${GEO_COUNT}"
echo ""

# Assertions
[ "$GEO_COUNT" -ge 100 ] 2>/dev/null && pass "geometry has 100+ points ($GEO_COUNT)" || fail "geometry has < 100 points ($GEO_COUNT)"

DIST_INT=$(echo "$DIST" | python3 -c 'import sys; print(int(float(sys.stdin.read())))')
[ "$DIST_INT" -ge 150 ] 2>/dev/null && [ "$DIST_INT" -le 300 ] 2>/dev/null && pass "distance in 150–300 km range (${DIST} km)" || fail "distance outside 150–300 km range (${DIST} km)"

[ "$(echo "$DUR > 0" | bc -l 2>/dev/null || python3 -c "print(1 if $DUR > 0 else 0)")" = "1" ] && pass "duration > 0 (${DUR} s)" || fail "duration not > 0 (${DUR} s)"

[ "$(echo "$ELEV_GAIN >= 0" | bc -l 2>/dev/null || python3 -c "print(1 if $ELEV_GAIN >= 0 else 0)")" = "1" ] && pass "elevationGain >= 0 (${ELEV_GAIN} m)" || fail "elevationGain < 0 (${ELEV_GAIN} m)"

[ "$(echo "$ELEV_LOSS >= 0" | bc -l 2>/dev/null || python3 -c "print(1 if $ELEV_LOSS >= 0 else 0)")" = "1" ] && pass "elevationLoss >= 0 (${ELEV_LOSS} m)" || fail "elevationLoss < 0 (${ELEV_LOSS} m)"

DIST_DEFAULT=$DIST
echo ""

# --- Step 3: Heavy road avoidance route ---
echo "--- Step 3: Heavy road avoidance (roadAvoidanceCoefficient=0.1) ---"

ROUTE2_JSON=$(curl -sf "$BE_URL/api/route" \
    -H "Content-Type: application/json" \
    -d '{
        "stops": [
            {"lat": 50.0755, "lng": 14.4378, "name": "Praha"},
            {"lat": 49.1951, "lng": 16.6068, "name": "Brno"}
        ],
        "elevationCoefficient": 0.5,
        "roadAvoidanceCoefficient": 0.1
    }' 2>&1) || {
    fail "Second POST /api/route returned error"
    echo "$ROUTE2_JSON"
    exit 1
}

DIST2=$(echo "$ROUTE2_JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin)["distance"])')
GEO2_COUNT=$(echo "$ROUTE2_JSON" | python3 -c 'import sys,json; print(len(json.load(sys.stdin)["geometry"]))')

echo "  default distance:    ${DIST_DEFAULT} km"
echo "  avoidance distance:  ${DIST2} km"
echo ""

# Verify the two routes are different (even slightly)
DIFF=$(python3 -c "print(abs(float('$DIST_DEFAULT') - float('$DIST2')))")

# With heavy road avoidance, the route should be different — either longer or shorter
if [ "$(python3 -c "print(1 if $DIFF > 0.1 else 0)")" = "1" ]; then
    pass "Road avoidance changes route (Δ = ${DIFF} km)"
else
    # Routes are identical — this can happen if GH finds the same optimal path
    # It's not a hard failure if both routes are valid, but we flag it
    fail "Road avoidance had no effect on distance (Δ = ${DIFF} km)"
fi

[ "$GEO2_COUNT" -ge 100 ] 2>/dev/null && pass "Avoidance route has 100+ points ($GEO2_COUNT)" || fail "Avoidance route has < 100 points ($GEO2_COUNT)"

echo ""

# --- Step 4: Verify response shape matches RouteResponse contract ---
echo "--- Step 4: Response contract validation ---"

HAS_ALL=$(echo "$ROUTE_JSON" | python3 -c '
import sys, json
d = json.load(sys.stdin)
required = ["geometry", "distance", "duration", "elevationGain", "elevationLoss"]
missing = [k for k in required if k not in d]
print("yes" if not missing else f"missing: {missing}")
')

if [ "$HAS_ALL" = "yes" ]; then
    pass "Response has all RouteResponse fields (geometry, distance, duration, elevationGain, elevationLoss)"
else
    fail "Response missing fields: $HAS_ALL"
fi

GEO_IS_ARRAY=$(echo "$ROUTE_JSON" | python3 -c '
import sys, json
d = json.load(sys.stdin)
print("yes" if isinstance(d["geometry"], list) and len(d["geometry"]) > 0 and isinstance(d["geometry"][0], list) else "no")
')

if [ "$GEO_IS_ARRAY" = "yes" ]; then
    pass "geometry is [[lat,lng], ...] array"
else
    fail "geometry is not a valid coordinate array"
fi

echo ""

# --- Summary ---
echo "=== Results: $PASSED passed, $FAILED failed ==="
if [ $FAILED -gt 0 ]; then
    exit 1
fi
exit 0
