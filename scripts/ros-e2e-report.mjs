import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import process from "node:process";

export const requiredCases = [
  "success-duplicates-quarantine",
  "reject",
  "abort",
  "BEFORE_SEND_INTENT",
  "AFTER_SEND_INTENT",
  "AFTER_SEND_GOAL",
  "AFTER_RESULT",
  "real-result-cache-expired",
  "fixed-denominator-aggregation",
  "simulator-v2-coexistence",
  "cancel-accepted-not-terminal-then-cancelled-and-stop",
  "cancel-rejected-preserves-later-success",
  "completion-wins-delayed-cancel",
  "cancel-accepted-without-terminal-remains-uncertain",
  "offline-request-expiry-late-response-and-restart",
  "actual-unknown-goal-response",
  "server-generation-changed",
  "unreported-120-second-deadline",
  "mqtt-outage-HOME_REACHED",
  "mqtt-outage-LOW_BATTERY",
  "dds-only-outage-watchdog-result-without-fabricated-stop",
  "bridge-restart-queries-original-goal",
  "ros-node-loss-does-not-imply-stop",
  "action-server-restart-no-goal-resubmit",
  "two-device-namespace-routing",
  "delayed-feedback-does-not-rewind-terminal",
  "historical-configuration-retained",
  "mqtt-outage-POLICY_REJECTED",
  "mqtt-outage-SENSOR_STALE",
  "dashboard-success-evidence",
  "dashboard-cancel-evidence",
  "dashboard-uncertain-evidence",
  "dashboard-live-cancel-uncertain",
];

// 各caseを確認した直後に保存する。途中失敗でも完了済みの証拠を失わない。
export function evidenceLog(path) {
  const values = [];
  const current = join(dirname(path), "current-case.json");
  let active = null;
  writeFileSync(path, "[]\n");
  return {
    begin(name) {
      active = name;
      writeFileSync(current, JSON.stringify(name));
    },
    push(...items) {
      values.push(
        ...items.map((v) => ({ ...v, observedAt: new Date().toISOString() })),
      );
      writeFileSync(path, JSON.stringify(values, null, 2) + "\n");
      if (items.some((v) => v.case === active)) {
        active = null;
        writeFileSync(current, "null");
      }
      for (const item of items)
        process.stdout.write(`ROS E2E passed: ${item.case}\n`);
      return values.length;
    },
    toJSON: () => values,
  };
}
export function summarize({
  metadata,
  evidence,
  measurements,
  cleanup,
  reconciliation,
  exitCode,
  activeCase = null,
}) {
  const errors = [];
  if (!metadata?.rosEnvironment?.packagesSha256)
    errors.push("ROS environment not verified");
  const checks = requiredCases.map((name) => {
    const records = evidence.filter((e) => e.case === name);
    if (records.length > 1) errors.push(`duplicate case: ${name}`);
    return {
      name,
      status:
        records.length === 1
          ? "PASSED"
          : records.length === 0 && activeCase !== name
            ? "NOT_EXECUTED"
            : "FAILED",
      evidence: records,
    };
  });
  if (evidence.some((e) => !requiredCases.includes(e.case)))
    errors.push("unexpected case");
  if (!reconciliation?.verified) errors.push("DB reconciliation not verified");
  if (
    cleanup.exitCode !== 0 ||
    [
      cleanup.containers,
      cleanup.volumes,
      cleanup.networks,
      cleanup.images,
    ].some((v) => !Array.isArray(v) || v.length)
  )
    errors.push("cleanup incomplete");
  const elapsed = measurements
    .filter((m) => Number.isFinite(m.durationMs))
    .map((m) => m.durationMs)
    .sort((a, b) => a - b);
  if (
    !elapsed.length ||
    elapsed.length !== measurements.length ||
    elapsed[0] < 0
  )
    errors.push("HTTP latency measurements missing or invalid");
  const percentile = (p) =>
    elapsed.length ? elapsed[Math.ceil(elapsed.length * p) - 1] : null;
  return {
    schemaVersion: 1,
    status:
      exitCode === 0 &&
      checks.every((c) => c.status === "PASSED") &&
      !errors.length
        ? "PASSED"
        : "FAILED",
    metadata,
    finishedAt: new Date().toISOString(),
    processExitCode: exitCode,
    checks,
    errors,
    http: {
      samples: measurements.length,
      failedRequests: measurements.filter((m) => m.error).length,
      latencyMs: {
        source: "observed host HTTP round trip",
        p50: percentile(0.5),
        p95: percentile(0.95),
        max: elapsed.at(-1) ?? null,
      },
    },
    reconciliation,
    cleanup,
    unverified: [
      "実機・物理安全停止・安全認証",
      "PX4/Gazebo/SLAM/AI",
      "大規模性能・性能保証",
      "AWS経路・費用",
    ],
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [directory, code] = process.argv.slice(2);
  const read = (name, fallback) => {
    try {
      return JSON.parse(readFileSync(join(directory, name), "utf8"));
    } catch {
      return fallback;
    }
  };
  let measurements = [];
  try {
    measurements = readFileSync(join(directory, "http.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((v) => JSON.parse(v));
  } catch {
    /* 未実行・途中失敗を空の実測として残す。 */
  }
  const report = summarize({
    metadata: {
      ...read("metadata.json", {}),
      rosEnvironment: read("environment-manifest.json", null),
    },
    evidence: read("action-evidence.json", []),
    measurements,
    cleanup: read("cleanup.json", { exitCode: 1 }),
    reconciliation: read("reconciliation.json", null),
    exitCode: Number(code),
    activeCase: read("current-case.json", null),
  });
  writeFileSync(
    join(directory, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  process.exitCode = report.status === "PASSED" ? 0 : 1;
}
