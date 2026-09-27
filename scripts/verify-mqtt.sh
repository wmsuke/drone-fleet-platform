#!/usr/bin/env bash

set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  echo "Dockerが見つかりません。Docker EngineとDocker Compose v2をインストールしてください。" >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose v2を実行できません。" >&2
  exit 1
fi

readonly topic="fleet/test"
readonly payload="mqtt-roundtrip-ok"
output_file="$(mktemp)"

cleanup() {
  docker compose down >/dev/null
  rm -f "${output_file}"
}

trap cleanup EXIT

echo "Mosquittoを起動しています。"
docker compose up -d --wait mqtt

echo "${topic} の送受信を確認しています。"
docker compose exec -T mqtt \
  mosquitto_sub -h localhost -p 1883 -t "${topic}" -C 1 -W 10 \
  >"${output_file}" &
subscriber_pid=$!

# mosquitto_subが購読を開始してからメッセージを送信する。
sleep 1
docker compose exec -T mqtt \
  mosquitto_pub -h localhost -p 1883 -t "${topic}" -m "${payload}"

if ! wait "${subscriber_pid}"; then
  echo "MQTTメッセージを受信できませんでした。" >&2
  exit 1
fi

received="$(cat "${output_file}")"
if [[ "${received}" != "${payload}" ]]; then
  echo "受信したメッセージが一致しません: ${received}" >&2
  exit 1
fi

echo "MQTTの送受信を確認しました: ${received}"
