#!/usr/bin/env bash

set -euo pipefail

readonly aws_profile="${AWS_PROFILE:-drone-fleet}"
readonly aws_region="${AWS_REGION:-ap-southeast-2}"
readonly endpoint="${AWS_IOT_ENDPOINT:?AWS_IOT_ENDPOINT is required}"
readonly credentials_dir="${AWS_IOT_DEVICE_CREDENTIALS_DIR:-secrets/aws-iot}"
readonly api_port="${AWS_IOT_E2E_API_PORT:-31098}"
readonly postgres_port="${AWS_IOT_E2E_POSTGRES_PORT:-55434}"
readonly container_name="drone-fleet-aws-e2e-${$}"
readonly database_password="aws-e2e-local-only"
readonly device_one="dev-drone-001"
readonly device_two="dev-drone-002"
readonly log_dir="$(mktemp -d)"

ingestor_pid=""
simulator_pid=""
api_pid=""
inactive_certificate_id=""
certificate_inactivated=false

stop_process() {
  local pid="$1"
  if [[ -n "${pid}" ]] && kill -0 "${pid}" >/dev/null 2>&1; then
    kill -INT "${pid}" >/dev/null 2>&1 || true
    wait "${pid}" >/dev/null 2>&1 || true
  fi
}

cleanup() {
  local result=$?
  stop_process "${simulator_pid}"
  stop_process "${api_pid}"
  stop_process "${ingestor_pid}"
  docker stop "${container_name}" >/dev/null 2>&1 || true
  if [[ "${result}" -ne 0 && "${certificate_inactivated}" == true ]]; then
    echo "E2EがINACTIVEにした証明書をACTIVEへ戻します" >&2
    aws iot update-certificate --profile "${aws_profile}" --region "${aws_region}" \
      --certificate-id "${inactive_certificate_id}" --new-status ACTIVE || true
  fi
  if [[ "${result}" -ne 0 ]]; then
    echo "AWS IoT E2Eに失敗しました。秘密情報を含まないサービスログを確認してください: ${log_dir}" >&2
  else
    rm -rf "${log_dir}"
  fi
  exit "${result}"
}
trap cleanup EXIT

for command in aws curl docker node corepack; do
  command -v "${command}" >/dev/null 2>&1 || {
    echo "${command}が見つかりません" >&2
    exit 1
  }
done

[[ "${aws_region}" == "ap-southeast-2" ]] || {
  echo "AWS_REGIONはselected Regionのap-southeast-2である必要があります" >&2
  exit 1
}
git check-ignore --quiet --no-index "${credentials_dir}"

echo "AWS無料プランと検証前のリソース件数を確認します"
aws freetier get-account-plan-state --profile "${aws_profile}" --region us-east-1 \
  --query '{plan:accountPlanType,status:accountPlanStatus}' --output json
aws freetier get-free-tier-usage --profile "${aws_profile}" --region us-east-1 \
  --query 'length(freeTierUsages)' --output text
aws iot list-things --profile "${aws_profile}" --region "${aws_region}" \
  --query 'length(things)' --output text
aws iot list-certificates --profile "${aws_profile}" --region "${aws_region}" \
  --query 'length(certificates)' --output text

echo "ローカルMosquitto経路の回帰を確認します"
corepack pnpm test:telemetry-path
corepack pnpm build >/dev/null

docker run --rm -d --name "${container_name}" \
  -p "127.0.0.1:${postgres_port}:5432" \
  -e POSTGRES_DB=drone_fleet \
  -e POSTGRES_USER=drone_fleet \
  -e POSTGRES_PASSWORD="${database_password}" \
  postgres:17-alpine >/dev/null

for _ in {1..30}; do
  docker exec "${container_name}" pg_isready -U drone_fleet -d drone_fleet \
    >/dev/null 2>&1 && break
  sleep 1
done
docker exec "${container_name}" pg_isready -U drone_fleet -d drone_fleet >/dev/null

