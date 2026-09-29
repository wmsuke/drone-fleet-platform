import { connectAsync, type IClientOptions, type IPublishPacket } from "mqtt";

import type { TelemetryIngestorConfig } from "./config.js";
import { ingestTelemetry, type IngestionLogger } from "./ingestion.js";
import type { TelemetryRepository } from "./repository.js";
import { ingestStatus, type DeviceStatusRepository } from "./status.js";

export const TELEMETRY_TOPIC_FILTER = "fleet/v1/devices/+/telemetry";
export const STATUS_TOPIC_FILTER = "fleet/v1/devices/+/status";

export interface TelemetryMqttClient {
  endAsync(force?: boolean): Promise<void>;
  on(
    event: "message",
    listener: (topic: string, payload: Buffer, packet: IPublishPacket) => void,
  ): this;
  on(event: "error", listener: (error: Error) => void): this;
  subscribeAsync(topic: string, options: { qos: 0 | 1 }): Promise<unknown>;
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
  statusRepository: DeviceStatusRepository,
  logger: IngestionLogger = console,
  connectClient: ConnectTelemetryClient = connectAsync,
): Promise<RunningTelemetryIngestor> {
  const client = await connectClient(config.mqttUrl, {
    clean: true,
    clientId: "telemetry-ingestor",
  });
  const inFlight = new Set<Promise<unknown>>();

  client.on("error", (error) => {
    logger.error("MQTT接続でエラーが発生しました", { error });
  });
  client.on("message", (topic, payload, packet) => {
    const receivedAt = new Date();
    const task = topic.endsWith("/status")
      ? ingestStatus(
          topic,
          payload,
          receivedAt,
          packet.retain,
          statusRepository,
          logger,
        )
      : ingestTelemetry(
          topic,
          payload,
          receivedAt,
          repository,
          logger,
          packet.retain,
        );
    inFlight.add(task);
    void task.finally(() => {
      inFlight.delete(task);
    });
  });

  try {
    await client.subscribeAsync(TELEMETRY_TOPIC_FILTER, { qos: 0 });
    await client.subscribeAsync(STATUS_TOPIC_FILTER, { qos: 1 });
  } catch (error) {
    await client.endAsync(true);
    throw error;
  }

  const timeoutTimer = setInterval(
    () => {
      const updatedAt = new Date();
      const cutoff = new Date(updatedAt.getTime() - config.offlineTimeoutMs);
      const task = statusRepository.markTimedOut(cutoff, updatedAt);
      inFlight.add(task);
      void task
        .catch((error: unknown) => {
          logger.error("接続状態のタイムアウト更新に失敗しました", { error });
        })
        .finally(() => {
          inFlight.delete(task);
        });
    },
    Math.min(config.offlineTimeoutMs, 1_000),
  );

  return {
    async shutdown() {
      clearInterval(timeoutTimer);
      let disconnectError: unknown;
      try {
        await client.endAsync(false);
      } catch (error) {
        disconnectError = error;
      }

      await Promise.allSettled([...inFlight]);

      if (disconnectError !== undefined) {
        throw disconnectError;
      }
    },
  };
}
