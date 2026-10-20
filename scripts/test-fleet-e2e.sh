#!/usr/bin/env bash
set -euo pipefail
readonly project_name="fleet-e2e-$(node -p 'require("node:crypto").randomUUID()')"
cleanup() {
  status=$?
  trap - EXIT
  mkdir -p "fleet-e2e-results/$project_name"
  # Vitestの強制終了でも、削除前のサービスログを残す。
  docker compose --env-file /dev/null -f compose.fleet-e2e.yaml -p "$project_name" logs --no-color --timestamps >"fleet-e2e-results/$project_name/fallback-services.log" 2>&1 || true
  if ! docker compose --env-file /dev/null -f compose.fleet-e2e.yaml -p "$project_name" down --volumes --remove-orphans --timeout 5; then
    echo "E2E専用環境のcleanupに失敗: $project_name" >&2
    status=1
  fi
  if docker image inspect "$project_name-runtime" >/dev/null 2>&1; then
    docker image rm "$project_name-runtime" || status=1
  fi
  for kind in containers volumes networks; do
    case "$kind" in
      containers) remaining=$(docker ps -aq --filter "label=com.docker.compose.project=$project_name") || status=1 ;;
      volumes) remaining=$(docker volume ls -q --filter "label=com.docker.compose.project=$project_name") || status=1 ;;
      networks) remaining=$(docker network ls -q --filter "label=com.docker.compose.project=$project_name") || status=1 ;;
    esac
    if [ -n "$remaining" ]; then echo "専用${kind}が残存: $remaining" >&2; status=1; fi
  done
  printf '{"exitCode":%s,"project":"%s"}\n' "$status" "$project_name" >"fleet-e2e-results/$project_name/wrapper-cleanup.json"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
FLEET_E2E_PROJECT="$project_name" FLEET_E2E=true \
  pnpm exec vitest run --no-file-parallelism apps/dashboard/test/fleet.e2e.test.tsx
