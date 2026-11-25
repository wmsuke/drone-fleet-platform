#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

project="flight-observations-$$"
export FLIGHT_SIM_IMAGE="$project:sim"
export ROS_BRIDGE_IMAGE="$project:bridge"
export API_PORT="${FLIGHT_OBSERVATIONS_API_PORT:-31222}"
results=$(mktemp -d "${TMPDIR:-/tmp}/flight-observations.XXXXXXXX")
compose=(docker compose -p "$project" -f compose.yaml -f compose.flight-observations.yaml)
echo "Results: $results"

cleanup() {
  local status=$?
  trap - EXIT
  "${compose[@]}" logs --no-color > "$results/services.log" 2>&1 || true
  "${compose[@]}" down --volumes --remove-orphans --rmi local > "$results/cleanup.log" 2>&1 ||
    status=1
  for image in "$FLIGHT_SIM_IMAGE" "$ROS_BRIDGE_IMAGE"; do
    if docker image inspect "$image" >/dev/null 2>&1; then
      docker image rm "$image" >> "$results/cleanup.log" 2>&1 || status=1
    fi
  done
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker build -f flight-sim/Dockerfile -t "$FLIGHT_SIM_IMAGE" . > "$results/sim-build.log" 2>&1
docker build --network none -t "$ROS_BRIDGE_IMAGE" ros > "$results/bridge-build.log" 2>&1
"${compose[@]}" up -d --wait --wait-timeout 120 postgres mqtt migrate telemetry-ingestor api \
  flight-sim flight-bridge
for attempt in 1 2; do
  "${compose[@]}" exec -T flight-sim bash -c \
    'source /opt/ros/jazzy/setup.bash && exec python3 /opt/flight/smoke.py --fleet-device gazebo-x3' \
    > "$results/flight-$attempt.log"
  "${compose[@]}" exec -T flight-sim mv /tmp/flight-results "/tmp/flight-results-$attempt"
done
node scripts/verify-flight-observations.mjs "$API_PORT" | tee "$results/observations.json"
