import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { setTimeout } from "node:timers/promises";
/* global AbortSignal */

const retryable = new Set([
  "ROS_HEALTH_UNAVAILABLE",
  "ROS_CONFIGURATION_UNAVAILABLE",
  "ROS_OBSERVATION_UNAVAILABLE",
]);

// 受付前の明示的な拒否だけを再評価する。POST応答不明や別keyで穴埋めしない。
export async function acceptFleetOperation({
  api,
  devices,
  groupId,
  key,
  timeoutMs = 15000,
  maxAttempts = 10,
  pollMs = 200,
}) {
  assert(key && devices.length > 0);
  const started = performance.now();
  const deadline = started + timeoutMs;
  let attempts = 0;
  const options = () => ({
    signal: AbortSignal.timeout(
      Math.max(1, Math.ceil(deadline - performance.now())),
    ),
  });
  while (performance.now() < deadline && attempts < maxAttempts) {
    const snapshots = await Promise.all(
      devices.map((id) =>
        api(`/devices/${id}/bridge-configuration`, undefined, options()),
      ),
    );
    if (
      snapshots.every(
        (r) => r.status === 200 && r.body.ready && r.body.fresh,
      ) &&
      performance.now() < deadline
    ) {
      attempts++;
      const response = await api(
        "/fleet-operations",
        { groupId, type: "RETURN_HOME" },
        {
          ...options(),
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": key,
          },
        },
      );
      if (response.status === 202)
        return {
          ...response,
          acceptance: { key, attempts, elapsedMs: performance.now() - started },
        };
      if (response.status !== 409 || !retryable.has(response.body.error))
        throw Error(
          `fleet operation not accepted: ${response.status} ${JSON.stringify(response.body)} key=${key}`,
        );
    }
    await setTimeout(
      Math.min(pollMs, Math.max(0, deadline - performance.now())),
    );
  }
  throw Error(
    `bounded fleet acceptance expired: attempts=${attempts} key=${key}`,
  );
}
