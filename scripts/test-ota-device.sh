#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
image="drone-fleet-ota-device-test"
docker build --target runtime -t "$image" .
docker run --rm --init --env OTA_DEVICE_INTEGRATION=true "$image" pnpm exec vitest run apps/ota-supervisor/test/supervisor.integration.test.ts --testTimeout 120000 --hookTimeout 30000
