import { connectAsync, type IClientOptions } from "mqtt";

import type { TelemetryIngestorConfig } from "./config.js";
import { ingestTelemetry, type IngestionLogger } from "./ingestion.js";
import type { TelemetryRepository } from "./repository.js";

export const TELEMETRY_TOPIC_FILTER = "fleet/v1/devices/+/telemetry";

export interface TelemetryMqttClient {
  endAsync(force?: boolean): Promise<void>;
  on(
    event: "message",
    listener: (topic: string, payload: Buffer) => void,
  ): this;
  on(event: "error", listener: (error: Error) => void): this;
  subscribeAsync(topic: string, options: { qos: 0 }): Promise<unknown>;
}

export type ConnectTelemetryClient = (
  url: string,
  options: IClientOptions,
) => Promise<TelemetryMqttClient>;

export interface RunningTelemetryIngestor {
  shutdown(): Promise<void>;
}

export async function startTelemetryIngestor(
  config: TelemetryIngestorConfig,
  repository: TelemetryRepository,
  logger: IngestionLogger = console,
  connectClient: ConnectTelemetryClient = connectAsync,
): Promise<RunningTelemetryIngestor> {
  const client = await connectClient(config.mqttUrl, {
    clean: true,
    clientId: "telemetry-ingestor",
  });

  client.on("error", (error) => {
    logger.error("MQTT接続でエラーが発生しました", { error });
  });
  client.on("message", (topic, payload) => {
    void ingestTelemetry(topic, payload, new Date(), repository, logger);
  });

  try {
    await client.subscribeAsync(TELEMETRY_TOPIC_FILTER, { qos: 0 });
  } catch (error) {
    await client.endAsync(true);
    throw error;
  }

  return {
    async shutdown() {
      await client.endAsync(false);
    },
  };
}
