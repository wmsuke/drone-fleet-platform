// 専用デモの実APIを操作する。通信mock・goal再送・履歴の初期化は行わない。
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { setTimeout } from "node:timers/promises";
import process from "node:process";
import console from "node:console";
/* global fetch, AbortSignal */

const [mode, flag, ...extra] = process.argv.slice(2);
assert(
  ["success", "cancel", "recovery"].includes(mode),
  "success / cancel / recoveryを指定する",
);
assert(
  extra.length === 0 &&
    (mode === "recovery" ? flag === "--restart-reference" : flag === undefined),
  "recoveryは--restart-referenceによる専用参照環境の再起動を必要とする",
);
const project = process.env.ROS_DEMO_PROJECT ?? "fleet-ros-demo";
assert(/^fleet-ros-demo(?:-[a-z0-9-]+)?$/.test(project), "専用project名が必要");
const port = process.env.API_PORT ?? "31196";
assert(/^\d+$/.test(port) && +port > 0 && +port < 65536, "API_PORTが不正");
const base = `http://127.0.0.1:${port}`;
const device = `ros-demo-${mode}`;
const started = performance.now();
const compose = (...args) =>
  execFileSync(
    "docker",
    [
      "compose",
      "--env-file",
      "/dev/null",
      "-p",
      project,
      "-f",
      "compose.yaml",
      "-f",
      "compose.ros-demo.yaml",
      ...args,
    ],
    { encoding: "utf8", timeout: 45000, stdio: ["ignore", "pipe", "pipe"] },
  );
async function request(path, body, key) {
  const response = await fetch(base + path, {
    signal: AbortSignal.timeout(5000),
    ...(body
      ? {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(key ? { "Idempotency-Key": key } : {}),
          },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const value = await response.json();
  assert(
    response.ok,
    `${path}: HTTP ${response.status} ${JSON.stringify(value)}`,
  );
  return value;
}
async function until(read, label, seconds = 60) {
  const deadline = performance.now() + seconds * 1000;
  let last;
  while (performance.now() < deadline) {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) {
      last = error.message;
    }
    await setTimeout(150);
  }
  throw Error(`${label}: bounded wait expired${last ? ` (${last})` : ""}`);
}
const prefix = `/devices/${device}`;
await until(
  async () => (await request(`${prefix}/bridge-configuration`)).ready,
  "fresh configuration/health",
);
const observation = (await request(prefix)).latestObservation;
assert.equal(observation.message.payload.position.kind, "LOCAL");
const command = await request(`${prefix}/commands`, { type: "RETURN_HOME" });
console.error(
  JSON.stringify({
    phase: "COMMAND_ACCEPTED",
    deviceId: device,
    commandId: command.commandId,
  }),
);
const path = `/commands/${command.commandId}/bridge-execution`;
const accepted = await until(async () => {
  const r = await request(path);
  return r.target.acceptedAt ? r : false;
}, "actual goal accepted");
const identity = {
  commandId: command.commandId,
  goalId: accepted.target.goalId,
  configurationId: accepted.target.configurationId,
  serverInstanceId: accepted.configuration.serverInstanceId,
};
assert.match(identity.goalId, /^[0-9a-f-]{36}$/);
assert.match(identity.configurationId, /^[0-9a-f]{64}$/);
let cancellation = null,
  newRuntime = null;
if (mode === "cancel") {
  const key = randomUUID();
  console.error(
    JSON.stringify({
      phase: "CANCEL_INTENT",
      ...identity,
      reason: "DEMO_OPERATOR_REQUEST",
      idempotencyKey: key,
    }),
  );
  const cancel = await request(
    `${prefix}/commands/${command.commandId}/cancel`,
    { reason: "DEMO_OPERATOR_REQUEST" },
    key,
  );
  cancellation = await until(async () => {
    const r = await request(`${prefix}/commands/${command.commandId}/cancel`);
    return r.assessment === "CANCELLED" && r.stopConfirmation === "OBSERVED"
      ? r
      : false;
  }, "CANCELLED and observed reference stop");
  assert.equal(cancellation.cancelId, cancel.cancelId);
  assert.equal(cancellation.request.goalId, identity.goalId);
  assert(cancellation.intervention.interventionId);
}
if (mode === "recovery") {
  const bridges = ["ros-demo-success", "ros-demo-cancel", "ros-demo-recovery"];
  // network/IPC namespaceを張り直す。全BridgeのjournalとCloud DBは保持する。
  compose("stop", ...bridges);
  compose("restart", "ros-demo-reference");
  compose("up", "-d", "--no-deps", "--force-recreate", ...bridges);
}
const execution = await until(
  async () => {
    const r = await request(path);
    if (mode === "recovery")
      return r.command.executionStatus === "UNCERTAIN" &&
        r.recovery.humanReviewRequired
        ? r
        : false;
    return r.command.executionStatus ===
      (mode === "cancel" ? "CANCELLED" : "SUCCEEDED") && r.target.stopConfirmed
      ? r
      : false;
  },
  "persisted terminal and separate stop/recovery evidence",
  130,
);
assert.equal(execution.target.goalId, identity.goalId);
assert.equal(execution.target.configurationId, identity.configurationId);
assert.equal(
  execution.configuration.serverInstanceId,
  identity.serverInstanceId,
);
if (mode === "recovery") {
  newRuntime = JSON.parse(
    compose(
      "exec",
      "-T",
      "ros-demo-reference",
      "bash",
      "/workspace/tools/entrypoint.sh",
      "python3",
      "/workspace/tools/probe_action.py",
      device,
    ),
  );
  assert.notEqual(newRuntime.serverInstanceId, identity.serverInstanceId);
  assert.equal(newRuntime.acceptedCount, 0);
  assert.equal(newRuntime.executionCount, 0);
  assert.equal(execution.recovery.reason, "SERVER_CHANGED");
  assert.equal(execution.target.stopConfirmed, false);
  const r = await fetch(base + prefix + "/commands", {
    method: "POST",
    signal: AbortSignal.timeout(5000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "RETURN_HOME" }),
  });
  assert.equal(r.status, 409);
}
console.log(
  JSON.stringify(
    {
      status: "PASSED",
      mode,
      deviceId: device,
      ...identity,
      executionStatus: execution.command.executionStatus,
      stopConfirmed: execution.target.stopConfirmed,
      recovery: execution.recovery,
      interventionId: cancellation?.intervention.interventionId ?? null,
      newRuntime,
      elapsedMs: performance.now() - started,
      observedAt: new Date().toISOString(),
      ui: `http://localhost:${process.env.DASHBOARD_PORT ?? "5176"}/devices/${device}/ros?commandId=${command.commandId}`,
      physicalStopVerified: false,
    },
    null,
    2,
  ),
);
