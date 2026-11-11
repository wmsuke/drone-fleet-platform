import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import process from "node:process";
import console from "node:console";
import { verifyCancellations } from "./verify-ros-cancels.mjs";
import { verifyRecovery } from "./verify-ros-recovery.mjs";
import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";
import { appendFileSync, readFileSync } from "node:fs";
import { evidenceLog } from "./ros-e2e-report.mjs";
import {
  verifyNamespaceAndFeedback,
  reconcile,
} from "./verify-ros-boundaries.mjs";
/* global fetch, AbortSignal */

const [url, results, project] = process.argv.slice(2);
const extended = process.env.ROS_E2E === "true";
let device = "ros-command-success",
  peerDevice = "ros-command-reject",
  fault = "",
  referenceConfig = "/workspace/config/commands.json";
function compose(...args) {
  const execute = () =>
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
        "compose.ros-commands.yaml",
        ...args,
      ],
      {
        encoding: "utf8",
        timeout: args[0] === "run" ? 150000 : 30000,
        maxBuffer: 8 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          ROS_COMMAND_DEVICE: device,
          ROS_COMMAND_FAULT: fault,
          ROS_REFERENCE_CONFIG: referenceConfig,
          ROS_PEER_DEVICE: peerDevice,
        },
      },
    );
  if (args[0] !== "run") return execute();
  try {
    const output = execute();
    appendFileSync(`${results}/ui-process.log`, output);
    return output;
  } catch (error) {
    appendFileSync(
      `${results}/ui-process.log`,
      `${error.stdout ?? ""}\n${error.stderr ?? ""}\n${error.message}\n`,
    );
    throw error;
  }
}
async function api(path, body, extra = {}) {
  const start = performance.now();
  try {
    const response = await fetch(
      url + path,
      body === undefined
        ? { signal: AbortSignal.timeout(5000), ...extra }
        : {
            method: "POST",
            signal: AbortSignal.timeout(5000),
            headers: { "Content-Type": "application/json", ...extra.headers },
            body: JSON.stringify(body),
            ...extra,
          },
    );
    const result = { status: response.status, body: await response.json() };
    appendFileSync(
      `${results}/http.jsonl`,
      JSON.stringify({
        path,
        method: body === undefined ? "GET" : "POST",
        status: response.status,
        durationMs: performance.now() - start,
      }) + "\n",
    );
    return result;
  } catch (error) {
    appendFileSync(
      `${results}/http.jsonl`,
      JSON.stringify({
        path,
        error: error.name,
        durationMs: performance.now() - start,
      }) + "\n",
    );
    throw error;
  }
}
async function until(check, name, seconds = 45) {
  const deadline = performance.now() + seconds * 1000;
  let last;
  while (performance.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      last = error.message;
    }
    await setTimeout(200);
  }
  throw new Error(`bounded ${name} wait expired${last ? ": " + last : ""}`);
}
async function ready() {
  return until(async () => {
    const r = await api(`/devices/${device}/bridge-configuration`);
    return r.status === 200 && r.body.ready && r.body.fresh ? r.body : false;
  }, `${device} ready`);
}
function runtime(goal, target = device) {
  return JSON.parse(
    compose(
      "exec",
      "-T",
      "ros-reference",
      "bash",
      "/workspace/tools/entrypoint.sh",
      "python3",
      "/workspace/tools/probe_action.py",
      target,
      ...(goal ? [goal] : []),
    ),
  );
}
function journal(commandId) {
  const code = `import sqlite3,json,os,sys
db=sqlite3.connect(os.environ['BRIDGE_STATE_DIR']+'/bridge.sqlite3')
row=db.execute('SELECT goal,state,result FROM action_commands WHERE command=?',(sys.argv[1],)).fetchone()
p=db.execute('SELECT query_count,terminal_event FROM action_progress WHERE command=?',(sys.argv[1],)).fetchone()
print(json.dumps({'goalId':row[0] if row else None,'state':row[1] if row else None,
'result':json.loads(row[2]) if row and row[2] else None,'queryCount':p[0] if p else 0,
'pending':db.execute('SELECT count(*) FROM bridge_outbox').fetchone()[0],
'quarantined':db.execute("SELECT count(*) FROM inbox WHERE reason='QUARANTINED_COMMAND'").fetchone()[0],
'goals':db.execute('SELECT count(*) FROM action_commands').fetchone()[0]}))`;
  return JSON.parse(
    compose("exec", "-T", "ros-bridge", "python3", "-c", code, commandId),
  );
}
function sql(query) {
  return compose(
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "drone_fleet",
    "-d",
    "drone_fleet",
    "-At",
    "-c",
    query,
  ).trim();
}
function payload(commandId) {
  assert.match(commandId, /^[0-9a-f-]{36}$/);
  return JSON.parse(
    sql(`SELECT payload FROM command_outbox WHERE command_id='${commandId}'`),
  );
}
function publish(kind, body, target = device) {
  compose(
    "exec",
    "-T",
    "mqtt",
    "mosquitto_pub",
    "-h",
    "localhost",
    "-q",
    "1",
    "-t",
    `fleet/v1/devices/${target}/${kind}`,
    "-m",
    JSON.stringify(body),
  );
}
async function send(type = "RETURN_HOME") {
  const r = await api(`/devices/${device}/commands`, { type });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  const wire = payload(r.body.commandId);
  assert.equal(wire.schemaVersion, 3);
  assert.equal(wire.targetKind, "ROS2");
  return { id: r.body.commandId, wire };
}
async function execution(id, states, stopped = false, seconds = 45) {
  return until(
    async () => {
      const r = await api(`/commands/${id}/bridge-execution`);
      if (
        r.status !== 200 ||
        !states.includes(r.body.command.executionStatus) ||
        (stopped && !r.body.target.stopConfirmed && !r.body.target.notStarted)
      )
        return false;
      return r.body;
    },
    `${id} ${states.join("/")}`,
    seconds,
  );
}
async function switchDevice(next, point = "") {
  device = next;
  fault = point;
  compose("up", "-d", "--no-deps", "--force-recreate", "ros-bridge");
  return ready();
}
async function switchReference(config, next) {
  referenceConfig = `/workspace/config/${config}.json`;
  compose("stop", "ros-bridge", "ros-bridge-peer");
  // 停止済みpeerも旧referenceのnetwork/IPC IDを保持するため、切替前に除く。
  compose("rm", "-f", "ros-bridge-peer");
  compose("up", "-d", "--no-deps", "--force-recreate", "ros-reference");
  await switchDevice(next);
}
function kill() {
  compose("kill", "-s", "SIGKILL", "ros-bridge");
}
async function restart() {
  fault = "";
  compose("up", "-d", "--no-deps", "--force-recreate", "ros-bridge");
}
async function barrier(id) {
  return until(() => {
    const r = JSON.parse(
      compose(
        "exec",
        "-T",
        "ros-bridge",
        "cat",
        `/data/fleet/${device}/fault.json`,
      ),
    );
    return r.commandId === id && r.point === fault;
  }, `fault ${fault}`);
}
const evidence = evidenceLog(`${results}/action-evidence.json`);
async function runUi(mode, commandId, target = device) {
  evidence.begin(
    mode === "live"
      ? "dashboard-live-cancel-uncertain"
      : `dashboard-${mode}-evidence`,
  );
  const output = `/evidence/ui-${mode}.json`;
  compose(
    "run",
    "--rm",
    "--no-deps",
    "-T",
    "-v",
    `${results}:/evidence`,
    "-e",
    "NODE_ENV=test",
    "-e",
    "ROS_E2E_UI=true",
    "-e",
    `ROS_E2E_DEVICE=${target}`,
    "-e",
    `ROS_E2E_COMMAND_ID=${commandId ?? ""}`,
    "-e",
    `ROS_E2E_UI_MODE=${mode}`,
    "-e",
    `ROS_E2E_UI_REPORT=${output}`,
    "api",
    "node",
    "node_modules/vitest/vitest.mjs",
    "run",
    "--no-file-parallelism",
    "apps/dashboard/test/ros.e2e.test.tsx",
  );
  const report = JSON.parse(readFileSync(`${results}/ui-${mode}.json`, "utf8"));
  assert.equal(report.status, "PASSED");
  assert.equal(report.deviceId, target);
  if (commandId) assert.equal(report.commandId, commandId);
  if (mode === "live") {
    assert.equal(runtime().acceptedCount, 1);
    assert.equal(runtime().executionCount, 1);
  }
  evidence.push({
    case:
      mode === "live"
        ? "dashboard-live-cancel-uncertain"
        : `dashboard-${mode}-evidence`,
    ...report,
  });
}
async function recoveryCases() {
  await switchReference("recovery", "ros-recovery-mqtt");
  await verifyRecovery({
    api,
    send,
    switchDevice,
    execution,
    compose,
    until,
    sql,
    publish,
    evidence,
    kill,
    restart,
    runtime,
    extended,
    runUi: extended ? runUi : undefined,
  });
}
if (process.env.ROS_COMMANDS_CASES === "recovery") {
  await recoveryCases();
  await writeFile(
    `${results}/action-evidence.json`,
    JSON.stringify(evidence, null, 2),
  );
  process.exit(0);
}
if (process.env.ROS_COMMANDS_CASES === "cancel") {
  await switchReference("cancels", "ros-cancel-normal");
  await verifyCancellations({
    api,
    send,
    switchDevice,
    execution,
    compose,
    until,
    sql,
    publish,
    evidence,
    kill,
    restart,
    barrier,
  });
  await writeFile(
    `${results}/action-evidence.json`,
    JSON.stringify(evidence, null, 2),
  );
  console.log(
    "Real CancelGoal accept/reject/delay/race/unknown, ten-second uncertainty and restart: passed",
  );
  process.exit(0);
}
evidence.begin("success-duplicates-quarantine");
await ready();
assert.equal(
  (await api(`/devices/${device}/commands`, { type: "REBOOT" })).status,
  409,
);
const success = await send();
const done = await execution(success.id, ["SUCCEEDED"], true);
assert.equal(done.target.goalId, journal(success.id).goalId);
assert(done.command.executionStartedAt);
assert(done.events.some((e) => e.message.kind === "GOAL_ACCEPTED"));
assert(done.events.some((e) => e.message.kind === "FEEDBACK"));
assert(done.events.some((e) => e.message.kind === "STOP_OBSERVATION"));
assert.equal(
  (await api(`/commands/${success.id}/bridge-configuration`)).body.binding
    .startedAt,
  done.command.executionStartedAt,
);
const terminal = done.events.find(
  (e) => e.message.kind === "EXECUTION" && e.message.status === "SUCCEEDED",
);
assert.equal(
  createHash("sha256")
    .update(Buffer.from(terminal.message.result.cdr, "base64"))
    .digest("hex"),
  terminal.message.result.hash,
);
await until(() => journal(success.id).pending === 0, "DB commit receipts");
const eventCount = done.events.length;
publish("commands", success.wire);
publish("bridge-events", terminal.message);
await until(() => journal(success.id).pending === 0, "duplicate receipts");
assert.equal(
  (await execution(success.id, ["SUCCEEDED"])).events.length,
  eventCount,
);
assert.equal(runtime().executionCount, 1);
if (extended) {
  await verifyNamespaceAndFeedback({
    api,
    compose,
    until,
    sql,
    publish,
    runtime,
    done,
    success,
    evidence,
    setPeer: (value) => {
      peerDevice = value;
    },
  });
  await runUi("success", success.id);
}
// 拒否した本文は永続隔離し、再起動後も操作候補にしない。
evidence.begin("success-duplicates-quarantine");
publish("commands", { ...success.wire, type: "REBOOT" });
publish("commands", { ...success.wire, deviceId: "another-device" });
publish("commands", {
  ...success.wire,
  expectedConfigurationId: "f".repeat(64),
});
await until(() => journal(success.id).quarantined === 3, "quarantine");
kill();
await restart();
await ready();
assert.equal(journal(success.id).goals, 1);
assert.equal(runtime().executionCount, 1);
evidence.push({
  case: "success-duplicates-quarantine",
  id: success.id,
  goalId: done.target.goalId,
  acceptedCount: runtime().acceptedCount,
  executionCount: runtime().executionCount,
  resultHash: terminal.message.result.hash,
  startedAt: done.command.executionStartedAt,
});

