#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
project="ros-commands-$$"
export ROS_BRIDGE_IMAGE="fleet-ros-commands:$$"
export API_PORT="${ROS_COMMANDS_API_PORT:-31194}"
export DRONE_COUNT=1 TELEMETRY_INTERVAL_MS=1000
results=$(mktemp -d "${TMPDIR:-/tmp}/ros-commands-XXXXXX")
compose=(docker compose -p "$project" -f compose.yaml -f compose.ros-commands.yaml)
echo "Results: $results"
cleanup() {
  local status=$?
  "${compose[@]}" logs --no-color > "$results/services.log" 2>&1 || true
  "${compose[@]}" exec -T postgres psql -U drone_fleet -d drone_fleet -At -c 'SELECT json_build_object('\''commandId'\'',command_id,'\''state'\'',execution_status,'\''startedAt'\'',execution_started_at,'\''finishedAt'\'',execution_result_at) FROM commands ORDER BY created_at' > "$results/commands.jsonl" 2>/dev/null || true
  "${compose[@]}" exec -T postgres psql -U drone_fleet -d drone_fleet -At -c 'SELECT row_to_json(t) FROM ros_command_targets t' > "$results/targets.jsonl" 2>/dev/null || true
  "${compose[@]}" exec -T postgres psql -U drone_fleet -d drone_fleet -At -c 'SELECT row_to_json(e) FROM bridge_action_events e' > "$results/events.jsonl" 2>/dev/null || true
  "${compose[@]}" down --volumes --remove-orphans > "$results/cleanup.log" 2>&1 || status=1
  docker image rm "$ROS_BRIDGE_IMAGE" >> "$results/cleanup.log" 2>&1 || status=1
  echo "cleanup exit=$status project=$project" | tee -a "$results/cleanup.log"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker build --network=none -t "$ROS_BRIDGE_IMAGE" ros > "$results/ros-build.log" 2>&1
"${compose[@]}" build migrate telemetry-ingestor api simulator > "$results/build.log" 2>&1
"${compose[@]}" up -d postgres mqtt migrate telemetry-ingestor api simulator ros-reference ros-bridge
node scripts/verify-ros-commands.mjs "http://127.0.0.1:$API_PORT" "$results" "$project" | tee "$results/test.log"
