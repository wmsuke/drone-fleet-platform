import { describe, expect, it } from "vitest";

import { loadApiConfig } from "../src/config.js";

describe("loadApiConfig", () => {
  it("uses local defaults", () => {
    expect(loadApiConfig({})).toEqual({
      dashboardOrigin: null,
      host: "127.0.0.1",
      port: 3000,
      mqttTransport: {
        type: "local",
        url: "mqtt://127.0.0.1:1883",
      },
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
      mqttTransport: { type: "local", url: "mqtt://mqtt:2883" },
    });
  });

  it("reads the AWS IoT transport", () => {
    expect(
      loadApiConfig({
        MQTT_TRANSPORT: "aws-iot",
        AWS_IOT_ENDPOINT: "example-ats.iot.ap-northeast-1.amazonaws.com",
        AWS_IOT_ROOT_CA_PATH: "/credentials/AmazonRootCA1.pem",
        AWS_IOT_API_CERTIFICATE_PATH: "/credentials/api/device.pem.crt",
        AWS_IOT_API_PRIVATE_KEY_PATH: "/credentials/api/private.pem.key",
        AWS_IOT_API_CLIENT_ID: "drone-fleet-dev-api",
      }),
    ).toMatchObject({
      mqttTransport: {
        type: "aws-iot",
        endpoint: "example-ats.iot.ap-northeast-1.amazonaws.com",
        rootCaPath: "/credentials/AmazonRootCA1.pem",
        certificatePath: "/credentials/api/device.pem.crt",
        privateKeyPath: "/credentials/api/private.pem.key",
        clientId: "drone-fleet-dev-api",
      },
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
    ["invalid MQTT transport", { MQTT_TRANSPORT: "cloud" }],
    [
      "AWS endpoint with protocol",
      {
        MQTT_TRANSPORT: "aws-iot",
        AWS_IOT_ENDPOINT: "mqtts://example.iot",
        AWS_IOT_ROOT_CA_PATH: "ca",
        AWS_IOT_API_CERTIFICATE_PATH: "cert",
        AWS_IOT_API_PRIVATE_KEY_PATH: "key",
        AWS_IOT_API_CLIENT_ID: "api",
      },
    ],
    [
      "missing AWS API private key",
      {
        MQTT_TRANSPORT: "aws-iot",
        AWS_IOT_ENDPOINT: "example.iot",
        AWS_IOT_ROOT_CA_PATH: "ca",
        AWS_IOT_API_CERTIFICATE_PATH: "cert",
        AWS_IOT_API_CLIENT_ID: "api",
      },
    ],
    [
      "invalid AWS API clientId",
      {
        MQTT_TRANSPORT: "aws-iot",
        AWS_IOT_ENDPOINT: "example.iot",
        AWS_IOT_ROOT_CA_PATH: "ca",
        AWS_IOT_API_CERTIFICATE_PATH: "cert",
        AWS_IOT_API_PRIVATE_KEY_PATH: "key",
        AWS_IOT_API_CLIENT_ID: "api.invalid",
      },
    ],
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