for (const [name, state, count] of [
  ["reject", "REJECTED", 0],
  ["abort", "FAILED", 1],
]) {
  evidence.begin(name);
  await switchDevice(`ros-command-${name}`);
  const command = await send(),
    result = await execution(command.id, [state], true);
  assert.equal(runtime().acceptedCount, count);
  assert.equal(runtime().executionCount, count);
  if (state === "REJECTED") {
    assert.equal(result.command.executionStartedAt, null);
    assert.equal(result.target.notStarted, true);
    assert.equal(result.target.stopConfirmed, false);
    assert.equal(
      result.events.find((e) => e.message.kind === "GOAL_REJECTED")?.message
        .adapterDecision?.reason,
      "INJECTED_REJECT",
    );
  } else
    assert.equal(
      result.events.find((e) => e.message.status === "FAILED").message.reason,
      "INJECTED_FAILURE",
    );
  evidence.push({ case: name, id: command.id, goalId: result.target.goalId });
}
for (const [name, point] of [
  ["before", "BEFORE_SEND_INTENT"],
  ["intent", "AFTER_SEND_INTENT"],
  ["sent", "AFTER_SEND_GOAL"],
  ["result", "AFTER_RESULT"],
]) {
  evidence.begin(point);
  await switchDevice(`ros-command-${name}`, point);
  const command = await send();
  await barrier(command.id);
  const before = journal(command.id);
  if (name === "sent")
    await until(() => runtime().acceptedCount === 1, "accepted before SIGKILL");
  kill();
  await restart();
  const result = await execution(
    command.id,
    name === "intent" ? ["UNCERTAIN"] : ["SUCCEEDED", "FAILED"],
  );
  assert.equal(result.target.goalId, before.goalId);
  const counts = runtime();
  assert.equal(counts.acceptedCount, name === "intent" ? 0 : 1);
  assert.equal(counts.executionCount, name === "intent" ? 0 : 1);
  if (name === "intent") {
    assert.equal(result.command.executionStartedAt, null);
    assert.equal(result.target.stopConfirmed, false);
    assert.equal(
      result.events.find((e) => e.message.status === "UNCERTAIN").message
        .reason,
      "RESULT_UNKNOWN",
    );
    assert.equal(
      (await api(`/devices/${device}/commands`, { type: "RETURN_HOME" }))
        .status,
      409,
    );
    const ota = await api(
      "/deployments",
      { releaseId: randomUUID(), deviceIds: [device] },
      {
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": randomUUID(),
        },
      },
    );
    assert.equal(ota.status, 409);
    assert.equal(ota.body.error, "ROS_EXECUTION_UNRESOLVED");
  }
  if (name === "sent") assert(journal(command.id).queryCount > 0);
  if (name === "result")
    assert.equal(
      result.events.find((e) => e.message.status === "SUCCEEDED").message
        .eventId,
      before.result.eventId,
    );
  publish("commands", command.wire);
  await setTimeout(500);
  assert.equal(runtime().executionCount, name === "intent" ? 0 : 1);
  evidence.push({
    case: point,
    id: command.id,
    goalId: before.goalId,
    executionStatus: result.command.executionStatus,
    acceptedCount: counts.acceptedCount,
    executionCount: counts.executionCount,
    queryCount: journal(command.id).queryCount,
  });
}
evidence.begin("real-result-cache-expired");
await switchDevice("ros-command-cache", "AFTER_SEND_GOAL");
const cache = await send();
await barrier(cache.id);
await until(() => runtime().acceptedCount === 1, "cache fixture accepted");
const cachedGoal = journal(cache.id).goalId;
kill();
await setTimeout(5000);
assert.equal(runtime(cachedGoal).resultStatus, 0);
await restart();
const expired = await execution(cache.id, ["UNCERTAIN"]);
assert.equal(
  expired.events.find((e) => e.message.status === "UNCERTAIN").message.reason,
  "RESULT_CACHE_UNAVAILABLE",
);
assert.equal(expired.target.stopConfirmed, false);
assert.equal(runtime().executionCount, 1);
evidence.push({
  case: "real-result-cache-expired",
  id: cache.id,
  goalId: cachedGoal,
  resultStatus: 0,
  executionCount: runtime().executionCount,
  queryCount: journal(cache.id).queryCount,
});

