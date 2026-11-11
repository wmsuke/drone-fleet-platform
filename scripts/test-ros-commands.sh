#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
project="ros-commands-$$"
if [ "${ROS_E2E:-false}" = true ]; then project="ros-e2e-$(node -p 'require("node:crypto").randomUUID()')"; fi
export ROS_BRIDGE_IMAGE="fleet-ros-commands:$$"
export API_PORT="${ROS_COMMANDS_API_PORT:-31194}"
export DRONE_COUNT=1 TELEMETRY_INTERVAL_MS=1000
export POSTGRES_DB=drone_fleet POSTGRES_USER=drone_fleet POSTGRES_PASSWORD=ros-e2e-test-only
results=$(mktemp -d "${TMPDIR:-/tmp}/ros-commands-XXXXXX")
compose=(docker compose --env-file /dev/null -p "$project" -f compose.yaml -f compose.ros-commands.yaml)
echo "Results: $results"
cleanup() {
  local status=$?
  local cleanup_status=0 remaining="" image
  trap - EXIT
  "${compose[@]}" logs --no-color > "$results/services.log" 2>&1 || true
  "${compose[@]}" exec -T postgres psql -U drone_fleet -d drone_fleet -At -c 'SELECT json_build_object('\''commandId'\'',command_id,'\''state'\'',execution_status,'\''startedAt'\'',execution_started_at,'\''finishedAt'\'',execution_result_at) FROM commands ORDER BY created_at' > "$results/commands.jsonl" 2>/dev/null || true
  "${compose[@]}" exec -T postgres psql -U drone_fleet -d drone_fleet -At -c 'SELECT row_to_json(t) FROM ros_command_targets t' > "$results/targets.jsonl" 2>/dev/null || true
  "${compose[@]}" exec -T postgres psql -U drone_fleet -d drone_fleet -At -c 'SELECT row_to_json(e) FROM bridge_action_events e' > "$results/events.jsonl" 2>/dev/null || true
  "${compose[@]}" exec -T postgres psql -U drone_fleet -d drone_fleet -At -c 'SELECT row_to_json(c) FROM ros_command_cancels c' > "$results/cancellations.jsonl" 2>/dev/null || true
  "${compose[@]}" exec -T postgres psql -U drone_fleet -d drone_fleet -At -c 'SELECT row_to_json(e) FROM bridge_cancel_events e' > "$results/cancel-events.jsonl" 2>/dev/null || true
  "${compose[@]}" exec -T postgres psql -U drone_fleet -d drone_fleet -At -c 'SELECT row_to_json(e) FROM bridge_health_events e' > "$results/health-events.jsonl" 2>/dev/null || true
  "${compose[@]}" exec -T postgres psql -U drone_fleet -d drone_fleet -At -c 'SELECT row_to_json(e) FROM bridge_command_configurations e' > "$results/configuration-bindings.jsonl" 2>/dev/null || true
  "${compose[@]}" exec -T postgres psql -U drone_fleet -d drone_fleet -At -c 'SELECT row_to_json(e) FROM audit_logs e' > "$results/audit.jsonl" 2>/dev/null || true
  "${compose[@]}" down --volumes --remove-orphans > "$results/cleanup.log" 2>&1 || cleanup_status=1
  for image in "$ROS_BRIDGE_IMAGE" "$project-migrate:latest" "$project-telemetry-ingestor:latest" "$project-api:latest" "$project-simulator:latest"; do
    if docker image inspect "$image" >/dev/null 2>&1; then docker image rm "$image" >> "$results/cleanup.log" 2>&1 || cleanup_status=1; fi
  done
  for kind in containers volumes networks; do
    case "$kind" in
      containers) remaining=$(docker ps -aq --filter "label=com.docker.compose.project=$project") || cleanup_status=1 ;;
      volumes) remaining=$(docker volume ls -q --filter "label=com.docker.compose.project=$project") || cleanup_status=1 ;;
      networks) remaining=$(docker network ls -q --filter "label=com.docker.compose.project=$project") || cleanup_status=1 ;;
    esac
    printf '%s\n' "$remaining" > "$results/remaining-$kind.txt"
    if [ -n "$remaining" ]; then echo "E2E専用${kind}が残存: $remaining" >> "$results/cleanup.log"; cleanup_status=1; fi
  done
  docker image ls --filter "reference=$project-*" --format '{{.Repository}}:{{.Tag}}' > "$results/image-inventory.txt" 2>> "$results/cleanup.log" || cleanup_status=1
  docker image ls --filter "reference=$ROS_BRIDGE_IMAGE" --format '{{.Repository}}:{{.Tag}}' >> "$results/image-inventory.txt" 2>> "$results/cleanup.log" || cleanup_status=1
  node -e 'const fs=require("fs"),p=process.argv[1],names=new Set(process.argv.slice(2)),images=fs.readFileSync(p+"/image-inventory.txt","utf8").split(/\s+/).filter(v=>names.has(v));fs.writeFileSync(p+"/remaining-images.txt",images.join("\n"));process.exitCode=images.length?1:0;' "$results" "$ROS_BRIDGE_IMAGE" "$project-migrate:latest" "$project-telemetry-ingestor:latest" "$project-api:latest" "$project-simulator:latest" || cleanup_status=1
  node -e 'const fs=require("fs"),p=process.argv[1],v={exitCode:Number(process.argv[2])};for(const k of ["containers","volumes","networks","images"])v[k]=fs.readFileSync(p+"/remaining-"+k+".txt","utf8").split(/\s+/).filter(Boolean);fs.writeFileSync(p+"/cleanup.json",JSON.stringify(v,null,2));' "$results" "$cleanup_status" || cleanup_status=1
  if [ "$cleanup_status" -ne 0 ]; then status=1; fi
  if [ "${ROS_E2E:-false}" = true ]; then node scripts/ros-e2e-report.mjs "$results" "$status" || status=1; fi
  echo "cleanup exit=$cleanup_status process exit=$status project=$project" | tee -a "$results/cleanup.log"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [ "${ROS_E2E:-false}" = true ] && [ -n "${ROS_COMMANDS_CASES:-}" ]; then echo 'test:ros-e2eでは部分case指定を使わない' >&2; exit 2; fi
node scripts/ros-e2e-metadata.mjs "$results"
docker build --network=none -t "$ROS_BRIDGE_IMAGE" ros > "$results/ros-build.log" 2>&1
"${compose[@]}" build migrate telemetry-ingestor api simulator > "$results/build.log" 2>&1
"${compose[@]}" up -d postgres mqtt migrate telemetry-ingestor api simulator ros-reference ros-bridge
"${compose[@]}" exec -T ros-reference cat /workspace/environment-manifest.json > "$results/environment-manifest.json"
if [ "${ROS_E2E_FAIL_AT:-}" = after-start ]; then echo 'cleanup検証用の意図した失敗' >&2; exit 1; fi
node scripts/verify-ros-commands.mjs "http://127.0.0.1:$API_PORT" "$results" "$project" | tee "$results/test.log"
