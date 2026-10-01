#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
test_id="load-e2e-$$"
project_name="drone-load-e2e-$$"
results_directory=$(mktemp -d "${TMPDIR:-/tmp}/drone-load-e2e.XXXXXX")

export LOAD_TEST_ID="$test_id"
export LOAD_SESSION_ID=ingestor-1
export LOAD_METRICS_ENABLED=true
export LOAD_METRICS_REPORT_PATH=/workspace/load-results/ingestor.json
export LOAD_RESULTS_DIR="$results_directory"

compose() {
  docker compose \
    --project-name "$project_name" \
    --file "$repository_root/compose.yaml" \
    --file "$repository_root/compose.load-test.yaml" \
    "$@"
}

cleanup() {
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$results_directory"
}
trap cleanup EXIT INT TERM

compose up --build --detach --wait postgres mqtt migrate telemetry-ingestor api

set +e
compose run --rm --no-deps load-generator-a &
generator_a_pid=$!
compose run --rm --no-deps load-generator-b &
generator_b_pid=$!
wait "$generator_a_pid"
generator_a_status=$?
wait "$generator_b_pid"
generator_b_status=$?
set -e

if [ "$generator_a_status" -ne 0 ] || [ "$generator_b_status" -ne 0 ]; then
  echo "負荷生成器が失敗しました: generator-a=$generator_a_status generator-b=$generator_b_status" >&2
  compose logs load-generator-a load-generator-b telemetry-ingestor >&2
  exit 1
fi

expected=12
attempt=0
persisted=0
while [ "$attempt" -lt 30 ]; do
  persisted=$(compose exec --no-TTY postgres psql -U drone_fleet -d drone_fleet -tAc \
    "SELECT count(*) FROM telemetry WHERE device_id BETWEEN 'load-000001' AND 'load-000004'" | tr -d '[:space:]')
  [ "$persisted" = "$expected" ] && break
  attempt=$((attempt + 1))
  sleep 1
done

if [ "$persisted" != "$expected" ]; then
  echo "DB保存件数が期限内に揃いませんでした: expected=$expected actual=$persisted" >&2
  compose logs telemetry-ingestor mqtt postgres >&2
  exit 1
fi

compose stop --timeout 15 telemetry-ingestor
compose run --rm --no-deps load-report

node -e '
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (report.testId !== process.argv[2] || report.sessions.length !== 2 || report.counters.sentSucceeded !== 12 || report.counters.dbPersisted !== 12 || report.counters.missing !== 0) {
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}
console.log(`小規模E2E成功: testId=${report.testId} sessions=${report.sessions.length} sent=${report.counters.sentSucceeded} db=${report.counters.dbPersisted}`);
' "$results_directory/report.json" "$test_id"