// 未報告commandはAPI受付から120秒でUNCERTAIN。別試験と並行して期限を進める。
await switchDevice("ros-command-deadline", "BEFORE_SEND_INTENT");
const missing = await send();
await barrier(missing.id);
kill();
const missingDevice = device;

evidence.begin("fixed-denominator-aggregation");
await switchDevice("ros-command-success");
compose("up", "-d", "--no-deps", "ros-bridge-peer");
await until(
  async () =>
    (await api("/devices/ros-command-reject/bridge-configuration")).body.ready,
  "peer ready",
);
const group = await api("/groups", { name: "ROS Action E2E" });
assert.equal(group.status, 201);
for (const id of [device, "ros-command-reject"])
  assert.equal(
    (await api(`/groups/${group.body.groupId}/devices`, { deviceId: id }))
      .status,
    201,
  );
const op = await api(
  "/fleet-operations",
  { groupId: group.body.groupId, type: "RETURN_HOME" },
  {
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": randomUUID(),
    },
  },
);
assert.equal(op.status, 202, JSON.stringify(op.body));
const summary = await until(async () => {
  const r = await api(`/fleet-operations/${op.body.operationId}`);
  return r.body.status === "PARTIALLY_FAILED" ? r.body : false;
}, "mixed ROS aggregation");
assert.equal(summary.targetCount, 2);
assert.equal(summary.counts.SUCCEEDED, 1);
assert.equal(summary.counts.REJECTED, 1);
assert.equal(summary.unsuccessfulCount, 1);
evidence.push({
  case: "fixed-denominator-aggregation",
  operationId: op.body.operationId,
});
// 通常simulatorは引き続きv2で受領・実行結果を返す。
evidence.begin("simulator-v2-coexistence");
await until(
  async () => (await api("/devices/drone-001")).status === 200,
  "legacy simulator",
);
const legacy = await api("/devices/drone-001/commands", { type: "REBOOT" });
assert.equal(legacy.status, 202);
assert.equal(payload(legacy.body.commandId).schemaVersion, 2);
await until(
  () =>
    sql(
      `SELECT execution_status FROM commands WHERE command_id='${legacy.body.commandId}'`,
    ) === "SUCCEEDED",
  "legacy execution",
);
evidence.push({ case: "simulator-v2-coexistence", id: legacy.body.commandId });

