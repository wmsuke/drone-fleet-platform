import { createDatabase, devices, telemetry } from "@drone-fleet/database";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { ingestTelemetry, type IngestionLogger } from "../src/ingestion.js";
import { createTelemetryRepository } from "../src/repository.js";

const runIntegration = process.env.DATABASE_INTEGRATION === "true";
const integration = describe.skipIf(!runIntegration);
const deviceId = "integration-telemetry-ingestor";
const topic = `fleet/v1/devices/${deviceId}/telemetry`;
const migrationsFolder = fileURLToPath(
  new URL("../../../packages/database/drizzle", import.meta.url),
);
const database = runIntegration ? createDatabase() : undefined;

integration("telemetry repository", () => {
  beforeAll(async () => {
    if (database === undefined) {
      return;
    }
    await migrate(database.db, { migrationsFolder });
  });

  beforeEach(async () => {
    if (database === undefined) {
      return;
    }
    await database.db.delete(devices).where(eq(devices.deviceId, deviceId));
  });

  afterAll(async () => {
    if (database === undefined) {
      return;
    }
    await database.db.delete(devices).where(eq(devices.deviceId, deviceId));
    await database.client.end();
  });

  it("registers an unknown device and stores valid telemetry", async () => {
    if (database === undefined) {
      throw new Error("database integration test is not configured");
    }
    const repository = createTelemetryRepository(database.db);
    const logger: IngestionLogger = { warn: vi.fn(), error: vi.fn() };
    const receivedAt = new Date("2026-09-29T02:00:01.000Z");

    await expect(
      ingestTelemetry(
        topic,
        Buffer.from(
          JSON.stringify({
            schemaVersion: 1,
            deviceId,
            sequence: 0,
            timestamp: "2026-09-29T02:00:00.000Z",
            payload: {
              battery: 100,
              latitude: 35,
              longitude: 139,
              altitude: 0,
              temperature: 25,
              status: "IDLE",
            },
          }),
        ),
        receivedAt,
        repository,
        logger,
      ),
    ).resolves.toBe(true);

    const registeredDevices = await database.db
      .select()
      .from(devices)
      .where(eq(devices.deviceId, deviceId));
    const rows = await database.db
      .select()
      .from(telemetry)
      .where(eq(telemetry.deviceId, deviceId));
    expect(registeredDevices).toHaveLength(1);
    expect(registeredDevices[0]).toMatchObject({
      deviceId,
      model: null,
      softwareVersion: null,
      lastReceivedAt: receivedAt,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      deviceId,
      sequence: 0,
      deviceTimestamp: new Date("2026-09-29T02:00:00.000Z"),
      receivedAt,
      flightStatus: "IDLE",
    });
  });

  it("keeps one device and updates its last receipt time", async () => {
    if (database === undefined) {
      throw new Error("database integration test is not configured");
    }
    const repository = createTelemetryRepository(database.db);
    const logger: IngestionLogger = { warn: vi.fn(), error: vi.fn() };
    const firstReceivedAt = new Date("2026-09-29T02:00:01.000Z");
    const secondReceivedAt = new Date("2026-09-29T02:00:06.000Z");
    const createPayload = (sequence: number): Buffer =>
      Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          deviceId,
          sequence,
          timestamp: "2026-09-29T02:00:00.000Z",
          payload: {
            battery: 100,
            latitude: 35,
            longitude: 139,
            altitude: 0,
            temperature: 25,
            status: "IDLE",
          },
        }),
      );

    await ingestTelemetry(
      topic,
      createPayload(0),
      firstReceivedAt,
      repository,
      logger,
    );
    await ingestTelemetry(
      topic,
      createPayload(1),
      secondReceivedAt,
      repository,
      logger,
    );

    const registeredDevices = await database.db
      .select()
      .from(devices)
      .where(eq(devices.deviceId, deviceId));
    expect(registeredDevices).toHaveLength(1);
    expect(registeredDevices[0]?.lastReceivedAt).toEqual(secondReceivedAt);
  });

  it("registers one device during concurrent first receipts", async () => {
    if (database === undefined) {
      throw new Error("database integration test is not configured");
    }
    const repository = createTelemetryRepository(database.db);
    const receivedAt = new Date("2026-09-29T02:00:01.000Z");

    await Promise.all(
      Array.from({ length: 10 }, async (_, sequence) =>
        repository.save(
          {
            schemaVersion: 1,
            deviceId,
            sequence,
            timestamp: "2026-09-29T02:00:00.000Z",
            payload: {
              battery: 100,
              latitude: 35,
              longitude: 139,
              altitude: 0,
              temperature: 25,
              status: "IDLE",
            },
          },
          receivedAt,
        ),
      ),
    );

    const registeredDevices = await database.db
      .select()
      .from(devices)
      .where(eq(devices.deviceId, deviceId));
    const rows = await database.db
      .select()
      .from(telemetry)
      .where(eq(telemetry.deviceId, deviceId));
    expect(registeredDevices).toHaveLength(1);
    expect(rows).toHaveLength(10);
  });
});
