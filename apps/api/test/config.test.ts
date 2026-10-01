import { describe, expect, it } from "vitest";

import { loadApiConfig } from "../src/config.js";

describe("loadApiConfig", () => {
  it("uses local defaults", () => {
    expect(loadApiConfig({})).toEqual({
      dashboardOrigin: null,
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
        DASHBOARD_ORIGIN: "https://dashboard.example.test/",
        MQTT_HOST: "mqtt",
        MQTT_PORT: "2883",
      }),
    ).toEqual({
      dashboardOrigin: "https://dashboard.example.test",
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
    ["empty dashboard origin", { DASHBOARD_ORIGIN: "" }],
    ["invalid dashboard origin", { DASHBOARD_ORIGIN: "localhost:5173" }],
    [
      "dashboard URL with a path",
      { DASHBOARD_ORIGIN: "http://localhost:5173/dashboard" },
    ],
  ])("rejects %s", (_name, environment) => {
    expect(() => loadApiConfig(environment)).toThrow(TypeError);
  });
});
