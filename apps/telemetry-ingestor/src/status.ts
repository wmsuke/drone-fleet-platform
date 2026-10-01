import {
  connectionStatusMessageSchema,
  parseMqttTopic,
  type ConnectionStatusMessage,
} from "@drone-fleet/protocol";
import { and, eq, isNull, lte, or } from "drizzle-orm";
import { devices, type Database } from "@drone-fleet/database";

import {
  ensureDeviceRegistered,
  upsertDeviceReceipt,
} from "./device-repository.js";
import type { IngestionLogger } from "./ingestion.js";
import type { LoadMetrics } from "./metrics.js";

export interface DeviceStatusRepository {
  saveStatus(
    message: ConnectionStatusMessage,
    receivedAt: Date,
    isRetained: boolean,
  ): Promise<number>;
  markTimedOut(cutoff: Date, updatedAt: Date): Promise<number>;
}

export function createDeviceStatusRepository(
  database: Database,
): DeviceStatusRepository {
  return {
    async saveStatus(message, receivedAt, isRetained) {
      if (isRetained && message.payload.status === "ONLINE") {
        await ensureDeviceRegistered(database, message.deviceId);
        return 0;
      }
      if (message.payload.status === "ONLINE") {
        await upsertDeviceReceipt(
          database,
          message.deviceId,
          receivedAt,
          message.payload.status,
        );
        return 0;
      }
      return database.transaction(async (transaction) => {
        const transitioned = await transaction
          .update(devices)
          .set({ connectionStatus: "OFFLINE" })
          .where(
            and(
              eq(devices.deviceId, message.deviceId),
              eq(devices.connectionStatus, "ONLINE"),
              or(
                isNull(devices.lastReceivedAt),
                lte(devices.lastReceivedAt, receivedAt),
              ),
            ),
          )
          .returning({ deviceId: devices.deviceId });
        await upsertDeviceReceipt(
          transaction,
          message.deviceId,
          receivedAt,
          message.payload.status,
        );
        return transitioned.length;
      });
    },
    async markTimedOut(cutoff, updatedAt) {
      const transitioned = await database
        .update(devices)
        .set({ connectionStatus: "OFFLINE", updatedAt })
        .where(
          and(
            eq(devices.connectionStatus, "ONLINE"),
            lte(devices.lastReceivedAt, cutoff),
          ),
        )
        .returning({ deviceId: devices.deviceId });
      return transitioned.length;
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
  metrics?: LoadMetrics,
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
    const offlineTransitions = await repository.saveStatus(
      parsed.data,
      receivedAt,
      isRetained,
    );
    metrics?.recordOfflineTransitions(offlineTransitions);
    return true;
  } catch (error) {
    logger.error("接続状態の保存に失敗しました", { error, topic });
    return false;
  }
}
