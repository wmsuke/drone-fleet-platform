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

  it.each([
    ["empty host", { MQTT_HOST: "" }],
    ["zero port", { MQTT_PORT: "0" }],
    ["non-integer port", { MQTT_PORT: "1883.5" }],
    ["zero timeout", { OFFLINE_TIMEOUT_MS: "0" }],
    ["non-integer timeout", { OFFLINE_TIMEOUT_MS: "15000.5" }],
  ])("rejects %s", (_name, environment) => {
    expect(() => loadTelemetryIngestorConfig(environment)).toThrow(TypeError);
  });
});
