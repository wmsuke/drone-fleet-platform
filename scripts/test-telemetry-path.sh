#!/usr/bin/env bash

set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  echo "Dockerが見つかりません。Docker Engineをインストールしてください。" >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose v2を実行できません。" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
  echo "テスト結果の検証にはNode.jsとcurlが必要です。" >&2
  exit 1
fi

readonly device_id="integration-telemetry-path"
readonly topic="fleet/v1/devices/${device_id}/telemetry"
readonly payload='{"schemaVersion":1,"deviceId":"integration-telemetry-path","sequence":42,"timestamp":"2026-10-01T04:00:00.000Z","payload":{"battery":73.5,"latitude":35.681236,"longitude":139.767125,"altitude":24.5,"temperature":26.25,"status":"FLYING"}}'
readonly api_port="${TELEMETRY_PATH_API_PORT:-31045}"
readonly raw_project="telemetry-path-${GITHUB_RUN_ID:-local-$$}-${GITHUB_RUN_ATTEMPT:-1}"
readonly project_name="${raw_project//_/-}"
readonly api_url="http://127.0.0.1:${api_port}/devices/${device_id}/telemetry?limit=1"
response_file="$(mktemp)"

cleanup() {
  status=$?

  if [[ "${status}" -ne 0 ]]; then
    echo "テレメトリ経路の結合テストに失敗しました。サービス状態とログを出力します。" >&2
    docker compose -p "${project_name}" ps -a >&2 || true
    docker compose -p "${project_name}" logs \
      postgres mqtt migrate telemetry-ingestor api >&2 || true
  fi

  API_PORT="${api_port}" docker compose -p "${project_name}" \
    down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -f "${response_file}"
  exit "${status}"
}

trap cleanup EXIT

matches_expected_telemetry() {
  node --input-type=module - "${response_file}" <<'NODE'
import { readFile } from "node:fs/promises";

const response = JSON.parse(await readFile(process.argv[2], "utf8"));
const expected = {
  sequence: 42,
  deviceTimestamp: "2026-10-01T04:00:00.000Z",
  battery: 73.5,
  latitude: 35.681236,
  longitude: 139.767125,
  altitude: 24.5,
  temperature: 26.25,
  flightStatus: "FLYING",
};
const telemetry = response[0];
if (
  response.length !== 1 ||
  typeof telemetry?.receivedAt !== "string" ||
  Number.isNaN(Date.parse(telemetry.receivedAt)) ||
  Object.entries(expected).some(([key, value]) => telemetry[key] !== value)
) {
  process.exit(1);
}
NODE
}

echo "テレメトリ経路の検証サービスを起動します: ${project_name}"
API_PORT="${api_port}" docker compose -p "${project_name}" up \
  --build -d --wait postgres mqtt migrate telemetry-ingestor api

echo "固定テレメトリをMQTTへ送信し、APIへの反映を最大30秒待ちます。"
for attempt in {1..30}; do
  docker compose -p "${project_name}" exec -T mqtt \
    mosquitto_pub -h localhost -p 1883 -q 1 -t "${topic}" -m "${payload}"

  if curl --fail --silent --show-error "${api_url}" >"${response_file}" 2>/dev/null &&
    matches_expected_telemetry; then
    echo "MQTTからAPIまで固定テレメトリが一致しました（試行 ${attempt}/30）。"
    exit 0
  fi
  sleep 1
done

echo "固定テレメトリを30秒以内にAPIから取得できませんでした。" >&2
exit 1
