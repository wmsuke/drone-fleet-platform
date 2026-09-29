import { describe, expect, it } from "vitest";

import {
  loadSimulatorConfig,
  MAX_DRONE_COUNT,
  MAX_TIMER_DELAY_MS,
} from "../src/config.js";

describe("loadSimulatorConfig", () => {
  it("uses local defaults", () => {
    expect(loadSimulatorConfig({})).toEqual({
      droneCount: 10,
      mqttUrl: "mqtt://127.0.0.1:1883",
      telemetryIntervalMs: 5000,
    });
  });

  it("reads environment variables", () => {
    expect(
      loadSimulatorConfig({
        MQTT_HOST: "mqtt.example.test",
        MQTT_PORT: "2883",
        DRONE_COUNT: "3",
        TELEMETRY_INTERVAL_MS: "1000",
      }),
    ).toEqual({
      droneCount: 3,
      mqttUrl: "mqtt://mqtt.example.test:2883",
      telemetryIntervalMs: 1000,
    });
  });

  it("accepts Node's maximum timer delay", () => {
    expect(
      loadSimulatorConfig({
        TELEMETRY_INTERVAL_MS: String(MAX_TIMER_DELAY_MS),
      }).telemetryIntervalMs,
    ).toBe(MAX_TIMER_DELAY_MS);
  });

  it("accepts the configured maximum drone count", () => {
    expect(
      loadSimulatorConfig({ DRONE_COUNT: String(MAX_DRONE_COUNT) }).droneCount,
    ).toBe(MAX_DRONE_COUNT);
  });

  it.each([
    ["empty host", { MQTT_HOST: "" }],
    ["invalid port", { MQTT_PORT: "0" }],
    ["non-integer port", { MQTT_PORT: "1883.5" }],
    ["zero drones", { DRONE_COUNT: "0" }],
    ["negative drones", { DRONE_COUNT: "-1" }],
    ["non-integer drone count", { DRONE_COUNT: "1.5" }],
    ["non-numeric drone count", { DRONE_COUNT: "many" }],
    [
      "drone count above the configured limit",
      { DRONE_COUNT: String(MAX_DRONE_COUNT + 1) },
    ],
    ["zero interval", { TELEMETRY_INTERVAL_MS: "0" }],
    [
      "interval above Node timer limit",
      { TELEMETRY_INTERVAL_MS: String(MAX_TIMER_DELAY_MS + 1) },
    ],
    ["non-numeric interval", { TELEMETRY_INTERVAL_MS: "fast" }],
  ])("rejects %s", (_name, environment) => {
    expect(() => loadSimulatorConfig(environment)).toThrow(TypeError);
  });
});
