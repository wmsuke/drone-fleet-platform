import { describe, expect, it, vi } from "vitest";

import { createTelemetryMqttConnectionConfig } from "../src/mqtt-transport.js";

describe("createTelemetryMqttConnectionConfig", () => {
  it("keeps the existing local connection", async () => {
    await expect(
      createTelemetryMqttConnectionConfig({
        type: "local",
        url: "mqtt://127.0.0.1:1883",
      }),
    ).resolves.toEqual({
      url: "mqtt://127.0.0.1:1883",
      clientOptions: {
        clean: true,
        clientId: "telemetry-ingestor",
        resubscribe: true,
      },
    });
  });

  it("loads the dedicated AWS backend certificate and enables resubscription", async () => {
    const readCredentialFile = vi.fn(async (path: string) => Buffer.from(path));
    const connection = await createTelemetryMqttConnectionConfig(
      {
        type: "aws-iot",
        endpoint: "example-ats.iot.ap-northeast-1.amazonaws.com",
        rootCaPath: "/credentials/AmazonRootCA1.pem",
        certificatePath: "/credentials/telemetry-ingestor/device.pem.crt",
        privateKeyPath: "/credentials/telemetry-ingestor/private.pem.key",
        clientId: "drone-fleet-dev-telemetry-ingestor",
      },
      readCredentialFile,
    );

    expect(readCredentialFile).toHaveBeenCalledTimes(3);
    expect(connection).toMatchObject({
      url: "mqtts://example-ats.iot.ap-northeast-1.amazonaws.com:8883",
      clientOptions: {
        clean: true,
        clientId: "drone-fleet-dev-telemetry-ingestor",
        reconnectPeriod: 1_000,
        rejectUnauthorized: true,
        resubscribe: true,
        servername: "example-ats.iot.ap-northeast-1.amazonaws.com",
      },
    });
  });

  it("reports an unreadable private key without exposing its path", async () => {
    const privateKeyPath = "/secret/telemetry-ingestor/private.pem.key";
    const readCredentialFile = vi.fn(async (path: string) => {
      if (path === privateKeyPath) throw new Error(`ENOENT: ${path}`);
      return Buffer.from("credential");
    });

    let thrown: unknown;
    try {
      await createTelemetryMqttConnectionConfig(
        {
          type: "aws-iot",
          endpoint: "example.iot",
          rootCaPath: "/secret/root-ca.pem",
          certificatePath: "/secret/telemetry-ingestor/device.pem.crt",
          privateKeyPath,
          clientId: "ingestor",
        },
        readCredentialFile,
      );
    } catch (error) {
      thrown = error;
    }

    expect(String(thrown)).toContain("telemetry-ingestorのAWS IoT秘密鍵");
    expect(String(thrown)).not.toContain(privateKeyPath);
    expect(thrown).not.toHaveProperty("cause");
  });
});
