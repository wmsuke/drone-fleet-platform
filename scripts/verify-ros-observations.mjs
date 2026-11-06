import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import process from "node:process";
import console from "node:console";
/* global fetch */
import { writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { execFileSync } from "node:child_process";

const [url, results, project] = process.argv.slice(2);
const compose = (...args) =>
  execFileSync(
    "docker",
    [
      "compose",
      "-p",
      project,
      "-f",
      "compose.yaml",
      "-f",
      "compose.ros-observations.yaml",
      ...args,
    ],
    { encoding: "utf8", timeout: 30000 },
  );
async function until(check) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await check()) return;
    await setTimeout(500);
  }
  throw new Error("bounded observation wait expired");
}
const device = "ros-ref-001";
let configuration;
await until(async () => {
  try {
    configuration = await fetch(
      `${url}/devices/${device}/bridge-configuration`,
    ).then((r) => r.json());
    return configuration.reported && configuration.fresh;
  } catch {
    return false;
  }
});
assert.deepEqual(configuration.supportedOperations, ["RETURN_HOME"]);
assert.equal(configuration.ready, false);
assert.equal(configuration.reported.configuration.bridge.version, "0.2.0");
assert.equal(configuration.reported.configuration.adapter.version, "0.2.0");
assert.equal(configuration.reported.configuration.ai.status, "NOT_APPLICABLE");
assert.equal(configuration.reported.configuration.runtime.rosDistro, "jazzy");
await writeFile(
  `${results}/bridge-configuration.json`,
  JSON.stringify(configuration, null, 2),
);
const configurationId = configuration.reported.configurationId;
const oldReportSequence = configuration.reported.reportSequence;
const oldConfigurationRevision = configuration.reported.configurationRevision;
const desired = await fetch(
  `${url}/devices/${device}/bridge-configuration/desired`,
  {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ revision: 1, configurationId: "0".repeat(64) }),
  },
).then((r) => r.json());
assert.equal(desired.matchesDesired, false);
assert.equal(desired.reported.configurationId, configurationId);
let detail;
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    detail = await fetch(`${url}/devices/${device}`).then((r) => r.json());
    if (
      detail.latestObservation?.message.payload.quality.position.reason ===
        "VALID" &&
      detail.latestObservation.message.payload.quality.battery.reason ===
        "VALID" &&
      detail.latestObservation.message.payload.quality.diagnostics.reason ===
        "VALID" &&
      detail.latestObservation.message.payload.quality.flightStatus.reason ===
        "VALID"
    )
      break;
  } catch {
    /* services starting */
  }
  await setTimeout(1000);
}
assert.equal(detail.connectionStatus, "ONLINE");
assert.equal(detail.latestTelemetry, null);
const { message } = detail.latestObservation;
assert.equal(message.schemaVersion, 3);
assert.equal(message.payload.source, "ROS2");
assert(Math.abs(message.payload.battery - 80) < 0.001);
assert.equal(message.payload.temperature, 24);
assert.equal(message.payload.position.kind, "LOCAL");
assert.equal(message.payload.position.unit, "m");
assert.equal(message.payload.position.velocity.linearUnit, "m/s");
assert(message.payload.position.frameId.endsWith("/map"));
assert(!("latitude" in message.payload.position));
assert.equal(message.payload.quality.diagnostics.reason, "VALID");
assert.equal(message.payload.quality.flightStatus.reason, "VALID");
assert(message.payload.diagnostics.length > 0);
assert.equal(
  (await fetch(`${url}/devices/${device}/observations?limit=0`)).status,
  400,
);
assert.equal(
  (await fetch(`${url}/devices/unregistered-ros/observations`)).status,
  404,
);
const history = await fetch(
  `${url}/devices/${device}/observations?limit=10`,
).then((r) => r.json());
assert(
  history.some(
    (row) =>
      row.message.sessionId === message.sessionId &&
      row.message.sequence === message.sequence,
  ),
);
assert.deepEqual(
  await fetch(`${url}/devices/${device}/telemetry`).then((r) => r.json()),
  [],
);
await writeFile(
  `${results}/api-observation.json`,
  JSON.stringify(detail, null, 2),
);
// namespace所有containerの停止はMQTT linkも切るため、publisherだけを凍結する。
compose("pause", "ros-reference");
await until(async () => {
  const state = await fetch(`${url}/devices/${device}`).then((r) => r.json());
  return (
    state.latestObservation.message.payload.quality.battery.reason === "STALE"
  );
});
await until(
  () =>
    compose(
      "exec",
      "-T",
      "ros-bridge",
      "python3",
      "-c",
      "import sqlite3; print(sqlite3.connect('/data/fleet/bridge.sqlite3').execute('SELECT count(*) FROM telemetry_outbox').fetchone()[0])",
    ).trim() === "0",
);
// PUBACKではなくDB commitのreceiptでqueueが空になった後、同じ本文を再配送。
for (let n = 0; n < 2; n++)
  compose(
    "exec",
    "-T",
    "mqtt",
    "mosquitto_pub",
    "-q",
    "1",
    "-t",
    `fleet/v1/devices/${device}/telemetry`,
    "-m",
    JSON.stringify(message),
  );
