#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
name="fleet-ros-test-$$"
image="drone-fleet-ros-test:$$"
results=$(mktemp -d "${TMPDIR:-/tmp}/ros-reference-XXXXXX")
echo "Results: $results"
git rev-parse HEAD > "$results/workspace-commit.txt"
git status --short -- ros > "$results/workspace-status.txt"
cleanup() {
  local status=$?
  docker cp "$name:/workspace/environment-manifest.json" "$results/environment-manifest.json" >/dev/null 2>&1 || true
  docker cp "$name:/workspace/log" "$results/colcon-log" >/dev/null 2>&1 || true
  if docker container inspect "$name" >/dev/null 2>&1; then
    docker rm -f "$name" >/dev/null || status=1
  fi
  if docker image inspect "$image" >/dev/null 2>&1; then
    docker image rm "$image" >/dev/null || status=1
  fi
  echo "cleanup exit=$status container=$name image=$image" | tee "$results/cleanup.log"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker build --network=none -t "$image" ros 2>&1 | tee "$results/build.log"
docker run --name "$name" --init --network=none --cap-drop=ALL --security-opt=no-new-privileges "$image" bash -c 'cat environment-manifest.json && python3 -m flake8 src tools && colcon test --packages-select fleet_reference --event-handlers console_direct+ --return-code-on-test-failure && colcon test-result --verbose' 2>&1 | tee "$results/test.log"
