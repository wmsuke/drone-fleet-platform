import {
  telemetry,
  type Database,
  type NewTelemetry,
} from "@drone-fleet/database";
import type { TelemetryMessage } from "@drone-fleet/protocol";

import {
  ensureDeviceRegistered,
  upsertDeviceReceipt,
} from "./device-repository.js";

export interface TelemetryRepository {
  save(
    message: TelemetryMessage,
    receivedAt: Date,
    isRetained?: boolean,
  ): Promise<void>;
}

export function toNewTelemetry(
  message: TelemetryMessage,
  receivedAt: Date,
): NewTelemetry {
  return {
    deviceId: message.deviceId,
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
    async save(message, receivedAt, isRetained = false) {
      await database.transaction(async (transaction) => {
        if (isRetained) {
          await ensureDeviceRegistered(transaction, message.deviceId);
        } else {
          await upsertDeviceReceipt(
            transaction,
            message.deviceId,
            receivedAt,
            "ONLINE",
          );
        }
        await transaction
          .insert(telemetry)
          .values(toNewTelemetry(message, receivedAt));
      });
    },
  };
}