await setTimeout(1000);
const count = compose(
  "exec",
  "-T",
  "postgres",
  "psql",
  "-U",
  "drone_fleet",
  "-d",
  "drone_fleet",
  "-tAc",
  `SELECT count(*) FROM ros_observations WHERE device_id='${device}' AND session_id='${message.sessionId}' AND sequence=${message.sequence}`,
);
assert.equal(count.trim(), "1");
compose("unpause", "ros-reference");
compose("restart", "ros-bridge");
await until(async () => {
  const state = await fetch(`${url}/devices/${device}`).then((r) => r.json());
  return (
    state.latestObservation.message.sessionId !== message.sessionId &&
    state.latestObservation.message.payload.quality.position.reason === "VALID"
  );
});
await until(async () => {
  const state = await fetch(
    `${url}/devices/${device}/bridge-configuration`,
  ).then((r) => r.json());
  return (
    state.reported?.reportSequence > oldReportSequence &&
    state.reported.configurationId === configurationId &&
    state.reported.configurationRevision === oldConfigurationRevision
  );
});
await until(
  () =>
    compose(
      "exec",
      "-T",
      "ros-bridge",
      "python3",
      "-c",
      "import sqlite3; print(sqlite3.connect('/data/fleet/bridge.sqlite3').execute('SELECT count(*) FROM bridge_outbox').fetchone()[0])",
    ).trim() === "0",
);
const reports = await fetch(
  `${url}/devices/${device}/bridge-configuration/reports`,
).then((r) => r.json());
const originalReport = reports.at(-1).message;
for (let i = 0; i < 2; i++)
  compose(
    "exec",
    "-T",
    "mqtt",
    "mosquitto_pub",
    "-q",
    "1",
    "-t",
    `fleet/v1/devices/${device}/bridge-events`,
    "-m",
    JSON.stringify(originalReport),
  );
const staleReport = { ...originalReport, eventId: randomUUID() };
compose(
  "exec",
  "-T",
  "mqtt",
  "mosquitto_pub",
  "-q",
  "1",
  "-t",
  `fleet/v1/devices/${device}/bridge-events`,
  "-m",
  JSON.stringify(staleReport),
);
await until(async () =>
  (
    await fetch(`${url}/devices/${device}/bridge-configuration/reports`).then(
      (r) => r.json(),
    )
  ).some(
    (row) => row.eventId === staleReport.eventId && row.disposition === "STALE",
  ),
);
assert.equal(
  (
    await fetch(`${url}/devices/${device}/bridge-configuration`).then((r) =>
      r.json(),
    )
  ).reported.configurationId,
  configurationId,
);
console.log("ROS publisher -> Bridge -> MQTT -> PostgreSQL -> API: passed");
console.log(
  "Actual configuration/capability -> DB receipt -> API, desired separation, persistent counters and stale report: passed",
);
console.log(
  "Publisher stop/stale, DB receipt, duplicate resend, process restart: passed",
);
