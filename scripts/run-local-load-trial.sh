#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
device_count=${LOAD_DEVICE_COUNT:-1000}
telemetry_interval_ms=${LOAD_TELEMETRY_INTERVAL_MS:-5000}
measurement_ms=${LOAD_MEASUREMENT_MS:-30000}
warmup_seconds=${LOAD_WARMUP_SECONDS:-10}
startup_seconds=${LOAD_GENERATOR_STARTUP_SECONDS:-30}
cooldown_seconds=${LOAD_COOLDOWN_SECONDS:-60}
devices_per_shard=${LOAD_DEVICES_PER_SHARD:-500}
trial=${LOAD_TRIAL:-1}
test_id=${LOAD_TEST_ID:-local-${device_count}-${telemetry_interval_ms}-trial-${trial}}
project_name="drone-load-${test_id}-$$"
results_directory=${LOAD_RESULTS_DIR:-$repository_root/load-results/$test_id}
api_port=${LOAD_API_PORT:-$((30000 + ($$ % 10000)))}

case "$test_id" in
  *[!A-Za-z0-9_-]* | "") echo "LOAD_TEST_IDの形式が不正です" >&2; exit 1 ;;
esac
for value in "$device_count" "$telemetry_interval_ms" "$measurement_ms" "$warmup_seconds" "$startup_seconds" "$cooldown_seconds" "$devices_per_shard" "$trial"; do
  case "$value" in *[!0-9]* | "" | 0) echo "負荷試験の数値設定は正の整数で指定してください" >&2; exit 1 ;; esac
done

mkdir -p "$results_directory"
export LOAD_TEST_ID="$test_id"
export LOAD_SESSION_ID=ingestor-1
export LOAD_METRICS_ENABLED=true
export LOAD_METRICS_REPORT_PATH=/workspace/load-results/ingestor.json
export LOAD_RESULTS_DIR="$results_directory"
export API_PORT="$api_port"

compose() {
  docker compose \
    --project-name "$project_name" \
    --file "$repository_root/compose.yaml" \
    --file "$repository_root/compose.load-test.yaml" \
    "$@"
}