POSTGRES_HOST=127.0.0.1 POSTGRES_PORT="${postgres_port}" \
POSTGRES_DB=drone_fleet POSTGRES_USER=drone_fleet \
POSTGRES_PASSWORD="${database_password}" \
  node packages/database/dist/migrate.js >/dev/null

MQTT_TRANSPORT=aws-iot AWS_IOT_ENDPOINT="${endpoint}" \
AWS_IOT_ROOT_CA_PATH="${credentials_dir}/AmazonRootCA1.pem" \
AWS_IOT_TELEMETRY_INGESTOR_CLIENT_ID=drone-fleet-dev-telemetry-ingestor \
AWS_IOT_TELEMETRY_INGESTOR_CERTIFICATE_PATH="${credentials_dir}/telemetry-ingestor/device.pem.crt" \
AWS_IOT_TELEMETRY_INGESTOR_PRIVATE_KEY_PATH="${credentials_dir}/telemetry-ingestor/private.pem.key" \
POSTGRES_HOST=127.0.0.1 POSTGRES_PORT="${postgres_port}" \
POSTGRES_DB=drone_fleet POSTGRES_USER=drone_fleet \
POSTGRES_PASSWORD="${database_password}" OFFLINE_TIMEOUT_MS=120000 \
  node apps/telemetry-ingestor/dist/index.js >"${log_dir}/ingestor.log" 2>&1 &
ingestor_pid=$!

MQTT_TRANSPORT=aws-iot AWS_IOT_ENDPOINT="${endpoint}" \
AWS_IOT_ROOT_CA_PATH="${credentials_dir}/AmazonRootCA1.pem" \
AWS_IOT_DEVICE_CREDENTIALS_DIR="${credentials_dir}" DEVICE_ID_PREFIX=dev-drone \
DRONE_COUNT=2 SIMULATION_SEED=aws-e2e TELEMETRY_INTERVAL_MS=5000 \
  node apps/simulator/dist/index.js >"${log_dir}/simulator.log" 2>&1 &
simulator_pid=$!

MQTT_TRANSPORT=aws-iot AWS_IOT_ENDPOINT="${endpoint}" \
AWS_IOT_ROOT_CA_PATH="${credentials_dir}/AmazonRootCA1.pem" \
AWS_IOT_API_CLIENT_ID=drone-fleet-dev-api \
AWS_IOT_API_CERTIFICATE_PATH="${credentials_dir}/api/device.pem.crt" \
AWS_IOT_API_PRIVATE_KEY_PATH="${credentials_dir}/api/private.pem.key" \
POSTGRES_HOST=127.0.0.1 POSTGRES_PORT="${postgres_port}" \
POSTGRES_DB=drone_fleet POSTGRES_USER=drone_fleet \
POSTGRES_PASSWORD="${database_password}" API_HOST=127.0.0.1 API_PORT="${api_port}" \
  node apps/api/dist/index.js >"${log_dir}/api.log" 2>&1 &
api_pid=$!

echo "2台のtelemetryとONLINEを最大60秒待ちます"
for _ in {1..60}; do
  if curl --fail --silent "http://127.0.0.1:${api_port}/devices" | \
    node --input-type=module -e '
      const chunks=[];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const devices=JSON.parse(Buffer.concat(chunks).toString());
      const targets=devices.filter(({deviceId}) => ["dev-drone-001","dev-drone-002"].includes(deviceId));
      if (targets.length !== 2 || targets.some(({connectionStatus}) => connectionStatus !== "ONLINE")) process.exit(1);
    ' 2>/dev/null; then
    devices_ready=true
    for device_id in "${device_one}" "${device_two}"; do
      if ! curl --fail --silent "http://127.0.0.1:${api_port}/devices/${device_id}" | \
        node --input-type=module -e '
          const expected=process.argv[1]; const chunks=[];
          for await (const chunk of process.stdin) chunks.push(chunk);
          const device=JSON.parse(Buffer.concat(chunks).toString());
          if (device.deviceId !== expected || device.connectionStatus !== "ONLINE" || device.latestTelemetry === null) process.exit(1);
        ' "${device_id}" 2>/dev/null; then
        devices_ready=false
        break
      fi
    done
    if [[ "${devices_ready}" == true ]]; then
      break
    fi
  fi
  sleep 1
