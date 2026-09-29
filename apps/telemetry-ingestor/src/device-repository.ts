import { devices, type Database } from "@drone-fleet/database";
import { sql } from "drizzle-orm";

type DeviceWriteDatabase = Pick<Database, "insert">;

export async function upsertDeviceReceipt(
  database: DeviceWriteDatabase,
  deviceId: string,
  receivedAt: Date,
): Promise<void> {
  const receivedAtIso = receivedAt.toISOString();

  await database
    .insert(devices)
    .values({
      deviceId,
      lastReceivedAt: receivedAt,
      updatedAt: receivedAt,
    })
    .onConflictDoUpdate({
      target: devices.deviceId,
      set: {
        lastReceivedAt: sql`greatest(coalesce(${devices.lastReceivedAt}, ${receivedAtIso}::timestamptz), ${receivedAtIso}::timestamptz)`,
        updatedAt: sql`greatest(${devices.updatedAt}, ${receivedAtIso}::timestamptz)`,
      },
    });
}
