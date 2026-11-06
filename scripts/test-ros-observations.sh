#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
project="ros-observations-$$"
export ROS_BRIDGE_IMAGE="fleet-ros-observations:$$"
export API_PORT="${ROS_OBSERVATIONS_API_PORT:-31192}"
results=$(mktemp -d "${TMPDIR:-/tmp}/ros-observations-XXXXXX")
compose=(docker compose -p "$project" -f compose.yaml -f compose.ros-observations.yaml)
echo "Results: $results"
cleanup() {
  local status=$?
  "${compose[@]}" exec -T ros-bridge python3 -c 'import sqlite3,json; db=sqlite3.connect("/data/fleet/bridge.sqlite3"); print(json.dumps(db.execute("SELECT id,session,sequence,body FROM telemetry_outbox ORDER BY id").fetchall()))' > "$results/pending.json" 2>/dev/null || true
  "${compose[@]}" exec -T ros-bridge cat /data/fleet/health.json > "$results/health.json" 2>/dev/null || true
  "${compose[@]}" logs --no-color > "$results/services.log" 2>&1 || true
  "${compose[@]}" down --volumes --remove-orphans > "$results/cleanup.log" 2>&1 || status=1
  docker image rm "$ROS_BRIDGE_IMAGE" >> "$results/cleanup.log" 2>&1 || status=1
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker build --network=none -t "$ROS_BRIDGE_IMAGE" ros > "$results/ros-build.log" 2>&1
"${compose[@]}" build migrate telemetry-ingestor api > "$results/build.log" 2>&1
"${compose[@]}" up -d postgres mqtt migrate telemetry-ingestor api ros-reference ros-bridge
node scripts/verify-ros-observations.mjs "http://127.0.0.1:$API_PORT" "$results" "$project" | tee "$results/test.log"
