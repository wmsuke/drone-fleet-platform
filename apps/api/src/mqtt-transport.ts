import { readFile } from "node:fs/promises";

import { connectAsync, type IClientOptions, type MqttClient } from "mqtt";

import type { ApiMqttTransportConfig } from "./config.js";

export interface ApiMqttConnectionConfig {
  clientOptions: IClientOptions;
  url: string;
}

export type ReadCredentialFile = (path: string) => Promise<Buffer>;
export type ConnectAsync = (
  url: string,
  options: IClientOptions,
  allowRetries: boolean,
) => Promise<MqttClient>;

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

export async function createApiMqttConnectionConfig(
  transport: ApiMqttTransportConfig,
  readCredentialFile: ReadCredentialFile = readFile,
): Promise<ApiMqttConnectionConfig> {
  if (transport.type === "local") {
    return {
      url: transport.url,
      clientOptions: { clean: true, clientId: "fleet-api" },
    };
  }

  const [ca, cert, key] = await Promise.all([
    readCredential(transport.rootCaPath, "AWS IoT root CA", readCredentialFile),
    readCredential(
      transport.certificatePath,
      "APIのAWS IoTクライアント証明書",
      readCredentialFile,
    ),
    readCredential(
      transport.privateKeyPath,
      "APIのAWS IoT秘密鍵",
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
      servername: transport.endpoint,
    },
  };
}

export async function connectApiMqttClient(
  connection: ApiMqttConnectionConfig,
  mqttConnectAsync: ConnectAsync = connectAsync,
): Promise<MqttClient> {
  return mqttConnectAsync(connection.url, connection.clientOptions, false);
}
