#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export ROS_DEMO_PROJECT="fleet-ros-demo-test-$(node -p 'require("node:crypto").randomUUID()')"
export ROS_DEMO_IMAGE="$ROS_DEMO_PROJECT:local"
export API_PORT="${ROS_DEMO_API_PORT:-31196}" DASHBOARD_PORT="${ROS_DEMO_DASHBOARD_PORT:-5176}"
export POSTGRES_DB=drone_fleet POSTGRES_USER=drone_fleet POSTGRES_PASSWORD=ros-demo-test-only
results=$(mktemp -d "${TMPDIR:-/tmp}/ros-demo-XXXXXX")
compose=(docker compose --env-file /dev/null -p "$ROS_DEMO_PROJECT" -f compose.yaml -f compose.ros-demo.yaml)
echo "Results: $results"
cleanup() {
  local status=$? cleanup_status=0 remaining="" image
  trap - EXIT
  "${compose[@]}" logs --no-color > "$results/services.log" 2>&1 || true
  "${compose[@]}" down --volumes --remove-orphans > "$results/cleanup.log" 2>&1 || cleanup_status=1
  for image in "$ROS_DEMO_IMAGE" "$ROS_DEMO_PROJECT-migrate:latest" "$ROS_DEMO_PROJECT-telemetry-ingestor:latest" "$ROS_DEMO_PROJECT-api:latest" "$ROS_DEMO_PROJECT-dashboard:latest"; do
    if docker image inspect "$image" >/dev/null 2>&1; then docker image rm "$image" >> "$results/cleanup.log" 2>&1 || cleanup_status=1; fi
  done
  for kind in containers volumes networks images; do
    case "$kind" in
      containers) remaining=$(docker ps -aq --filter "label=com.docker.compose.project=$ROS_DEMO_PROJECT") || cleanup_status=1 ;;
      volumes) remaining=$(docker volume ls -q --filter "label=com.docker.compose.project=$ROS_DEMO_PROJECT") || cleanup_status=1 ;;
      networks) remaining=$(docker network ls -q --filter "label=com.docker.compose.project=$ROS_DEMO_PROJECT") || cleanup_status=1 ;;
      images) remaining=$(docker image ls --filter "reference=$ROS_DEMO_PROJECT*" --format '{{.Repository}}:{{.Tag}}') || cleanup_status=1 ;;
    esac
    printf '%s\n' "$remaining" > "$results/remaining-$kind.txt"
    if [ -n "$remaining" ]; then cleanup_status=1; fi
  done
  node -e 'const fs=require("fs"),p=process.argv[1],v={exitCode:Number(process.argv[2])};for(const k of ["containers","volumes","networks","images"])v[k]=fs.readFileSync(p+"/remaining-"+k+".txt","utf8").split(/\s+/).filter(Boolean);fs.writeFileSync(p+"/cleanup.json",JSON.stringify(v,null,2));' "$results" "$cleanup_status" || cleanup_status=1
  if [ "$cleanup_status" -ne 0 ]; then status=1; fi
  echo "cleanup exit=$cleanup_status process exit=$status" | tee -a "$results/cleanup.log"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
git rev-parse HEAD > "$results/commit.txt"
node -v > "$results/node.txt"
docker info --format '{{.OSType}} {{.Architecture}} {{.ServerVersion}}' > "$results/docker.txt"
"${compose[@]}" build ros-demo-reference migrate telemetry-ingestor api dashboard > "$results/build.log" 2>&1
"${compose[@]}" up -d --wait postgres mqtt migrate telemetry-ingestor api dashboard ros-demo-reference ros-demo-success ros-demo-cancel ros-demo-recovery
"${compose[@]}" exec -T ros-demo-reference cat /workspace/environment-manifest.json > "$results/environment-manifest.json"
curl --fail --silent --max-time 10 "http://127.0.0.1:$DASHBOARD_PORT/devices/ros-demo-success/ros" > "$results/dashboard.html"
for mode in success cancel recovery; do
  args=("$mode")
  if [ "$mode" = recovery ]; then args+=(--restart-reference); fi
  node docs/examples/ros-demo.mjs "${args[@]}" > "$results/$mode.json" 2> "$results/$mode.log"
  echo "ROS demo passed: $mode"
done
