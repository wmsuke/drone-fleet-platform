import {
  connectionStatusMessageSchema,
  parseMqttTopic,
  type ConnectionStatusMessage,
} from "@drone-fleet/protocol";
import { and, eq, lte } from "drizzle-orm";
import { devices, type Database } from "@drone-fleet/database";

import {
  upsertDeviceReceipt,
  type DeviceConnectionStatus,
} from "./device-repository.js";
import type { IngestionLogger } from "./ingestion.js";

export interface DeviceStatusRepository {
  saveStatus(
    message: ConnectionStatusMessage,
    receivedAt: Date,
    isRetained: boolean,
  ): Promise<void>;
  markTimedOut(cutoff: Date, updatedAt: Date): Promise<void>;
}

export function createDeviceStatusRepository(
  database: Database,
): DeviceStatusRepository {
  return {
    async saveStatus(message, receivedAt, isRetained) {
      const status: DeviceConnectionStatus | undefined =
        isRetained && message.payload.status === "ONLINE"
          ? undefined
          : message.payload.status;
      await upsertDeviceReceipt(database, message.deviceId, receivedAt, status);
    },
    async markTimedOut(cutoff, updatedAt) {
      await database
        .update(devices)
        .set({ connectionStatus: "OFFLINE", updatedAt })
        .where(
          and(
            eq(devices.connectionStatus, "ONLINE"),
            lte(devices.lastReceivedAt, cutoff),
          ),
        );
    },
  };
}

export async function ingestStatus(
  topic: string,
  payload: Buffer,
  receivedAt: Date,
  isRetained: boolean,
  repository: DeviceStatusRepository,
  logger: IngestionLogger,
): Promise<boolean> {
  const parsedTopic = parseMqttTopic(topic);
  let input: unknown;
  try {
    input = JSON.parse(payload.toString("utf8"));
  } catch {
    logger.warn("接続状態を保存しませんでした", {
      reason: "本文が有効なJSONではありません",
      topic,
    });
    return false;
  }
  const parsed = connectionStatusMessageSchema.safeParse(input);
  if (
    parsedTopic === null ||
    parsedTopic.kind !== "status" ||
    !parsed.success ||
    parsed.data.deviceId !== parsedTopic.deviceId
  ) {
    logger.warn("接続状態を保存しませんでした", {
      reason: "トピックまたは本文が接続状態の仕様に一致しません",
      topic,
    });
    return false;
  }
  try {
    await repository.saveStatus(parsed.data, receivedAt, isRetained);
    return true;
  } catch (error) {
    logger.error("接続状態の保存に失敗しました", { error, topic });
    return false;
  }
}
