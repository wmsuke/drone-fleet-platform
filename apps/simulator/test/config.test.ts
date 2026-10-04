import { describe, expect, it } from "vitest";

import {
  loadSimulatorConfig,
  MAX_DRONE_COUNT,
  MAX_TIMER_DELAY_MS,
} from "../src/config.js";

describe("loadSimulatorConfig", () => {
  it("uses local defaults", () => {
    expect(loadSimulatorConfig({})).toEqual({
      deviceIdPrefix: "drone",
      droneCount: 10,
      mqttTransport: {
        type: "local",
        url: "mqtt://127.0.0.1:1883",
      },
      simulationSeed: "default",
      telemetryIntervalMs: 5000,
    });
  });

  it("reads environment variables", () => {
    expect(
      loadSimulatorConfig({
        MQTT_HOST: "mqtt.example.test",
        MQTT_PORT: "2883",
        DEVICE_ID_PREFIX: "test-drone",
        DRONE_COUNT: "3",
        SIMULATION_SEED: "demo-2026",
        TELEMETRY_INTERVAL_MS: "1000",
      }),
    ).toEqual({
      deviceIdPrefix: "test-drone",
      droneCount: 3,
      mqttTransport: {
        type: "local",
        url: "mqtt://mqtt.example.test:2883",
      },
      simulationSeed: "demo-2026",
      telemetryIntervalMs: 1000,
    });
  });

  it("reads the AWS IoT transport configuration", () => {
    expect(
      loadSimulatorConfig({
        MQTT_TRANSPORT: "aws-iot",
        AWS_IOT_ENDPOINT: "example-ats.iot.ap-northeast-1.amazonaws.com",
        AWS_IOT_ROOT_CA_PATH: "/credentials/AmazonRootCA1.pem",
        AWS_IOT_DEVICE_CREDENTIALS_DIR: "/credentials/devices",
        DEVICE_ID_PREFIX: "dev-drone",
        DRONE_COUNT: "2",
      }),
    ).toMatchObject({
      deviceIdPrefix: "dev-drone",
      droneCount: 2,
      mqttTransport: {
        type: "aws-iot",
        endpoint: "example-ats.iot.ap-northeast-1.amazonaws.com",
        rootCaPath: "/credentials/AmazonRootCA1.pem",
        deviceCredentialsDirectory: "/credentials/devices",
      },
    });
  });

  it.each([
    [
      "endpoint",
      {
        AWS_IOT_ROOT_CA_PATH: "/ca",
        AWS_IOT_DEVICE_CREDENTIALS_DIR: "/devices",
      },
    ],
    [
      "root CA",
      {
        AWS_IOT_ENDPOINT: "example.iot",
        AWS_IOT_DEVICE_CREDENTIALS_DIR: "/devices",
      },
    ],
    [
      "credential directory",
      { AWS_IOT_ENDPOINT: "example.iot", AWS_IOT_ROOT_CA_PATH: "/ca" },
    ],
  ])("requires the AWS IoT %s", (_name, awsEnvironment) => {
    expect(() =>
      loadSimulatorConfig({ MQTT_TRANSPORT: "aws-iot", ...awsEnvironment }),
    ).toThrow(TypeError);
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
    ["invalid transport", { MQTT_TRANSPORT: "cloud" }],
    [
      "invalid AWS endpoint",
      {
        MQTT_TRANSPORT: "aws-iot",
        AWS_IOT_ENDPOINT: "mqtts://example.iot",
        AWS_IOT_ROOT_CA_PATH: "/ca",
        AWS_IOT_DEVICE_CREDENTIALS_DIR: "/devices",
      },
    ],
    ["empty device ID prefix", { DEVICE_ID_PREFIX: "" }],
    ["invalid device ID prefix", { DEVICE_ID_PREFIX: "drone/" }],
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
    ["empty simulation seed", { SIMULATION_SEED: "" }],
    ["too long simulation seed", { SIMULATION_SEED: "x".repeat(129) }],
  ])("rejects %s", (_name, environment) => {
    expect(() => loadSimulatorConfig(environment)).toThrow(TypeError);
  });
});
