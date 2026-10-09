import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase } from "../src/connection.js";
import { devices, telemetry } from "../src/schema.js";

const runIntegration = process.env.DATABASE_INTEGRATION === "true";
const integration = describe.skipIf(!runIntegration);
const deviceId = "integration-restart-sequence";
const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
const database = runIntegration ? createDatabase() : undefined;

integration("database migration", () => {
  it("preserves existing v1 rows and duplicate v2 histories while enforcing the new identity", async () => {
    if (database === undefined) throw new Error("database required");
    await database.client.begin(async (transaction) => {
      await transaction.unsafe("CREATE SCHEMA issue112_migration_test");
      await transaction.unsafe(
        "SET LOCAL search_path TO issue112_migration_test",
      );
      for (const file of [
        "0000_powerful_celestials.sql",
        "0001_flippant_expediter.sql",
      ]) {
        const migration = await readFile(`${migrationsFolder}/${file}`, "utf8");
        for (const statement of migration.split("--> statement-breakpoint")) {
          if (statement.trim())
            await transaction.unsafe(
              statement.replaceAll('"public".', '"issue112_migration_test".'),
            );
        }
      }
      await transaction.unsafe(
        "INSERT INTO devices (device_id) VALUES ('migration-device')",
      );
      await transaction.unsafe(`INSERT INTO telemetry
        (device_id, session_id, sequence, device_timestamp, battery, latitude, longitude, altitude, temperature, flight_status)
        SELECT 'migration-device', CASE WHEN value < 3 THEN NULL ELSE 'a065e32b-c00b-452e-9cb1-3b52c43962fb'::uuid END,
          0, '2026-10-09T00:00:00Z', 80 + value, 35, 139, 0, 25, 'IDLE'
        FROM generate_series(1, 4) AS value`);
      const migration = await readFile(
        `${migrationsFolder}/0002_true_santa_claus.sql`,
        "utf8",
      );
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) await transaction.unsafe(statement);
      }
      const rows = await transaction.unsafe(
        "SELECT session_id, battery, identity_owner FROM telemetry ORDER BY id",
      );
      expect(rows.map(({ battery }) => battery)).toEqual([81, 82, 83, 84]);
      expect(rows.map(({ identity_owner }) => identity_owner)).toEqual([
        true,
        true,
        true,
        false,
      ]);
      const inserted = await transaction.unsafe(`INSERT INTO telemetry
        (device_id, session_id, sequence, device_timestamp, battery, latitude, longitude, altitude, temperature, flight_status)
        VALUES ('migration-device', 'a065e32b-c00b-452e-9cb1-3b52c43962fb', 0, '2026-10-09T00:00:00Z', 83, 35, 139, 0, 25, 'IDLE')
        ON CONFLICT (device_id, session_id, sequence) WHERE session_id IS NOT NULL AND identity_owner DO NOTHING RETURNING id`);
      expect(inserted).toHaveLength(0);
      await transaction.unsafe("DROP SCHEMA issue112_migration_test CASCADE");
    });
  });
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
