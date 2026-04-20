#!/usr/bin/env bash
set -euo pipefail

PASS=0
FAIL=0

assert() {
  local label="$1" cmd="$2"
  if eval "$cmd" >/dev/null 2>&1; then
    echo "✅ $label"
    ((PASS++))
  else
    echo "❌ $label"
    ((FAIL++))
  fi
}

echo "=== Photon Verification ==="

# 1. Container running
assert "Photon container is running" \
  "docker compose ps photon --status running --format '{{.Name}}'"

# 2. Search returns results
RESPONSE=$(curl -sf http://localhost:2322/api?q=Liberec\&limit=1 2>/dev/null || echo "")
if echo "$RESPONSE" | jq -e '.features | length >= 1' >/dev/null 2>&1; then
  echo "✅ Photon search returns results for 'Liberec'"
  ((PASS++))
else
  echo "❌ Photon search did not return results for 'Liberec'"
  ((FAIL++))
fi

# 3. Health endpoint
STATUS=$(curl -sf http://localhost:2322/api/status 2>/dev/null || echo "")
if [ "$STATUS" = "OK" ]; then
  echo "✅ Photon /api/status returns OK"
  ((PASS++))
else
  echo "❌ Photon /api/status did not return OK (got: '$STATUS')"
  ((FAIL++))
fi

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