background_pids=""
cleanup() {
  for process_id in $background_pids; do kill "$process_id" >/dev/null 2>&1 || true; done
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

compose build load-generator load-report
compose up --build --detach --wait postgres mqtt migrate api

measurement_start_at=$(node -e 'console.log(new Date(Date.now()+Number(process.argv[1])*1000).toISOString())' "$((startup_seconds + warmup_seconds))")
measurement_end_at=$(node -e 'console.log(new Date(new Date(process.argv[1]).getTime()+Number(process.argv[2])).toISOString())' "$measurement_start_at" "$measurement_ms")
export LOAD_MEASUREMENT_START_AT="$measurement_start_at"
export LOAD_MEASUREMENT_END_AT="$measurement_end_at"
export LOAD_MEASUREMENT_DURATION_MS="$measurement_ms"

cat >"$results_directory/trial.json" <<EOF
{"schemaVersion":1,"testId":"$test_id","deviceCount":$device_count,"telemetryIntervalMs":$telemetry_interval_ms,"startupSeconds":$startup_seconds,"warmupSeconds":$warmup_seconds,"measurementMs":$measurement_ms,"measurementStartAt":"$measurement_start_at","measurementEndAt":"$measurement_end_at","cooldownSeconds":$cooldown_seconds,"devicesPerShard":$devices_per_shard,"trial":$trial,"startedAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
EOF

compose up --build --detach --wait telemetry-ingestor

api_duration_ms=$measurement_ms
compose run --rm --no-deps \
  -e LOAD_API_URL=http://api:3000/devices \
  -e LOAD_API_DURATION_MS="$api_duration_ms" \
  -e LOAD_API_INTERVAL_MS=1000 \
  -e LOAD_API_TIMEOUT_MS=2000 \
  -e LOAD_API_START_AT="$measurement_start_at" \
  -e LOAD_API_REPORT_PATH=/workspace/load-results/api.json \
  load-report node apps/load-report/dist/api-probe.js &
api_probe_pid=$!
background_pids="$background_pids $api_probe_pid"

container_ids=$(compose ps --quiet postgres mqtt telemetry-ingestor api | tr '\n' ' ')
(
  node -e 'const delay=new Date(process.argv[1]).getTime()-Date.now(); if(delay>0)setTimeout(()=>{},delay)' "$measurement_start_at"
  while :; do
    docker stats --no-stream --format '{{json .}}' $container_ids >>"$results_directory/container-stats.ndjson" || exit 0
    sleep 1
  done
) &
stats_pid=$!
background_pids="$background_pids $stats_pid"

remaining=$device_count
device_start=1
shard=1
generator_pids=""
generator_paths=""
messages_per_device=$((measurement_ms / telemetry_interval_ms + 2))
while [ "$remaining" -gt 0 ]; do
  shard_devices=$devices_per_shard
  [ "$remaining" -lt "$shard_devices" ] && shard_devices=$remaining
  session_id="generator-$shard"
  report_path="/workspace/load-results/$session_id.json"
  ready_path="/workspace/load-results/ready-$shard"
  max_messages=$((shard_devices * messages_per_device))
  compose run --rm --no-deps \
    -e LOAD_SESSION_ID="$session_id" \
    -e LOAD_DEVICE_START="$device_start" \
    -e LOAD_DEVICE_COUNT="$shard_devices" \
    -e LOAD_CONNECTION_RATE_PER_SECOND=500 \
    -e LOAD_TELEMETRY_INTERVAL_MS="$telemetry_interval_ms" \
    -e LOAD_SIMULATION_SEED="$test_id-$session_id" \
    -e LOAD_MAX_MESSAGES="$max_messages" \
    -e LOAD_MAX_DURATION_MS="$measurement_ms" \
    -e LOAD_MEASUREMENT_START_AT="$measurement_start_at" \
    -e LOAD_MEASUREMENT_DURATION_MS="$measurement_ms" \
    -e LOAD_REPORT_PATH="$report_path" \
    -e LOAD_READY_PATH="$ready_path" \
    load-generator &
  generator_pid=$!
  generator_pids="$generator_pids $generator_pid"
  background_pids="$background_pids $generator_pid"
  if [ -z "$generator_paths" ]; then generator_paths="$report_path"; else generator_paths="$generator_paths,$report_path"; fi
  device_start=$((device_start + shard_devices))
  remaining=$((remaining - shard_devices))
  shard=$((shard + 1))
done

warmup_cutoff_ms=$(node -e 'console.log(new Date(process.argv[1]).getTime()-Number(process.argv[2])*1000)' "$measurement_start_at" "$warmup_seconds")
expected_shards=$((shard - 1))
ready_shards=0
while [ "$ready_shards" -lt "$expected_shards" ]; do
  ready_shards=$(find "$results_directory" -maxdepth 1 -type f -name 'ready-*' | wc -l | tr -d '[:space:]')
  now_ms=$(node -e 'console.log(Date.now())')
  if [ "$now_ms" -ge "$warmup_cutoff_ms" ]; then
    echo "全generatorのMQTT接続完了をwarmup前に確認できませんでした（期待: ${expected_shards}、ready: ${ready_shards}）" >&2
    exit 1
  fi
  [ "$ready_shards" -ge "$expected_shards" ] || sleep 1
done
echo "全${device_count}台のMQTT接続完了を確認しました。共通計測開始までwarmupを継続します"

generator_failed=0
for process_id in $generator_pids; do
  wait "$process_id" || generator_failed=1
done
wait "$api_probe_pid" || true
kill "$stats_pid" >/dev/null 2>&1 || true
wait "$stats_pid" 2>/dev/null || true
background_pids=""

if [ "$generator_failed" -ne 0 ]; then
  echo "負荷生成器の起動または送信に失敗しました。generator側の限界として記録します" >&2
  compose logs telemetry-ingestor mqtt >&2
  exit 1
fi

sent_succeeded=$(node -e '
const fs=require("node:fs");
let total=0;
for (const path of process.argv.slice(1)) total += JSON.parse(fs.readFileSync(path,"utf8")).counters.succeeded;
process.stdout.write(String(total));
' $(printf '%s' "$generator_paths" | tr ',' ' ' | sed "s#/workspace/load-results#$results_directory#g"))

attempt=0
persisted=0
previous_persisted=-1
previous_total_persisted=-1
stagnant_seconds=0
while [ "$attempt" -lt "$cooldown_seconds" ]; do
  persistence_counts=$(compose exec --no-TTY postgres psql -U drone_fleet -d drone_fleet -tAc \
    "SELECT count(*) FILTER (WHERE device_timestamp >= '$measurement_start_at'::timestamptz AND device_timestamp < '$measurement_end_at'::timestamptz) || ',' || count(*) FROM telemetry WHERE device_id LIKE 'load-%'" | tr -d '[:space:]')
  persisted=${persistence_counts%%,*}
  total_persisted=${persistence_counts#*,}
  [ "$persisted" = "$sent_succeeded" ] && break
  if [ "$persisted" = "$previous_persisted" ] && [ "$total_persisted" = "$previous_total_persisted" ]; then
    stagnant_seconds=$((stagnant_seconds + 1))
  else
    stagnant_seconds=0
    previous_persisted=$persisted
    previous_total_persisted=$total_persisted
  fi
  if [ "$stagnant_seconds" -ge 15 ]; then
    echo "DB保存件数が15秒間変化しなかったため待機を終了します（送信成功: ${sent_succeeded}、保存: ${persisted}）" >&2
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done

compose stop --timeout 30 telemetry-ingestor
LOAD_GENERATOR_REPORT_PATHS="$generator_paths" compose run --rm --no-deps load-report || true

compose exec --no-TTY postgres psql -U drone_fleet -d drone_fleet -tAc \
  "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT d.device_id, d.connection_status, lt.battery, lt.flight_status, d.last_received_at FROM devices d LEFT JOIN (SELECT DISTINCT ON (device_id) device_id, battery, flight_status FROM telemetry ORDER BY device_id, received_at DESC, id DESC) lt ON d.device_id = lt.device_id ORDER BY d.device_id" \
  >"$results_directory/postgres-explain.json"

node "$repository_root/scripts/summarize-local-load-trial.mjs" "$results_directory"
echo "負荷試験結果: $results_directory/summary.json"
