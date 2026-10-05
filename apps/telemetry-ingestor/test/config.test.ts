import { describe, expect, it } from "vitest";

import { loadTelemetryIngestorConfig } from "../src/config.js";

describe("loadTelemetryIngestorConfig", () => {
  it("uses local MQTT defaults", () => {
    expect(loadTelemetryIngestorConfig({})).toEqual({
      mqttTransport: { type: "local", url: "mqtt://127.0.0.1:1883" },
      offlineTimeoutMs: 15_000,
      telemetryBatchSize: 100,
      telemetryFlushIntervalMs: 50,
      telemetryMaxBufferSize: 10_000,
    });
  });

  it("reads the MQTT host and port", () => {
    expect(
      loadTelemetryIngestorConfig({
        MQTT_HOST: "mqtt",
        MQTT_PORT: "2883",
        OFFLINE_TIMEOUT_MS: "30000",
      }),
    ).toMatchObject({
      mqttTransport: { type: "local", url: "mqtt://mqtt:2883" },
      offlineTimeoutMs: 30_000,
    });
  });

  it("reads the AWS IoT transport configuration", () => {
    expect(
      loadTelemetryIngestorConfig({
        MQTT_TRANSPORT: "aws-iot",
        AWS_IOT_ENDPOINT: "example-ats.iot.ap-northeast-1.amazonaws.com",
        AWS_IOT_ROOT_CA_PATH: "/credentials/AmazonRootCA1.pem",
        AWS_IOT_TELEMETRY_INGESTOR_CERTIFICATE_PATH:
          "/credentials/telemetry-ingestor/device.pem.crt",
        AWS_IOT_TELEMETRY_INGESTOR_PRIVATE_KEY_PATH:
          "/credentials/telemetry-ingestor/private.pem.key",
        AWS_IOT_TELEMETRY_INGESTOR_CLIENT_ID:
          "drone-fleet-dev-telemetry-ingestor",
      }).mqttTransport,
    ).toEqual({
      type: "aws-iot",
      endpoint: "example-ats.iot.ap-northeast-1.amazonaws.com",
      rootCaPath: "/credentials/AmazonRootCA1.pem",
      certificatePath: "/credentials/telemetry-ingestor/device.pem.crt",
      privateKeyPath: "/credentials/telemetry-ingestor/private.pem.key",
      clientId: "drone-fleet-dev-telemetry-ingestor",
    });
  });

  it.each([
    [
      "endpoint",
      {
        AWS_IOT_ROOT_CA_PATH: "/ca",
        AWS_IOT_TELEMETRY_INGESTOR_CERTIFICATE_PATH: "/cert",
        AWS_IOT_TELEMETRY_INGESTOR_PRIVATE_KEY_PATH: "/key",
        AWS_IOT_TELEMETRY_INGESTOR_CLIENT_ID: "ingestor",
      },
    ],
    [
      "root CA",
      {
        AWS_IOT_ENDPOINT: "example.iot",
        AWS_IOT_TELEMETRY_INGESTOR_CERTIFICATE_PATH: "/cert",
        AWS_IOT_TELEMETRY_INGESTOR_PRIVATE_KEY_PATH: "/key",
        AWS_IOT_TELEMETRY_INGESTOR_CLIENT_ID: "ingestor",
      },
    ],
    [
      "certificate",
      {
        AWS_IOT_ENDPOINT: "example.iot",
        AWS_IOT_ROOT_CA_PATH: "/ca",
        AWS_IOT_TELEMETRY_INGESTOR_PRIVATE_KEY_PATH: "/key",
        AWS_IOT_TELEMETRY_INGESTOR_CLIENT_ID: "ingestor",
      },
    ],
    [
      "private key",
      {
        AWS_IOT_ENDPOINT: "example.iot",
        AWS_IOT_ROOT_CA_PATH: "/ca",
        AWS_IOT_TELEMETRY_INGESTOR_CERTIFICATE_PATH: "/cert",
        AWS_IOT_TELEMETRY_INGESTOR_CLIENT_ID: "ingestor",
      },
    ],
    [
      "client ID",
      {
        AWS_IOT_ENDPOINT: "example.iot",
        AWS_IOT_ROOT_CA_PATH: "/ca",
        AWS_IOT_TELEMETRY_INGESTOR_CERTIFICATE_PATH: "/cert",
        AWS_IOT_TELEMETRY_INGESTOR_PRIVATE_KEY_PATH: "/key",
      },
    ],
  ])("requires the AWS IoT %s", (_name, awsEnvironment) => {
    expect(() =>
      loadTelemetryIngestorConfig({
        MQTT_TRANSPORT: "aws-iot",
        ...awsEnvironment,
      }),
    ).toThrow(TypeError);
  });

  it("reads telemetry batch settings", () => {
    expect(
      loadTelemetryIngestorConfig({
        TELEMETRY_BATCH_SIZE: "25",
        TELEMETRY_FLUSH_INTERVAL_MS: "100",
        TELEMETRY_MAX_BUFFER_SIZE: "500",
      }),
    ).toMatchObject({
      telemetryBatchSize: 25,
      telemetryFlushIntervalMs: 100,
      telemetryMaxBufferSize: 500,
    });
  });

  it("enables load metrics only when explicitly configured", () => {
    expect(
      loadTelemetryIngestorConfig({
        LOAD_METRICS_ENABLED: "true",
        LOAD_TEST_ID: "local-1000",
        LOAD_SESSION_ID: "ingestor-a",
      }).loadMetrics,
    ).toEqual({
      testId: "local-1000",
      sessionId: "ingestor-a",
      reportPath: "load-results/local-1000-ingestor-a-ingestor.json",
    });
  });

  it("allows the metrics report path to be overridden", () => {
    expect(
      loadTelemetryIngestorConfig({
        LOAD_METRICS_ENABLED: "true",
        LOAD_TEST_ID: "local-1000",
        LOAD_SESSION_ID: "ingestor-a",
        LOAD_METRICS_REPORT_PATH: "/tmp/ingestor.json",
      }).loadMetrics?.reportPath,
    ).toBe("/tmp/ingestor.json");
  });

  it("reads the load measurement window", () => {
    expect(
      loadTelemetryIngestorConfig({
        LOAD_METRICS_ENABLED: "true",
        LOAD_TEST_ID: "local-1000",
        LOAD_SESSION_ID: "ingestor-a",
        LOAD_MEASUREMENT_START_AT: "2026-10-01T00:00:10.000Z",
        LOAD_MEASUREMENT_END_AT: "2026-10-01T00:00:40.000Z",
      }).loadMetrics,
    ).toMatchObject({
      measurementStartAt: new Date("2026-10-01T00:00:10.000Z"),
      measurementEndAt: new Date("2026-10-01T00:00:40.000Z"),
    });
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
        AWS_IOT_TELEMETRY_INGESTOR_CERTIFICATE_PATH: "/cert",
        AWS_IOT_TELEMETRY_INGESTOR_PRIVATE_KEY_PATH: "/key",
        AWS_IOT_TELEMETRY_INGESTOR_CLIENT_ID: "ingestor",
      },
    ],
    ["zero port", { MQTT_PORT: "0" }],
    ["non-integer port", { MQTT_PORT: "1883.5" }],
    ["zero timeout", { OFFLINE_TIMEOUT_MS: "0" }],
    ["non-integer timeout", { OFFLINE_TIMEOUT_MS: "15000.5" }],
    ["zero batch size", { TELEMETRY_BATCH_SIZE: "0" }],
    ["invalid flush interval", { TELEMETRY_FLUSH_INTERVAL_MS: "1.5" }],
    ["zero buffer size", { TELEMETRY_MAX_BUFFER_SIZE: "0" }],
    ["invalid metrics flag", { LOAD_METRICS_ENABLED: "1" }],
    ["missing test ID", { LOAD_METRICS_ENABLED: "true" }],
    [
      "invalid session ID",
      {
        LOAD_METRICS_ENABLED: "true",
        LOAD_TEST_ID: "test-1",
        LOAD_SESSION_ID: "invalid id",
      },
    ],
  ])("rejects %s", (_name, environment) => {
    expect(() => loadTelemetryIngestorConfig(environment)).toThrow(TypeError);
  });
});
