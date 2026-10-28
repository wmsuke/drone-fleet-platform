#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
project="ota-evidence-$$"
cleanup() {
  docker compose -p "$project" -f compose.ota-test.yaml down --volumes --remove-orphans
}
trap cleanup EXIT
docker compose -p "$project" -f compose.ota-test.yaml build runner
docker compose -p "$project" -f compose.ota-test.yaml run --rm runner
