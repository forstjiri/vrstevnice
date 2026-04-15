#!/usr/bin/env bash

API_URL="https://api.z.ai/api/monitor/usage/quota/limit"
TOKEN="086c45918f7b49aca1d12bc76205b8bc.nD9qsBLOKYPk3XrD"

THRESHOLD=50
CHECK_INTERVAL=120

# fallback: použij stdbuf + setsid (méně spolehlivé než script, ale funguje bez něj)
setsid gsd --auto --continue </dev/tty >/dev/tty 2>&1 &
PID=$!

get_usage() {
  curl -s \
    -H "Authorization: Bearer $TOKEN" \
    -H "Accept: application/json" \
    "$API_URL" \
  | jq '.data.limits[] | select(.type=="TOKENS_LIMIT") | .percentage'
}

while kill -0 $PID 2>/dev/null; do
  USAGE=$(get_usage)

  if [ -z "$USAGE" ]; then
    echo "Nepodařilo se získat usage"
    sleep $CHECK_INTERVAL
    continue
  fi

  echo "Aktuální usage: $USAGE%"

  if [ "$USAGE" -ge "$THRESHOLD" ]; then
    echo "Překročen threshold ($USAGE >= $THRESHOLD), SIGTERM..."
    kill -TERM $PID

    for i in {1..60}; do
      if ! kill -0 $PID 2>/dev/null; then
        echo "Proces ukončen gracefully"
        exit 0
      fi
      sleep 1
    done

    echo "Force kill (SIGKILL)..."
    kill -KILL $PID
    exit 1
  fi

  sleep $CHECK_INTERVAL
done