await switchReference("cancels", "ros-cancel-normal");
await verifyCancellations({
  api,
  send,
  switchDevice,
  execution,
  compose,
  until,
  sql,
  publish,
  evidence,
  kill,
  restart,
  barrier,
  runUi: extended ? runUi : undefined,
});
evidence.begin("server-generation-changed");
await switchReference("commands", "ros-command-generation");
await switchDevice("ros-command-generation", "AFTER_SEND_GOAL");
const changed = await send();
await barrier(changed.id);
await until(() => runtime().acceptedCount === 1, "generation fixture accepted");
const originalServer = runtime().serverInstanceId;
kill();
compose("restart", "ros-reference");
await restart();
const generation = await execution(changed.id, ["UNCERTAIN"]);
assert.notEqual(runtime().serverInstanceId, originalServer);
assert.equal(runtime().executionCount, 0);
assert.equal(
  generation.events.find((e) => e.message.status === "UNCERTAIN").message
    .reason,
  "SERVER_CHANGED",
);
assert.equal(generation.target.stopConfirmed, false);
evidence.push({
  case: "server-generation-changed",
  id: changed.id,
  originalServer,
  newServer: runtime().serverInstanceId,
  executionCount: runtime().executionCount,
});

evidence.begin("unreported-120-second-deadline");
const unreported = await execution(missing.id, ["UNCERTAIN"], false, 130);
assert.equal(unreported.command.executionStartedAt, null);
assert.equal(unreported.target.stopConfirmed, false);
evidence.push({
  case: "unreported-120-second-deadline",
  id: missing.id,
  resultDeadline: missing.wire.resultDeadline,
});
await switchDevice("ros-command-success");
evidence.begin("historical-configuration-retained");
const historical = (await api(`/commands/${success.id}/bridge-configuration`))
  .body;
