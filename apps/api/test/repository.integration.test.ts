import { createDatabase, devices, telemetry } from "@drone-fleet/database";
import { inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDeviceRepository } from "../src/repository.js";

const runIntegration = process.env.DATABASE_INTEGRATION === "true";
const integration = describe.skipIf(!runIntegration);
const deviceIds = ["integration-api-001", "integration-api-002"] as const;
const migrationsFolder = fileURLToPath(
  new URL("../../../packages/database/drizzle", import.meta.url),
);
const database = runIntegration ? createDatabase() : undefined;

integration("device repository", () => {
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

  it("returns devices in device ID order with their latest telemetry", async () => {
    if (database === undefined) {
      throw new Error("database integration test is not configured");
    }
    const receivedAt = new Date("2026-09-29T02:00:10.000Z");
    await database.db.insert(devices).values([
      {
        deviceId: deviceIds[1],
        connectionStatus: "OFFLINE",
      },
      {
        deviceId: deviceIds[0],
        connectionStatus: "ONLINE",
        lastReceivedAt: receivedAt,
      },
    ]);
    await database.db
      .insert(telemetry)
      .values([
        telemetryRow(0, new Date("2026-09-29T02:00:01.000Z"), 90, "IDLE"),
        telemetryRow(1, new Date("2026-09-29T02:00:05.000Z"), 75, "FLYING"),
      ]);

    const repository = createDeviceRepository(database.db);

    await expect(repository.list()).resolves.toEqual([
      {
        deviceId: deviceIds[0],
        connectionStatus: "ONLINE",
        battery: 75,
        flightStatus: "FLYING",
        lastReceivedAt: receivedAt.toISOString(),
      },
      {
        deviceId: deviceIds[1],
        connectionStatus: "OFFLINE",
        battery: null,
        flightStatus: null,
        lastReceivedAt: null,
      },
    ]);
  });

  it("returns one device with its latest telemetry", async () => {
    if (database === undefined) {
      throw new Error("database integration test is not configured");
    }
    const createdAt = new Date("2026-09-29T01:00:00.000Z");
    const updatedAt = new Date("2026-09-29T02:00:10.000Z");
    await database.db.insert(devices).values({
      deviceId: deviceIds[0],
      model: "virtual-drone",
      softwareVersion: "1.0.0",
      connectionStatus: "ONLINE",
      lastReceivedAt: updatedAt,
      createdAt,
      updatedAt,
    });
    await database.db
      .insert(telemetry)
      .values([
        telemetryRow(0, new Date("2026-09-29T02:00:01.000Z"), 90, "IDLE"),
        telemetryRow(1, new Date("2026-09-29T02:00:05.000Z"), 75, "FLYING"),
      ]);
    const repository = createDeviceRepository(database.db);

    await expect(repository.findById(deviceIds[0])).resolves.toEqual({
      deviceId: deviceIds[0],
      model: "virtual-drone",
      softwareVersion: "1.0.0",
      connectionStatus: "ONLINE",
      lastReceivedAt: updatedAt.toISOString(),
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
      latestTelemetry: {
        sequence: 1,
        deviceTimestamp: "2026-09-29T02:00:05.000Z",
        receivedAt: "2026-09-29T02:00:05.000Z",
        battery: 75,
        latitude: 35,
        longitude: 139,
        altitude: 10,
        temperature: 25,
        flightStatus: "FLYING",
      },
    });
  });

  it("returns null for an unregistered device", async () => {
    if (database === undefined) {
      throw new Error("database integration test is not configured");
    }
    const repository = createDeviceRepository(database.db);

    await expect(repository.findById(deviceIds[0])).resolves.toBeNull();
  });

  it("returns only the target device telemetry in newest-first order", async () => {
    if (database === undefined) {
      throw new Error("database integration test is not configured");
    }
    await database.db
      .insert(devices)
      .values([{ deviceId: deviceIds[0] }, { deviceId: deviceIds[1] }]);
    await database.db
      .insert(telemetry)
      .values([
        telemetryRow(0, new Date("2026-09-29T02:00:01.000Z"), 90, "IDLE"),
        telemetryRow(2, new Date("2026-09-29T02:00:03.000Z"), 70, "FLYING"),
        telemetryRow(1, new Date("2026-09-29T02:00:02.000Z"), 80, "IDLE"),
        telemetryRow(
          0,
          new Date("2026-09-29T02:00:04.000Z"),
          60,
          "FLYING",
          deviceIds[1],
        ),
      ]);
    const repository = createDeviceRepository(database.db);

    await expect(repository.telemetryHistory(deviceIds[0], 2)).resolves.toEqual(
      [
        expectedTelemetry(2, "2026-09-29T02:00:03.000Z", 70, "FLYING"),
        expectedTelemetry(1, "2026-09-29T02:00:02.000Z", 80, "IDLE"),
      ],
    );
  });

  it("distinguishes an empty history from an unregistered device", async () => {
    if (database === undefined) {
      throw new Error("database integration test is not configured");
    }
    await database.db.insert(devices).values({ deviceId: deviceIds[0] });
    const repository = createDeviceRepository(database.db);

    await expect(
      repository.telemetryHistory(deviceIds[0], 100),
    ).resolves.toEqual([]);
    await expect(
      repository.telemetryHistory(deviceIds[1], 100),
    ).resolves.toBeNull();
  });
});

function telemetryRow(
  sequence: number,
  receivedAt: Date,
  battery: number,
  flightStatus: "IDLE" | "FLYING",
  deviceId: string = deviceIds[0],
) {
  return {
    deviceId,
    sequence,
    deviceTimestamp: receivedAt,
    receivedAt,
    battery,
    latitude: 35,
    longitude: 139,
    altitude: 10,
    temperature: 25,
    flightStatus,
  };
}

function expectedTelemetry(
  sequence: number,
  timestamp: string,
  battery: number,
  flightStatus: "IDLE" | "FLYING",
) {
  return {
    sequence,
    deviceTimestamp: timestamp,
    receivedAt: timestamp,
    battery,
    latitude: 35,
    longitude: 139,
    altitude: 10,
    temperature: 25,
    flightStatus,
  };
}
