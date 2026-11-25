#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
results=$(mktemp -d "${TMPDIR:-/tmp}/flight-sim.XXXXXXXX")
run_id=${results##*/}
image="fleet-$(printf "%s" "$run_id" | tr A-Z a-z):smoke"
container=""
echo "Results: $results"

cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n "$container" ]]; then
    docker rm -f "$container" >/dev/null || status=1
  fi
  if docker image inspect "$image" >/dev/null 2>&1; then
    docker image rm "$image" >/dev/null || status=1
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker build -f flight-sim/Dockerfile -t "$image" . > "$results/build.log" 2>&1 || {
  tail -n 40 "$results/build.log" >&2
  exit 1
}
docker image inspect --format '{{.Id}} {{.Os}}/{{.Architecture}}' "$image" > "$results/image.txt"
for scenario in ascent-hover missing-odometry; do
  args=()
  if [[ "$scenario" == missing-odometry ]]; then
    args+=(--expect-ready-timeout)
  fi
  container="$run_id-$scenario"
  mkdir "$results/$scenario"
  status=0
  docker run --name "$container" --network none --init --cap-drop ALL \
    --security-opt no-new-privileges "$image" "${args[@]}" \
    > "$results/$scenario/run.log" 2>&1 || status=$?
  docker cp "$container:/tmp/flight-results/." "$results/$scenario/" || status=1
  docker cp "$container:/opt/flight/packages.tsv" "$results/packages.tsv" || status=1
  docker rm "$container" >/dev/null
  if [[ -n "$(docker ps -aq --filter "name=^/$container\$")" ]]; then
    exit 1
  fi
  container=""
  if [[ "$status" != 0 ]]; then
    cat "$results/$scenario/run.log" >&2
    exit "$status"
  fi
done
