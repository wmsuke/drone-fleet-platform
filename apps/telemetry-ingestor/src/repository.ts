import {
  devices,
  telemetry,
  type Database,
  type NewTelemetry,
} from "@drone-fleet/database";
import type { TelemetryMessage } from "@drone-fleet/protocol";

export interface TelemetryRepository {
  save(message: TelemetryMessage, receivedAt: Date): Promise<void>;
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
    async save(message, receivedAt) {
      await database.transaction(async (transaction) => {
        await transaction
          .insert(devices)
          .values({
            deviceId: message.deviceId,
            lastReceivedAt: receivedAt,
            updatedAt: receivedAt,
          })
          .onConflictDoUpdate({
            target: devices.deviceId,
            set: {
              lastReceivedAt: receivedAt,
              updatedAt: receivedAt,
            },
          });
        await transaction
          .insert(telemetry)
          .values(toNewTelemetry(message, receivedAt));
      });
    },
  };
}
