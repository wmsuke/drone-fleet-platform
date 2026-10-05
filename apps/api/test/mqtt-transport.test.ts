import { describe, expect, it, vi } from "vitest";

import {
  connectApiMqttClient,
  createApiMqttConnectionConfig,
} from "../src/mqtt-transport.js";

describe("createApiMqttConnectionConfig", () => {
  it("keeps the existing local connection", async () => {
    await expect(
      createApiMqttConnectionConfig({
        type: "local",
        url: "mqtt://127.0.0.1:1883",
      }),
    ).resolves.toEqual({
      url: "mqtt://127.0.0.1:1883",
      clientOptions: { clean: true, clientId: "fleet-api" },
    });
  });

  it("loads the dedicated AWS API certificate", async () => {
    const readCredentialFile = vi.fn(async (path: string) => Buffer.from(path));
    const connection = await createApiMqttConnectionConfig(
      {
        type: "aws-iot",
        endpoint: "example-ats.iot.ap-northeast-1.amazonaws.com",
        rootCaPath: "/credentials/AmazonRootCA1.pem",
        certificatePath: "/credentials/api/device.pem.crt",
        privateKeyPath: "/credentials/api/private.pem.key",
        clientId: "drone-fleet-dev-api",
      },
      readCredentialFile,
    );

    expect(readCredentialFile).toHaveBeenCalledTimes(3);
    expect(connection).toMatchObject({
      url: "mqtts://example-ats.iot.ap-northeast-1.amazonaws.com:8883",
      clientOptions: {
        clean: true,
        clientId: "drone-fleet-dev-api",
        reconnectPeriod: 1_000,
        rejectUnauthorized: true,
        servername: "example-ats.iot.ap-northeast-1.amazonaws.com",
      },
    });
  });

  it("reports an unreadable private key without exposing its path", async () => {
    const privateKeyPath = "/secret/api/private.pem.key";
    const readCredentialFile = vi.fn(async (path: string) => {
      if (path === privateKeyPath) throw new Error(`ENOENT: ${path}`);
      return Buffer.from("credential");
    });

    let thrown: unknown;
    try {
      await createApiMqttConnectionConfig(
        {
          type: "aws-iot",
          endpoint: "example.iot",
          rootCaPath: "/secret/root-ca.pem",
          certificatePath: "/secret/api/device.pem.crt",
          privateKeyPath,
          clientId: "api",
        },
        readCredentialFile,
      );
    } catch (error) {
      thrown = error;
    }

    expect(String(thrown)).toContain("APIのAWS IoT秘密鍵");
    expect(String(thrown)).not.toContain(privateKeyPath);
    expect(thrown).not.toHaveProperty("cause");
  });
});

describe("connectApiMqttClient", () => {
  it("fails the initial connection instead of retrying forever", async () => {
    const error = new Error("connection refused");
    const connect = vi.fn(async () => {
      throw error;
    });

    await expect(
      connectApiMqttClient(
        {
          url: "mqtts://example.iot:8883",
          clientOptions: { clientId: "api" },
        },
        connect,
      ),
    ).rejects.toBe(error);
    expect(connect).toHaveBeenCalledWith(
      "mqtts://example.iot:8883",
      { clientId: "api" },
      false,
    );
  });
});
