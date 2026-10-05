import { readFile } from "node:fs/promises";

import type { IClientOptions } from "mqtt";

import type { TelemetryMqttTransportConfig } from "./config.js";

export interface TelemetryMqttConnectionConfig {
  clientOptions: IClientOptions;
  url: string;
}

export type ReadCredentialFile = (path: string) => Promise<Buffer>;

async function readCredential(
  path: string,
  description: string,
  readCredentialFile: ReadCredentialFile,
): Promise<Buffer> {
  try {
    const value = await readCredentialFile(path);
    if (value.length === 0) throw new Error("empty credential");
    return value;
  } catch {
    throw new TypeError(`${description}を読み込めません`);
  }
}

export async function createTelemetryMqttConnectionConfig(
  transport: TelemetryMqttTransportConfig,
  readCredentialFile: ReadCredentialFile = readFile,
): Promise<TelemetryMqttConnectionConfig> {
  if (transport.type === "local") {
    return {
      url: transport.url,
      clientOptions: {
        clean: true,
        clientId: "telemetry-ingestor",
        resubscribe: true,
      },
    };
  }

  const [ca, cert, key] = await Promise.all([
    readCredential(transport.rootCaPath, "AWS IoT root CA", readCredentialFile),
    readCredential(
      transport.certificatePath,
      "telemetry-ingestorのAWS IoTクライアント証明書",
      readCredentialFile,
    ),
    readCredential(
      transport.privateKeyPath,
      "telemetry-ingestorのAWS IoT秘密鍵",
      readCredentialFile,
    ),
  ]);

  return {
    url: `mqtts://${transport.endpoint}:8883`,
    clientOptions: {
      ca,
      cert,
      clean: true,
      clientId: transport.clientId,
      key,
      reconnectPeriod: 1_000,
      rejectUnauthorized: true,
      resubscribe: true,
      servername: transport.endpoint,
    },
  };
}
