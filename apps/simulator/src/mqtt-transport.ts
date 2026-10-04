import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { IClientOptions } from "mqtt";

import type { SimulatorMqttTransportConfig } from "./config.js";

export interface DeviceMqttConnectionConfig {
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
    if (value.length === 0) {
      throw new Error("empty credential");
    }
    return value;
  } catch {
    throw new TypeError(`${description}を読み込めません`);
  }
}

export async function createDeviceMqttConnectionConfig(
  transport: SimulatorMqttTransportConfig,
  deviceId: string,
  readCredentialFile: ReadCredentialFile = readFile,
): Promise<DeviceMqttConnectionConfig> {
  if (transport.type === "local") {
    return {
      url: transport.url,
      clientOptions: {
        clean: true,
        clientId: `simulator-${deviceId}`,
      },
    };
  }

  const credentialDirectory = join(
    transport.deviceCredentialsDirectory,
    deviceId,
  );
  const [ca, cert, key] = await Promise.all([
    readCredential(transport.rootCaPath, "AWS IoT root CA", readCredentialFile),
    readCredential(
      join(credentialDirectory, "device.pem.crt"),
      `${deviceId}のAWS IoTクライアント証明書`,
      readCredentialFile,
    ),
    readCredential(
      join(credentialDirectory, "private.pem.key"),
      `${deviceId}のAWS IoT秘密鍵`,
      readCredentialFile,
    ),
  ]);

  return {
    url: `mqtts://${transport.endpoint}:8883`,
    clientOptions: {
      ca,
      cert,
      clean: true,
      clientId: deviceId,
      key,
      rejectUnauthorized: true,
      reconnectPeriod: 1_000,
      servername: transport.endpoint,
    },
  };
}
