import { devices, type Database } from "@drone-fleet/database";
import { sql } from "drizzle-orm";

type DeviceWriteDatabase = Pick<Database, "insert">;
export type DeviceConnectionStatus = "ONLINE" | "OFFLINE";

export async function ensureDeviceRegistered(
  database: DeviceWriteDatabase,
  deviceId: string,
): Promise<void> {
  await database
    .insert(devices)
    .values({ deviceId })
    .onConflictDoNothing({ target: devices.deviceId });
}

export async function upsertDeviceReceipt(
  database: DeviceWriteDatabase,
  deviceId: string,
  receivedAt: Date,
  connectionStatus?: DeviceConnectionStatus,
): Promise<void> {
  const receivedAtIso = receivedAt.toISOString();
  const connectionStatusUpdate =
    connectionStatus === undefined
      ? {}
      : {
          connectionStatus: sql`case when ${devices.lastReceivedAt} is null or ${devices.lastReceivedAt} <= ${receivedAtIso}::timestamptz then ${connectionStatus}::connection_status else ${devices.connectionStatus} end`,
        };

  await database
    .insert(devices)
    .values({
      deviceId,
      connectionStatus: connectionStatus ?? "OFFLINE",
      lastReceivedAt: receivedAt,
      updatedAt: receivedAt,
    })
    .onConflictDoUpdate({
      target: devices.deviceId,
      set: {
        lastReceivedAt: sql`greatest(coalesce(${devices.lastReceivedAt}, ${receivedAtIso}::timestamptz), ${receivedAtIso}::timestamptz)`,
        updatedAt: sql`greatest(${devices.updatedAt}, ${receivedAtIso}::timestamptz)`,
        ...connectionStatusUpdate,
      },
    });
}
