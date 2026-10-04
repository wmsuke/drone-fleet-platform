import { describe, expect, it, vi } from "vitest";

import { createDeviceMqttConnectionConfig } from "../src/mqtt-transport.js";

describe("createDeviceMqttConnectionConfig", () => {
  it("keeps the existing unauthenticated local connection", async () => {
    await expect(
      createDeviceMqttConnectionConfig(
        { type: "local", url: "mqtt://127.0.0.1:1883" },
        "drone-001",
      ),
    ).resolves.toEqual({
      url: "mqtt://127.0.0.1:1883",
      clientOptions: {
        clean: true,
        clientId: "simulator-drone-001",
      },
    });
  });

  it("loads the certificate and private key belonging to each AWS device", async () => {
    const readCredentialFile = vi.fn(async (path: string) => Buffer.from(path));

    const connection = await createDeviceMqttConnectionConfig(
      {
        type: "aws-iot",
        endpoint: "example-ats.iot.ap-northeast-1.amazonaws.com",
        rootCaPath: "/credentials/AmazonRootCA1.pem",
        deviceCredentialsDirectory: "/credentials/devices",
      },
      "dev-drone-002",
      readCredentialFile,
    );

    expect(readCredentialFile.mock.calls.map(([path]) => path)).toEqual([
      "/credentials/AmazonRootCA1.pem",
      "/credentials/devices/dev-drone-002/device.pem.crt",
      "/credentials/devices/dev-drone-002/private.pem.key",
    ]);
    expect(connection).toMatchObject({
      url: "mqtts://example-ats.iot.ap-northeast-1.amazonaws.com:8883",
      clientOptions: {
        clean: true,
        clientId: "dev-drone-002",
        rejectUnauthorized: true,
        reconnectPeriod: 1_000,
        servername: "example-ats.iot.ap-northeast-1.amazonaws.com",
      },
    });
    expect(connection.clientOptions.ca).toEqual(
      Buffer.from("/credentials/AmazonRootCA1.pem"),
    );
    expect(connection.clientOptions.cert).toEqual(
      Buffer.from("/credentials/devices/dev-drone-002/device.pem.crt"),
    );
    expect(connection.clientOptions.key).toEqual(
      Buffer.from("/credentials/devices/dev-drone-002/private.pem.key"),
    );
  });

  it("reports a missing credential without exposing its path or underlying error", async () => {
    const privateKeyPath = "/secret/credentials/dev-drone-001/private.pem.key";
    const readCredentialFile = vi.fn(async (path: string) => {
      if (path === privateKeyPath) {
        throw new Error(`ENOENT: ${privateKeyPath}`);
      }
      return Buffer.from("credential");
    });

    await expect(
      createDeviceMqttConnectionConfig(
        {
          type: "aws-iot",
          endpoint: "example.iot",
          rootCaPath: "/ca",
          deviceCredentialsDirectory: "/secret/credentials",
        },
        "dev-drone-001",
        readCredentialFile,
      ),
    ).rejects.toThrow("dev-drone-001のAWS IoT秘密鍵を読み込めません");

    try {
      await createDeviceMqttConnectionConfig(
        {
          type: "aws-iot",
          endpoint: "example.iot",
          rootCaPath: "/ca",
          deviceCredentialsDirectory: "/secret/credentials",
        },
        "dev-drone-001",
        readCredentialFile,
      );
    } catch (error) {
      expect(String(error)).not.toContain(privateKeyPath);
      expect(error).not.toHaveProperty("cause");
    }
  });
});
