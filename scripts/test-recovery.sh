#!/usr/bin/env bash
set -euo pipefail

command -v docker >/dev/null
docker compose version >/dev/null
command -v node >/dev/null

readonly project_name="recovery-$(node -p 'require("node:crypto").randomUUID()')"

# Vitestの失敗・タイムアウトでも、今回作成したprojectだけを片付ける。
cleanup() {
  status=$?
  trap - EXIT
  if ! docker compose --env-file /dev/null -f compose.recovery.yaml \
    -p "${project_name}" --profile limited down --volumes --remove-orphans \
    --timeout 5 >/dev/null 2>&1; then
    echo "復旧E2E環境のcleanupに失敗しました: ${project_name}" >&2
    status=1
  fi
  if docker image inspect "${project_name}-runtime" >/dev/null 2>&1 &&
    ! docker image rm "${project_name}-runtime" >/dev/null 2>&1; then
    echo "復旧E2E専用imageのcleanupに失敗しました: ${project_name}-runtime" >&2
    status=1
  fi
  exit "${status}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

RECOVERY_PROJECT="${project_name}" RECOVERY_E2E=true \
  pnpm exec vitest run --no-file-parallelism apps/api/test/recovery.e2e.test.ts
