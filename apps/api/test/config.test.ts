import { describe, expect, it } from "vitest";

import { loadApiConfig } from "../src/config.js";

describe("loadApiConfig", () => {
  it("uses local defaults", () => {
    expect(loadApiConfig({})).toEqual({
      host: "127.0.0.1",
      port: 3000,
      mqttUrl: "mqtt://127.0.0.1:1883",
    });
  });

  it("reads host and port", () => {
    expect(
      loadApiConfig({
        API_HOST: "0.0.0.0",
        API_PORT: "4000",
        MQTT_HOST: "mqtt",
        MQTT_PORT: "2883",
      }),
    ).toEqual({
      host: "0.0.0.0",
      port: 4000,
      mqttUrl: "mqtt://mqtt:2883",
    });
  });

  it.each(["0", "65536", "3000.5", "invalid"])(
    "rejects invalid port %s",
    (port) => {
      expect(() => loadApiConfig({ API_PORT: port })).toThrow(TypeError);
    },
  );

  it.each([
    ["empty MQTT host", { MQTT_HOST: "" }],
    ["invalid MQTT port", { MQTT_PORT: "0" }],
  ])("rejects %s", (_name, environment) => {
    expect(() => loadApiConfig(environment)).toThrow(TypeError);
  });
});
