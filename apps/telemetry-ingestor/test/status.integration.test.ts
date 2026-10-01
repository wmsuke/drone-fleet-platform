import { createDatabase, devices } from "@drone-fleet/database";
import type { ConnectionStatusMessage } from "@drone-fleet/protocol";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTelemetryRepository } from "../src/repository.js";
import { createDeviceStatusRepository } from "../src/status.js";

const runIntegration = process.env.DATABASE_INTEGRATION === "true";
const integration = describe.skipIf(!runIntegration);
const deviceId = "integration-device-status";
const migrationsFolder = fileURLToPath(
  new URL("../../../packages/database/drizzle", import.meta.url),
);
const database = runIntegration ? createDatabase() : undefined;

function statusMessage(
  status: "ONLINE" | "OFFLINE",
  reason: "CONNECTED" | "SHUTDOWN" | "CONNECTION_LOST",
): ConnectionStatusMessage {
  return {
    schemaVersion: 1,
    deviceId,
    timestamp: "2026-09-29T02:00:00.000Z",
    payload:
      status === "ONLINE"
        ? { status, reason: "CONNECTED" }
        : { status, reason: reason === "CONNECTED" ? "SHUTDOWN" : reason },
  };
}

integration("device connection status repository", () => {
  beforeAll(async () => {
    if (database !== undefined) {
      await migrate(database.db, { migrationsFolder });
    }
  });

  beforeEach(async () => {
    if (database !== undefined) {
      await database.db.delete(devices).where(eq(devices.deviceId, deviceId));
    }
  });

  afterAll(async () => {
    if (database !== undefined) {
      await database.db.delete(devices).where(eq(devices.deviceId, deviceId));
      await database.client.end();
    }
  });

  it("handles retained status, disconnects, timeout, and recovery", async () => {
    if (database === undefined) {
      throw new Error("database integration test is not configured");
    }
    const statusRepository = createDeviceStatusRepository(database.db);
    const telemetryRepository = createTelemetryRepository(database.db);
    const firstReceipt = new Date("2026-09-29T02:00:00.000Z");

    await expect(
      statusRepository.saveStatus(
        statusMessage("ONLINE", "CONNECTED"),
        firstReceipt,
        true,
      ),
    ).resolves.toBe(0);
    await expect(readDevice()).resolves.toMatchObject({
      connectionStatus: "OFFLINE",
      lastReceivedAt: null,
    });

    await statusRepository.saveStatus(
      statusMessage("ONLINE", "CONNECTED"),
      new Date("2026-09-29T02:00:01.000Z"),
      false,
    );
    await expect(readDevice()).resolves.toMatchObject({
      connectionStatus: "ONLINE",
      lastReceivedAt: new Date("2026-09-29T02:00:01.000Z"),
    });

    await statusRepository.saveStatus(
      statusMessage("ONLINE", "CONNECTED"),
      new Date("2026-09-29T02:00:16.000Z"),
      true,
    );
    await telemetryRepository.save(
      {
        schemaVersion: 1,
        deviceId,
        sequence: 0,
        timestamp: "2026-09-29T02:00:17.000Z",
        payload: {
          battery: 100,
          latitude: 35,
          longitude: 139,
          altitude: 0,
          temperature: 25,
          status: "IDLE",
        },
      },
      new Date("2026-09-29T02:00:17.000Z"),
      true,
    );
    await expect(readDevice()).resolves.toMatchObject({
      connectionStatus: "ONLINE",
      lastReceivedAt: new Date("2026-09-29T02:00:01.000Z"),
    });

    await expect(
      statusRepository.markTimedOut(
        new Date("2026-09-29T02:00:01.000Z"),
        new Date("2026-09-29T02:00:16.000Z"),
      ),
    ).resolves.toBe(1);
    await expect(readDevice()).resolves.toMatchObject({
      connectionStatus: "OFFLINE",
      lastReceivedAt: new Date("2026-09-29T02:00:01.000Z"),
    });

    await statusRepository.saveStatus(
      statusMessage("ONLINE", "CONNECTED"),
      new Date("2026-09-29T02:00:18.000Z"),
      false,
    );
    await expect(
      statusRepository.saveStatus(
        statusMessage("OFFLINE", "CONNECTION_LOST"),
        new Date("2026-09-29T02:00:19.000Z"),
        false,
      ),
    ).resolves.toBe(1);
    await expect(
      statusRepository.saveStatus(
        statusMessage("OFFLINE", "CONNECTION_LOST"),
        new Date("2026-09-29T02:00:20.000Z"),
        false,
      ),
    ).resolves.toBe(0);
    await expect(readDevice()).resolves.toMatchObject({
      connectionStatus: "OFFLINE",
    });

    await telemetryRepository.save(
      {
        schemaVersion: 1,
        deviceId,
        sequence: 1,
        timestamp: "2026-09-29T02:00:20.000Z",
        payload: {
          battery: 100,
          latitude: 35,
          longitude: 139,
          altitude: 0,
          temperature: 25,
          status: "IDLE",
        },
      },
      new Date("2026-09-29T02:00:20.000Z"),
    );
    await expect(readDevice()).resolves.toMatchObject({
      connectionStatus: "ONLINE",
    });

    await expect(
      statusRepository.markTimedOut(
        new Date("2026-09-29T02:00:20.000Z"),
        new Date("2026-09-29T02:00:35.000Z"),
      ),
    ).resolves.toBe(1);
    await expect(readDevice()).resolves.toMatchObject({
      connectionStatus: "OFFLINE",
      updatedAt: new Date("2026-09-29T02:00:35.000Z"),
    });

    await telemetryRepository.save(
      {
        schemaVersion: 1,
        deviceId,
        sequence: 2,
        timestamp: "2026-09-29T02:00:36.000Z",
        payload: {
          battery: 99,
          latitude: 35,
          longitude: 139,
          altitude: 0,
          temperature: 25,
          status: "IDLE",
        },
      },
      new Date("2026-09-29T02:00:36.000Z"),
    );
    await expect(readDevice()).resolves.toMatchObject({
      connectionStatus: "ONLINE",
      lastReceivedAt: new Date("2026-09-29T02:00:36.000Z"),
    });
  });
});

async function readDevice() {
  if (database === undefined) {
    throw new Error("database integration test is not configured");
  }
  const rows = await database.db
    .select()
    .from(devices)
    .where(eq(devices.deviceId, deviceId));
  return rows[0];
}