assert.equal(
  historical.binding.configurationId,
  success.wire.expectedConfigurationId,
);
assert.equal(historical.binding.goalId, done.target.goalId);
const currentRuntime = await until(
  () => runtime(),
  "historical configuration comparison after server restart",
);
assert.notEqual(
  historical.configuration.serverInstanceId,
  currentRuntime.serverInstanceId,
);
if (extended)
  evidence.push({
    case: "historical-configuration-retained",
    commandId: success.id,
    goalId: done.target.goalId,
    originalConfigurationId: historical.binding.configurationId,
    originalServer: historical.configuration.serverInstanceId,
    currentServer: currentRuntime.serverInstanceId,
  });
device = missingDevice;
await restart();
await until(
  async () =>
    (await execution(missing.id, ["UNCERTAIN"])).events.some(
      (e) => e.disposition === "LATE",
    ),
  "late rejection history",
);
assert.equal(runtime().executionCount, 0);
await recoveryCases();
if (extended) {
  await switchDevice("ros-e2e-ui");
  await runUi("live");
  await writeFile(
    `${results}/reconciliation.json`,
    JSON.stringify(reconcile(sql), null, 2),
  );
}
await writeFile(
  `${results}/action-evidence.json`,
  JSON.stringify(evidence, null, 2),
);
console.log(
  "Real Action success/reject/abort -> immutable events/receipt -> PostgreSQL/API: passed",
);
console.log(
  "SIGKILL before/after intent/send/result, exact UUID GetResult, cache/generation loss and no duplicate execution: passed",
);
console.log(
  "Quarantine, 120-second unreported deadline, stop-held exclusivity, OTA gate, fleet aggregation and simulator v2: passed",
);
console.log(
  "Real CancelGoal accept/reject/delay/race/unknown, ten-second uncertainty and restart: passed",
);
