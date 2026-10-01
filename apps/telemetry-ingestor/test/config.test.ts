import { describe, expect, it } from "vitest";

import { loadTelemetryIngestorConfig } from "../src/config.js";

describe("loadTelemetryIngestorConfig", () => {
  it("uses local MQTT defaults", () => {
    expect(loadTelemetryIngestorConfig({})).toEqual({
      mqttUrl: "mqtt://127.0.0.1:1883",
      offlineTimeoutMs: 15_000,
    });
  });

  it("reads the MQTT host and port", () => {
    expect(
      loadTelemetryIngestorConfig({
        MQTT_HOST: "mqtt",
        MQTT_PORT: "2883",
        OFFLINE_TIMEOUT_MS: "30000",
      }),
    ).toEqual({ mqttUrl: "mqtt://mqtt:2883", offlineTimeoutMs: 30_000 });
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

  it.each([
    ["empty host", { MQTT_HOST: "" }],
    ["zero port", { MQTT_PORT: "0" }],
    ["non-integer port", { MQTT_PORT: "1883.5" }],
    ["zero timeout", { OFFLINE_TIMEOUT_MS: "0" }],
    ["non-integer timeout", { OFFLINE_TIMEOUT_MS: "15000.5" }],
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
