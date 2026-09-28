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

readonly topic="fleet/test/verify-$$"
readonly payload="mqtt-roundtrip-ok-$$"
output_file="$(mktemp)"
subscriber_pid=""
broker_ready=false
message_received=false

cleanup() {
  status=$?

  if [[ -n "${subscriber_pid}" ]] && kill -0 "${subscriber_pid}" 2>/dev/null; then
    kill "${subscriber_pid}" 2>/dev/null || true
    wait "${subscriber_pid}" 2>/dev/null || true
  fi
  rm -f "${output_file}"

  exit "${status}"
}

trap cleanup EXIT

echo "Mosquittoを起動しています。"
docker compose up -d mqtt

echo "Mosquittoの起動を待っています。"
for _ in {1..10}; do
  if docker compose exec -T mqtt \
    mosquitto_pub -h localhost -p 1883 -t "${topic}/readiness" -m ready \
    >/dev/null 2>&1; then
    broker_ready=true
    break
  fi
  sleep 1
done

if [[ "${broker_ready}" != true ]]; then
  echo "Mosquittoの起動を確認できませんでした。" >&2
  exit 1
fi

echo "${topic} の購読を開始しています。"
docker compose exec -T mqtt \
  mosquitto_sub -h localhost -p 1883 -t "${topic}" -C 1 -W 15 \
  >"${output_file}" &
subscriber_pid=$!

echo "${topic} へメッセージを送信しています。"
for _ in {1..10}; do
  docker compose exec -T mqtt \
    mosquitto_pub -h localhost -p 1883 -t "${topic}" -m "${payload}" \
    >/dev/null 2>&1 || true
  sleep 1

  if [[ -s "${output_file}" ]]; then
    message_received=true
    break
  fi
done

if ! wait "${subscriber_pid}"; then
  subscriber_pid=""
  echo "MQTTメッセージを受信できませんでした。" >&2
  exit 1
fi
subscriber_pid=""

if [[ "${message_received}" != true ]]; then
  echo "MQTTメッセージを制限時間内に受信できませんでした。" >&2
  exit 1
fi

received="$(cat "${output_file}")"
if [[ "${received}" != "${payload}" ]]; then
  echo "受信したメッセージが一致しません: ${received}" >&2
  exit 1
fi

echo "MQTTの送受信を確認しました: ${received}"
