#!/usr/bin/env bash
# Run the laptop bot brain with sleep disabled and auto-restart.
# Usage: bash run.sh

set -euo pipefail

cd "$(dirname "$0")"

# Disable sleep — best-effort, per OS
if command -v systemd-inhibit >/dev/null 2>&1; then
  INHIBIT=("systemd-inhibit" "--what=sleep:idle" "--why=VivaTech bot running")
elif command -v caffeinate >/dev/null 2>&1; then
  INHIBIT=("caffeinate" "-i")
else
  INHIBIT=()
  echo "[run.sh] Warning: no sleep-inhibit tool found. Disable sleep manually."
fi

# Build TypeScript once for faster restarts
npm run build

while true; do
  echo "[run.sh] starting bot at $(date -Iseconds)"
  "${INHIBIT[@]}" node dist/index.js || true
  echo "[run.sh] bot exited — restarting in 5s"
  sleep 5
done
