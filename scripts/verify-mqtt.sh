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
  mosquitto_sub -h localhost -p 1883 -t "${topic}" -C 1 -W 10 \
  >"${output_file}" &
subscriber_pid=$!

# mosquitto_subがブローカーへ購読を登録するまで送信を待つ。
sleep 1

echo "${topic} へメッセージを送信しています。"
docker compose exec -T mqtt \
  mosquitto_pub -h localhost -p 1883 -t "${topic}" -m "${payload}"

if ! wait "${subscriber_pid}"; then
  subscriber_pid=""
  echo "MQTTメッセージを受信できませんでした。" >&2
  exit 1
fi
subscriber_pid=""

received="$(cat "${output_file}")"
if [[ "${received}" != "${payload}" ]]; then
  echo "受信したメッセージが一致しません: ${received}" >&2
  exit 1
fi

echo "MQTTの送受信を確認しました: ${received}"
