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
retained_message=false
published=false

cleanup() {
  status=$?

  if [[ "${retained_message}" == true ]]; then
    docker compose exec -T mqtt \
      mosquitto_pub -h localhost -p 1883 -t "${topic}" -r -n \
      >/dev/null 2>&1 || true
  fi
  rm -f "${output_file}"

  exit "${status}"
}

trap cleanup EXIT

echo "Mosquittoを起動しています。"
docker compose up -d mqtt

echo "${topic} の送受信を確認しています。"
for _ in {1..10}; do
  if docker compose exec -T mqtt \
    mosquitto_pub -h localhost -p 1883 -t "${topic}" -m "${payload}" -r \
    >/dev/null 2>&1; then
    retained_message=true
    published=true
    break
  fi
  sleep 1
done

if [[ "${published}" != true ]]; then
  echo "Mosquittoの起動を確認できませんでした。" >&2
  exit 1
fi

if ! docker compose exec -T mqtt \
  mosquitto_sub -h localhost -p 1883 -t "${topic}" -C 1 -W 10 \
  >"${output_file}"; then
  echo "MQTTメッセージを受信できませんでした。" >&2
  exit 1
fi

received="$(cat "${output_file}")"
if [[ "${received}" != "${payload}" ]]; then
  echo "受信したメッセージが一致しません: ${received}" >&2
  exit 1
fi

echo "MQTTの送受信を確認しました: ${received}"
