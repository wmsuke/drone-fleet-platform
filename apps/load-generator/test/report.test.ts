import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  writeLoadGeneratorReport,
  type LoadGeneratorReport,
} from "../src/report.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("writeLoadGeneratorReport", () => {
  it("creates the output directory and writes formatted JSON", async () => {
    const directory = await mkdtemp(join(tmpdir(), "load-generator-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "nested", "report.json");
    const report: LoadGeneratorReport = {
      schemaVersion: 1,
      testId: "test-1",
      sessionId: "worker-1",
      config: {
        deviceStart: 1,
        deviceCount: 1,
        connectionRatePerSecond: 10,
        telemetryIntervalMs: 1000,
        simulationSeed: "seed-a",
        maxMessages: 1,
        maxDurationMs: 1000,
        mqttUrl: "mqtt://localhost:1883",
        transport: "local",
        topicPrefix: "",
      },
      startedAt: "2026-10-01T00:00:00.000Z",
      endedAt: "2026-10-01T00:00:01.000Z",
      stopReason: "MAX_MESSAGES",
      counters: { attempted: 1, succeeded: 1, failed: 0 },
      devices: [
        {
          deviceId: "load-000001",
          attempted: 1,
          succeeded: 1,
          failed: 0,
          lastSequence: 0,
        },
      ],
    };

    await writeLoadGeneratorReport(path, report);

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(report);
  });
});
