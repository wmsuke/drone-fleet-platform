import { devices, telemetry, type Database } from "@drone-fleet/database";
import { asc, desc, eq } from "drizzle-orm";

import type {
  DeviceDetail,
  DeviceListItem,
  TelemetryHistoryItem,
} from "./schema.js";

export interface DeviceRepository {
  list(): Promise<DeviceListItem[]>;
  findById(deviceId: string): Promise<DeviceDetail | null>;
  telemetryHistory(
    deviceId: string,
    limit: number,
  ): Promise<TelemetryHistoryItem[] | null>;
}

export function createDeviceRepository(database: Database): DeviceRepository {
  return {
    async list() {
      const latestTelemetry = database
        .selectDistinctOn([telemetry.deviceId], {
          deviceId: telemetry.deviceId,
          battery: telemetry.battery,
          flightStatus: telemetry.flightStatus,
        })
        .from(telemetry)
        .orderBy(
          telemetry.deviceId,
          desc(telemetry.receivedAt),
          desc(telemetry.id),
        )
        .as("latest_telemetry");

      const rows = await database
        .select({
          deviceId: devices.deviceId,
          connectionStatus: devices.connectionStatus,
          battery: latestTelemetry.battery,
          flightStatus: latestTelemetry.flightStatus,
          lastReceivedAt: devices.lastReceivedAt,
        })
        .from(devices)
        .leftJoin(
          latestTelemetry,
          eq(devices.deviceId, latestTelemetry.deviceId),
        )
        .orderBy(asc(devices.deviceId));

      return rows.map((row) => ({
        ...row,
        lastReceivedAt: row.lastReceivedAt?.toISOString() ?? null,
      }));
    },
    async findById(deviceId) {
      const latestTelemetry = database
        .selectDistinctOn([telemetry.deviceId])
        .from(telemetry)
        .orderBy(
          telemetry.deviceId,
          desc(telemetry.receivedAt),
          desc(telemetry.id),
        )
        .as("latest_telemetry_detail");
      const rows = await database
        .select({
          deviceId: devices.deviceId,
          model: devices.model,
          softwareVersion: devices.softwareVersion,
          connectionStatus: devices.connectionStatus,
          lastReceivedAt: devices.lastReceivedAt,
          createdAt: devices.createdAt,
          updatedAt: devices.updatedAt,
          telemetry: {
            id: latestTelemetry.id,
            sequence: latestTelemetry.sequence,
            deviceTimestamp: latestTelemetry.deviceTimestamp,
            receivedAt: latestTelemetry.receivedAt,
            battery: latestTelemetry.battery,
            latitude: latestTelemetry.latitude,
            longitude: latestTelemetry.longitude,
            altitude: latestTelemetry.altitude,
            temperature: latestTelemetry.temperature,
            flightStatus: latestTelemetry.flightStatus,
          },
        })
        .from(devices)
        .leftJoin(
          latestTelemetry,
          eq(devices.deviceId, latestTelemetry.deviceId),
        )
        .where(eq(devices.deviceId, deviceId))
        .limit(1);
      const row = rows[0];
      if (row === undefined) {
        return null;
      }
      const latest = row.telemetry;
      return {
        deviceId: row.deviceId,
        model: row.model,
        softwareVersion: row.softwareVersion,
        connectionStatus: row.connectionStatus,
        lastReceivedAt: row.lastReceivedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        latestTelemetry:
          latest === null
            ? null
            : {
                sequence: latest.sequence,
                deviceTimestamp: latest.deviceTimestamp.toISOString(),
                receivedAt: latest.receivedAt.toISOString(),
                battery: latest.battery,
                latitude: latest.latitude,
                longitude: latest.longitude,
                altitude: latest.altitude,
                temperature: latest.temperature,
                flightStatus: latest.flightStatus,
              },
      };
    },
    async telemetryHistory(deviceId, limit) {
      const registered = await database
        .select({ deviceId: devices.deviceId })
        .from(devices)
        .where(eq(devices.deviceId, deviceId))
        .limit(1);
      if (registered.length === 0) {
        return null;
      }
      const rows = await database
        .select({
          sequence: telemetry.sequence,
          deviceTimestamp: telemetry.deviceTimestamp,
          receivedAt: telemetry.receivedAt,
          battery: telemetry.battery,
          latitude: telemetry.latitude,
          longitude: telemetry.longitude,
          altitude: telemetry.altitude,
          temperature: telemetry.temperature,
          flightStatus: telemetry.flightStatus,
        })
        .from(telemetry)
        .where(eq(telemetry.deviceId, deviceId))
        .orderBy(desc(telemetry.receivedAt), desc(telemetry.id))
        .limit(limit);

      return rows.map((row) => ({
        ...row,
        deviceTimestamp: row.deviceTimestamp.toISOString(),
        receivedAt: row.receivedAt.toISOString(),
      }));
    },
  };
}
