import { devices, telemetry, type Database } from "@drone-fleet/database";
import { asc, desc, eq } from "drizzle-orm";

import type { DeviceListItem } from "./schema.js";

export interface DeviceListRepository {
  list(): Promise<DeviceListItem[]>;
}

export function createDeviceListRepository(
  database: Database,
): DeviceListRepository {
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
  };
}
