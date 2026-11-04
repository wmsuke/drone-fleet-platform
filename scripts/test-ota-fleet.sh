#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
project="ota-fleet-$$"
results=$(mktemp -d "${TMPDIR:-/tmp}/ota-fleet-XXXXXXXX")
echo "OTA E2E results: $results"
cleanup() {
  status=$?
  trap - EXIT
  docker compose -p "$project" -f compose.ota-test.yaml logs --no-color > "$results/services.log" 2>&1 || true
  if docker compose -p "$project" -f compose.ota-test.yaml down --volumes --remove-orphans --rmi local >> "$results/cleanup.log" 2>&1; then
    echo "cleanup=SUCCEEDED test_exit=$status project=$project" | tee -a "$results/cleanup.log"
  else
    echo "cleanup=FAILED test_exit=$status project=$project" | tee -a "$results/cleanup.log"
    status=1
  fi
  remaining=$(docker ps -aq --filter "label=com.docker.compose.project=$project")
  networks=$(docker network ls -q --filter "label=com.docker.compose.project=$project")
  volumes=$(docker volume ls -q --filter "label=com.docker.compose.project=$project")
  if [[ -n "$remaining$networks$volumes" ]]; then
    echo "cleanup=FAILED remaining_containers=$remaining networks=$networks volumes=$volumes" | tee -a "$results/cleanup.log"
    status=1
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker compose -p "$project" -f compose.ota-test.yaml build runner 2>&1 | tee "$results/build.log"
docker compose -p "$project" -f compose.ota-test.yaml run --rm -e OTA_FLEET_INTEGRATION=true runner pnpm exec vitest run apps/api/test/ota-fleet.e2e.test.ts --hookTimeout 30000 "$@" 2>&1 | tee "$results/test.log"
