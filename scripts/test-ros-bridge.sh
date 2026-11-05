#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
project="fleet-ros-bridge-$$"
export ROS_BRIDGE_TEST_IMAGE="fleet-ros-bridge-test:$$"
runner="$project-runner"
results=$(mktemp -d "${TMPDIR:-/tmp}/ros-bridge-XXXXXX")
compose=(docker compose -p "$project" -f compose.ros-bridge-test.yaml)
export ROS_BRIDGE_IMAGE="$ROS_BRIDGE_TEST_IMAGE"
demo=(docker compose -p "$project-demo" -f compose.ros-bridge.yaml)
echo "Results: $results"
git rev-parse HEAD > "$results/workspace-commit.txt"
git status --short -- ros packages/protocol > "$results/workspace-status.txt"
cleanup() {
  local status=$?
  docker cp "$runner:/workspace/environment-manifest.json" "$results/environment-manifest.json" >/dev/null 2>&1 || true
  docker cp "$runner:/workspace/log" "$results/colcon-log" >/dev/null 2>&1 || true
  "${compose[@]}" logs --no-color > "$results/services.log" 2>&1 || true
  "${demo[@]}" logs --no-color > "$results/demo-services.log" 2>&1 || true
  "${demo[@]}" down --volumes --remove-orphans > "$results/demo-cleanup.log" 2>&1 || status=1
  "${compose[@]}" down --volumes --remove-orphans > "$results/cleanup.log" 2>&1 || status=1
  if docker container inspect "$runner" >/dev/null 2>&1; then
    docker rm -f "$runner" >> "$results/cleanup.log" 2>&1 || status=1
  fi
  if docker image inspect "$ROS_BRIDGE_TEST_IMAGE" >/dev/null 2>&1; then
    docker image rm "$ROS_BRIDGE_TEST_IMAGE" >> "$results/cleanup.log" 2>&1 || status=1
  fi
  echo "cleanup exit=$status project=$project" | tee -a "$results/cleanup.log"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker build --network=none -t "$ROS_BRIDGE_TEST_IMAGE" ros 2>&1 | tee "$results/build.log"
"${compose[@]}" up -d mqtt mqtt-tls
"${compose[@]}" run --no-deps --name "$runner" runner bash -c 'cat environment-manifest.json && python3 -m flake8 src tools && colcon test --packages-select fleet_bridge --event-handlers console_direct+ --return-code-on-test-failure && colcon test-result --verbose' 2>&1 | tee "$results/test.log"
# 配布用Composeも起動し、別containerのnetwork/IPC共有を確認する。
"${demo[@]}" up --no-build -d
wait_for_bridge() {
  for attempt in $(seq 1 25); do
    if "${demo[@]}" exec -T bridge python3 -c 'import json,sys; s=json.load(open("/data/fleet/health.json")); sys.exit(not(s.get("mqtt_subscribed") and s.get("ros_available") and not s.get("ready") and not s.get("stopping")))' 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}
wait_for_bridge
"${demo[@]}" exec -T bridge cat /data/fleet/health.json > "$results/demo-health.json"
"${demo[@]}" stop bridge
"${demo[@]}" start bridge
wait_for_bridge
echo 'Production Compose start/restart: passed' | tee -a "$results/test.log"
