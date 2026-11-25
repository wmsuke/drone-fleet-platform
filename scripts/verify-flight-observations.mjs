import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";
import process from "node:process";
/* global fetch, AbortSignal */
import { setTimeout } from "node:timers/promises";

const base = `http://127.0.0.1:${process.argv[2]}/devices/gazebo-x3`;
const namespace = `fleet/d_${Buffer.from("gazebo-x3").toString("hex")}`;
const deadline = performance.now() + 15_000;
while (performance.now() < deadline) {
  const response = await fetch(`${base}/observations?limit=100`, {
    signal: AbortSignal.timeout(2000),
  });
  if (response.ok) {
    const body = await response.json();
    const rows = Array.isArray(body) ? body : body.observations;
    const samples = rows
      .map((row) => row.message.payload)
      .filter(
        ({ position, quality }) =>
          position?.kind === "LOCAL" && quality.position.timeDomain === "ROS",
      );
    const heightsByEpoch = new Map();
    for (const { position, quality } of samples) {
      const epoch = quality.position.clockEpoch;
      const heights = heightsByEpoch.get(epoch) ?? [];
      heights.push(position.pose.z);
      heightsByEpoch.set(epoch, heights);
    }
    const ascents = [...heightsByEpoch.values()].filter(
      (heights) => Math.max(...heights) - Math.min(...heights) > 0.3,
    );
    if (ascents.length >= 2) {
      for (const sample of samples) {
        assert.equal(sample.position.frameId, `${namespace}/map`);
        assert.equal(
          sample.position.velocity.frameId,
          `${namespace}/base_link`,
        );
        assert.equal(sample.position.convention, "ENU");
        assert.equal(sample.position.unit, "m");
        assert.equal(sample.position.velocity.linearUnit, "m/s");
        assert.equal(sample.position.velocity.angularUnit, "rad/s");
        assert.equal(sample.battery, null);
        assert.equal(sample.flightStatus, "UNKNOWN");
      }
      await new Promise((resolve, reject) => {
        process.stdout.write(
          JSON.stringify(samples, null, 2) + "\n",
          (error) => (error ? reject(error) : resolve()),
        );
      });
      process.exit(0);
    }
  }
  await setTimeout(250);
}
throw new Error(
  "Gazebo ascent or clock epoch change was not observed in stored ROS telemetry",
);
