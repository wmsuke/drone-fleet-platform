#!/usr/bin/env bash

set -euo pipefail

readonly GITLEAKS_VERSION="8.28.0"
readonly REPOSITORY_ROOT="$(git rev-parse --show-toplevel)"

run_gitleaks() {
  local command="$1"
  shift

  if command -v gitleaks >/dev/null 2>&1; then
    gitleaks "$command" "$@" "$REPOSITORY_ROOT"
    return
  fi

  if command -v docker >/dev/null 2>&1; then
    docker run --rm \
      --volume "${REPOSITORY_ROOT}:/repo" \
      --workdir /repo \
      "zricethezav/gitleaks:v${GITLEAKS_VERSION}" \
      "$command" "$@" /repo
    return
  fi

  echo "gitleaksまたはDockerが必要です。" >&2
  exit 127
}

cd "$REPOSITORY_ROOT"

echo "作業ツリーを検査します。"
run_gitleaks dir --no-banner --redact --verbose

echo "全Git履歴を検査します。"
run_gitleaks git --no-banner --redact --verbose --log-opts="--all"
