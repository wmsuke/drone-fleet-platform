import { describe, expect, it } from "vitest";

import { loadLoadGeneratorConfig } from "../src/config.js";

const validEnvironment = {
  LOAD_TEST_ID: "local-step-1",
  LOAD_SESSION_ID: "host-a",
  LOAD_DEVICE_START: "1001",
  LOAD_DEVICE_COUNT: "500",
  LOAD_CONNECTION_RATE_PER_SECOND: "25",
  LOAD_TELEMETRY_INTERVAL_MS: "1000",
  LOAD_SIMULATION_SEED: "repeatable",
  LOAD_MAX_MESSAGES: "200000",
  LOAD_MAX_DURATION_MS: "600000",
};

describe("loadLoadGeneratorConfig", () => {
  it("loads the complete local MQTT configuration", () => {
    expect(loadLoadGeneratorConfig(validEnvironment)).toEqual({
      testId: "local-step-1",
      sessionId: "host-a",
      deviceStart: 1001,
      deviceCount: 500,
      connectionRatePerSecond: 25,
      telemetryIntervalMs: 1000,
      simulationSeed: "repeatable",
      maxMessages: 200000,
      maxDurationMs: 600000,
      mqttUrl: "mqtt://localhost:1883",
      reportPath: "load-results/local-step-1-host-a.json",
    });
  });

  it("allows MQTT and report destinations to be overridden", () => {
    expect(
      loadLoadGeneratorConfig({
        ...validEnvironment,
        MQTT_HOST: "mqtt",
        MQTT_PORT: "2883",
        LOAD_REPORT_PATH: "/tmp/result.json",
      }),
    ).toMatchObject({
      mqttUrl: "mqtt://mqtt:2883",
      reportPath: "/tmp/result.json",
    });
  });

  it("reads the shared measurement window", () => {
    expect(
      loadLoadGeneratorConfig({
        ...validEnvironment,
        LOAD_MEASUREMENT_START_AT: "2026-10-01T00:00:10.000Z",
        LOAD_MEASUREMENT_DURATION_MS: "30000",
      }),
    ).toMatchObject({
      measurementStartAt: new Date("2026-10-01T00:00:10.000Z"),
      measurementDurationMs: 30_000,
    });
  });

  it.each([
    ["LOAD_TEST_ID", ""],
    ["LOAD_SESSION_ID", "invalid id"],
    ["LOAD_DEVICE_START", "0"],
    ["LOAD_DEVICE_COUNT", "1.5"],
    ["LOAD_CONNECTION_RATE_PER_SECOND", "0"],
    ["LOAD_TELEMETRY_INTERVAL_MS", "-1"],
    ["LOAD_SIMULATION_SEED", ""],
    ["LOAD_MAX_MESSAGES", "0"],
    ["LOAD_MAX_DURATION_MS", "0"],
  ])("rejects invalid %s", (name, value) => {
    expect(() =>
      loadLoadGeneratorConfig({ ...validEnvironment, [name]: value }),
    ).toThrow();
  });
});
