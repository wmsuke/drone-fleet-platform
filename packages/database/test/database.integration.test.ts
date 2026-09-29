import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase } from "../src/connection.js";
import { devices, telemetry } from "../src/schema.js";

const runIntegration = process.env.DATABASE_INTEGRATION === "true";
const integration = describe.skipIf(!runIntegration);
const deviceId = "integration-restart-sequence";
const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
const database = runIntegration ? createDatabase() : undefined;

integration("database migration", () => {
  beforeAll(async () => {
    if (database === undefined) {
      return;
    }
    await migrate(database.db, { migrationsFolder });
    await database.db.delete(devices).where(eq(devices.deviceId, deviceId));
  });

  afterAll(async () => {
    if (database === undefined) {
      return;
    }
    await database.db.delete(devices).where(eq(devices.deviceId, deviceId));
    await database.client.end();
  });

  it("stores sequence zero again after a simulated process restart", async () => {
    if (database === undefined) {
      throw new Error("database integration test is not configured");
    }

    await database.db.insert(devices).values({ deviceId });
    await database.db.insert(telemetry).values([
      {
        deviceId,
        sequence: 0,
        deviceTimestamp: new Date("2026-09-29T00:00:00.000Z"),
        battery: 100,
        latitude: 35.681236,
        longitude: 139.767125,
        altitude: 0,
        temperature: 25,
        flightStatus: "IDLE",
      },
      {
        deviceId,
        sequence: 0,
        deviceTimestamp: new Date("2026-09-29T01:00:00.000Z"),
        battery: 99,
        latitude: 35.681236,
        longitude: 139.767125,
        altitude: 0,
        temperature: 25,
        flightStatus: "IDLE",
      },
    ]);

    const rows = await database.db
      .select()
      .from(telemetry)
      .where(eq(telemetry.deviceId, deviceId));

    expect(rows).toHaveLength(2);
    expect(rows.map(({ sequence }) => sequence)).toEqual([0, 0]);
  });
});