done
curl --fail --silent "http://127.0.0.1:${api_port}/devices" | \
  node --input-type=module -e '
    const chunks=[];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const devices=JSON.parse(Buffer.concat(chunks).toString());
    const targets=devices.filter(({deviceId}) => ["dev-drone-001","dev-drone-002"].includes(deviceId));
    if (targets.length !== 2 || targets.some(({connectionStatus}) => connectionStatus !== "ONLINE")) process.exit(1);
  '

for device_id in "${device_one}" "${device_two}"; do
  curl --fail --silent "http://127.0.0.1:${api_port}/devices/${device_id}" | \
    node --input-type=module -e '
      const expected=process.argv[1]; const chunks=[];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const device=JSON.parse(Buffer.concat(chunks).toString());
      if (device.deviceId !== expected || device.connectionStatus !== "ONLINE" || device.latestTelemetry === null) process.exit(1);
    ' "${device_id}"
done
echo "2台のtelemetry保存とONLINEを確認しました"

for device_id in "${device_one}" "${device_two}"; do
  command_file="${log_dir}/${device_id}-command.json"
  curl --fail --silent --show-error -X POST -H 'content-type: application/json' \
    -d '{"type":"RETURN_HOME"}' \
    "http://127.0.0.1:${api_port}/devices/${device_id}/commands" >"${command_file}"
  command_id="$(node -e 'const value=require(process.argv[1]); if(value.deviceId!==process.argv[2]||value.status!=="SENT")process.exit(1); process.stdout.write(value.commandId)' "${command_file}" "${device_id}")"
  acknowledged=false
  for _ in {1..30}; do
    if curl --fail --silent "http://127.0.0.1:${api_port}/devices/${device_id}/commands" | \
      node --input-type=module -e '
        const expected=process.argv[1]; const chunks=[];
        for await (const chunk of process.stdin) chunks.push(chunk);
        const commands=JSON.parse(Buffer.concat(chunks).toString());
        if (!commands.some(({commandId,status,acknowledgementReceivedAt}) => commandId===expected && status==="ACKNOWLEDGED" && acknowledgementReceivedAt!==null)) process.exit(1);
      ' "${command_id}" 2>/dev/null; then
      acknowledged=true
      break
    fi
    sleep 1
  done
  [[ "${acknowledged}" == true ]]
done
echo "2台のcommandとACKを確認しました"

stop_process "${simulator_pid}"
simulator_pid=""
stop_process "${api_pid}"
api_pid=""
stop_process "${ingestor_pid}"
ingestor_pid=""

node apps/simulator/scripts/probe-aws-iot-policy.mjs cross-device \
  --endpoint "${endpoint}" --credentials-dir "${credentials_dir}" \
  --source-device-id "${device_one}" --target-device-id "${device_two}"

inactive_certificate_id="$(node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).certificateId)' "${credentials_dir}/${device_two}/manifest.json")"
aws iot update-certificate --profile "${aws_profile}" --region "${aws_region}" \
  --certificate-id "${inactive_certificate_id}" --new-status INACTIVE
certificate_inactivated=true
node apps/simulator/scripts/probe-aws-iot-policy.mjs inactive-certificate \
  --endpoint "${endpoint}" --credentials-dir "${credentials_dir}" \
  --device-id "${device_two}"

echo "検証後のAWS使用量とリソース件数を確認します"
aws freetier get-free-tier-usage --profile "${aws_profile}" --region us-east-1 \
  --query 'length(freeTierUsages)' --output text
aws iot list-things --profile "${aws_profile}" --region "${aws_region}" \
  --query 'length(things)' --output text
aws iot list-certificates --profile "${aws_profile}" --region "${aws_region}" \
  --query 'length(certificates)' --output text

echo "AWS IoT Core E2Eが完了しました。続けてdocs/aws/e2e.mdの順序でAWSリソースを削除してください。"
