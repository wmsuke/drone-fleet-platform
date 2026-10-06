import { createDatabase, devices, telemetry } from "@drone-fleet/database";
import type { TelemetryMessage } from "@drone-fleet/protocol";
import { asc, eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTelemetryRepository } from "../src/repository.js";

const runIntegration = process.env.DATABASE_INTEGRATION === "true";
const integration = describe.skipIf(!runIntegration);
const deviceIds = ["integration-batch-a", "integration-batch-b"];
const migrationsFolder = fileURLToPath(
  new URL("../../../packages/database/drizzle", import.meta.url),
);
const database = runIntegration ? createDatabase() : undefined;

function message(deviceId: string, sequence: number): TelemetryMessage {
  return {
    schemaVersion: 1,
    deviceId,
    sequence,
    timestamp: `2026-10-02T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    payload: {
      battery: 100 - sequence,
      latitude: 35,
      longitude: 139,
      altitude: sequence,
      temperature: 25,
      status: "FLYING",
    },
  };
}

integration("telemetry repository", () => {
  beforeAll(async () => {
    if (database !== undefined) {
      await migrate(database.db, { migrationsFolder });
    }
  });

  beforeEach(async () => {
    if (database !== undefined) {
      await database.db
        .delete(devices)
        .where(inArray(devices.deviceId, deviceIds));
    }
  });

  afterAll(async () => {
    if (database !== undefined) {
      await database.db
        .delete(devices)
        .where(inArray(devices.deviceId, deviceIds));
      await database.client.end();
    }
  });

  it("stores multiple devices and sequences in one transaction", async () => {
    if (database === undefined) {
      throw new Error("database integration test is not configured");
    }
    const repository = createTelemetryRepository(database.db);
    const receivedTimes = [
      new Date("2026-10-02T00:00:01.000Z"),
      new Date("2026-10-02T00:00:02.000Z"),
      new Date("2026-10-02T00:00:03.000Z"),
    ];

    await repository.saveBatch([
      {
        message: message(deviceIds[0] ?? "", 0),
        receivedAt: receivedTimes[0] ?? new Date(0),
        isRetained: false,
      },
      {
        message: message(deviceIds[1] ?? "", 0),
        receivedAt: receivedTimes[1] ?? new Date(0),
        isRetained: false,
      },
      {
        message: message(deviceIds[0] ?? "", 1),
        receivedAt: receivedTimes[2] ?? new Date(0),
        isRetained: false,
      },
    ]);

    const registeredDevices = await database.db
      .select()
      .from(devices)
      .where(inArray(devices.deviceId, deviceIds))
      .orderBy(asc(devices.deviceId));
    const rows = await database.db
      .select()
      .from(telemetry)
      .where(inArray(telemetry.deviceId, deviceIds))
      .orderBy(asc(telemetry.deviceId), asc(telemetry.sequence));

    expect(registeredDevices).toHaveLength(2);
    expect(registeredDevices[0]).toMatchObject({
      deviceId: deviceIds[0],
      connectionStatus: "ONLINE",
      lastReceivedAt: receivedTimes[2],
    });
    expect(registeredDevices[1]).toMatchObject({
      deviceId: deviceIds[1],
      connectionStatus: "ONLINE",
      lastReceivedAt: receivedTimes[1],
    });
    expect(
      rows.map(({ deviceId, sequence, receivedAt }) => ({
        deviceId,
        sequence,
        receivedAt,
      })),
    ).toEqual([
      { deviceId: deviceIds[0], sequence: 0, receivedAt: receivedTimes[0] },
      { deviceId: deviceIds[0], sequence: 1, receivedAt: receivedTimes[2] },
      { deviceId: deviceIds[1], sequence: 0, receivedAt: receivedTimes[1] },
    ]);
  });

  it("stores a v2 session ID while keeping v1 rows nullable", async () => {
    if (database === undefined) {
      throw new Error("database integration test is not configured");
    }
    const repository = createTelemetryRepository(database.db);
    const deviceId = deviceIds[0] ?? "";
    const sessionId = "a065e32b-c00b-452e-9cb1-3b52c43962fb";
    await repository.saveBatch([
      {
        message: message(deviceId, 0),
        receivedAt: new Date("2026-10-02T00:00:01.000Z"),
        isRetained: false,
      },
      {
        message: { ...message(deviceId, 0), schemaVersion: 2, sessionId },
        receivedAt: new Date("2026-10-02T00:00:02.000Z"),
        isRetained: false,
      },
    ]);

    const rows = await database.db
      .select({ sessionId: telemetry.sessionId, sequence: telemetry.sequence })
      .from(telemetry)
      .where(eq(telemetry.deviceId, deviceId))
      .orderBy(asc(telemetry.id));
    expect(rows).toEqual([
      { sessionId: null, sequence: 0 },
      { sessionId, sequence: 0 },
    ]);
  });

  it("does not move a device receipt timestamp backwards within a batch", async () => {
    if (database === undefined) {
      throw new Error("database integration test is not configured");
    }
    const repository = createTelemetryRepository(database.db);
    const newerReceivedAt = new Date("2026-10-02T00:00:10.000Z");
    const olderReceivedAt = new Date("2026-10-02T00:00:05.000Z");

    await repository.saveBatch([
      {
        message: message(deviceIds[0] ?? "", 0),
        receivedAt: newerReceivedAt,
        isRetained: false,
      },
      {
        message: message(deviceIds[0] ?? "", 1),
        receivedAt: olderReceivedAt,
        isRetained: false,
      },
    ]);

    const [registeredDevice] = await database.db
      .select()
      .from(devices)
      .where(eq(devices.deviceId, deviceIds[0] ?? ""));
    expect(registeredDevice).toMatchObject({
      lastReceivedAt: newerReceivedAt,
      updatedAt: newerReceivedAt,
    });
  });

  it("registers retained telemetry without changing receipt status", async () => {
    if (database === undefined) {
      throw new Error("database integration test is not configured");
    }
    const repository = createTelemetryRepository(database.db);

    await repository.saveBatch([
      {
        message: message(deviceIds[0] ?? "", 0),
        receivedAt: new Date("2026-10-02T00:00:01.000Z"),
        isRetained: true,
      },
    ]);

    const [registeredDevice] = await database.db
      .select()
      .from(devices)
      .where(eq(devices.deviceId, deviceIds[0] ?? ""));
    expect(registeredDevice).toMatchObject({
      connectionStatus: "OFFLINE",
      lastReceivedAt: null,
    });
  });
});
