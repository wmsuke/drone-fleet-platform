import assert from "node:assert/strict";
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
console.log("ROS publisher -> Bridge -> MQTT -> PostgreSQL -> API: passed");
console.log(
  "Publisher stop/stale, DB receipt, duplicate resend, process restart: passed",
);
