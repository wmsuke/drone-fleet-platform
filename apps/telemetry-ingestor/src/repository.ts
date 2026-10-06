import {
  devices,
  telemetry,
  type Database,
  type NewTelemetry,
} from "@drone-fleet/database";
import type { TelemetryMessage } from "@drone-fleet/protocol";
import { sql } from "drizzle-orm";

export interface TelemetryBatchEntry {
  message: TelemetryMessage;
  receivedAt: Date;
  isRetained: boolean;
}

export interface TelemetryRepository {
  saveBatch(entries: readonly TelemetryBatchEntry[]): Promise<void>;
}

export function toNewTelemetry(
  message: TelemetryMessage,
  receivedAt: Date,
): NewTelemetry {
  return {
    deviceId: message.deviceId,
    sessionId: message.schemaVersion === 2 ? message.sessionId : null,
    sequence: message.sequence,
    deviceTimestamp: new Date(message.timestamp),
    receivedAt,
    battery: message.payload.battery,
    latitude: message.payload.latitude,
    longitude: message.payload.longitude,
    altitude: message.payload.altitude,
    temperature: message.payload.temperature,
    flightStatus: message.payload.status,
  };
}

export function createTelemetryRepository(
  database: Database,
): TelemetryRepository {
  return {
    async saveBatch(entries) {
      if (entries.length === 0) return;
      await database.transaction(async (transaction) => {
        const deviceReceipts = new Map<string, Date>();
        for (const entry of entries) {
          if (entry.isRetained) continue;
          const current = deviceReceipts.get(entry.message.deviceId);
          if (current === undefined || entry.receivedAt > current) {
            deviceReceipts.set(entry.message.deviceId, entry.receivedAt);
          }
        }

        if (deviceReceipts.size > 0) {
          await transaction
            .insert(devices)
            .values(
              [...deviceReceipts].map(([deviceId, receivedAt]) => ({
                deviceId,
                connectionStatus: "ONLINE" as const,
                lastReceivedAt: receivedAt,
                updatedAt: receivedAt,
              })),
            )
            .onConflictDoUpdate({
              target: devices.deviceId,
              set: {
                lastReceivedAt: sql`greatest(coalesce(${devices.lastReceivedAt}, excluded.last_received_at), excluded.last_received_at)`,
                updatedAt: sql`greatest(${devices.updatedAt}, excluded.updated_at)`,
                connectionStatus: sql`case when ${devices.lastReceivedAt} is null or ${devices.lastReceivedAt} <= excluded.last_received_at then 'ONLINE'::connection_status else ${devices.connectionStatus} end`,
              },
            });
        }

        const retainedOnlyDeviceIds = [
          ...new Set(entries.map((entry) => entry.message.deviceId)),
        ].filter((deviceId) => !deviceReceipts.has(deviceId));
        if (retainedOnlyDeviceIds.length > 0) {
          await transaction
            .insert(devices)
            .values(retainedOnlyDeviceIds.map((deviceId) => ({ deviceId })))
            .onConflictDoNothing({ target: devices.deviceId });
        }

        await transaction
          .insert(telemetry)
          .values(
            entries.map((entry) =>
              toNewTelemetry(entry.message, entry.receivedAt),
            ),
          );
      });
    },
  };
}
