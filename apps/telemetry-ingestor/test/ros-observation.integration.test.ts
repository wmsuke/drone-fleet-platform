import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabase,
  devices,
  rosObservations,
  observationConflicts,
  telemetry,
} from "@drone-fleet/database";
import { rosObservationMessageSchema } from "@drone-fleet/protocol";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { observation } from "../../../packages/protocol/test/fixtures/ros-observations.mjs";
import { createTelemetryRepository } from "../src/repository.js";
import { createDeviceRepository } from "../../api/src/repository.js";
import { ingestTelemetry } from "../src/ingestion.js";

const enabled = process.env.DATABASE_INTEGRATION === "true";
const database = enabled ? createDatabase() : undefined;
const deviceId = "ros-observation-integration";
describe.skipIf(!enabled)("ROS observations commit/API/receipt", () => {
  beforeAll(async () => {
    await migrate(database!.db, {
      migrationsFolder: fileURLToPath(
        new URL("../../../packages/database/drizzle", import.meta.url),
      ),
    });
    await database!.db.delete(devices).where(eq(devices.deviceId, deviceId));
  });
  afterAll(async () => {
    await database!.db
      .delete(observationConflicts)
      .where(eq(observationConflicts.deviceId, deviceId));
    await database!.db.delete(devices).where(eq(devices.deviceId, deviceId));
    await database!.client.end();
  });
  it("commits v3 once, rejects cross-version collisions, and preserves local evidence through API", async () => {
    const message = rosObservationMessageSchema.parse({
      ...observation,
      deviceId,
      sessionId: randomUUID(),
    });
    const repo = createTelemetryRepository(database!.db);
    const entry = (value: typeof message) => ({
      message: value,
      receivedAt: new Date(),
      isRetained: false,
    });
    expect(await repo.saveBatch([entry(message), entry(message)])).toEqual([
      "saved",
      "duplicate",
    ]);
    expect(
      await repo.saveBatch([
        entry({ ...message, payload: { ...message.payload, battery: 10 } }),
      ]),
    ).toEqual(["conflict"]);
    const legacy = {
      schemaVersion: 2 as const,
      deviceId,
      sessionId: message.sessionId,
      sequence: message.sequence,
      timestamp: message.timestamp,
      payload: {
        battery: 90,
        latitude: 35,
        longitude: 139,
        altitude: 10,
        temperature: 24,
        status: "IDLE" as const,
      },
    };
    expect(
      await repo.saveBatch([{ ...entry(message), message: legacy }]),
    ).toEqual(["conflict"]);
    expect(
      await database!.db
        .select()
        .from(telemetry)
        .where(eq(telemetry.deviceId, deviceId)),
    ).toEqual([]);
    expect(
      await database!.db
        .select()
        .from(rosObservations)
        .where(eq(rosObservations.deviceId, deviceId)),
    ).toHaveLength(1);
    const api = createDeviceRepository(database!.db);
    const detail = await api.findById(deviceId);
    expect(detail?.latestTelemetry).toBeNull();
    expect(detail?.latestObservation?.message.payload.position).toEqual(
      message.payload.position,
    );
    expect(
      (await api.list()).find((d) => d.deviceId === deviceId),
    ).toMatchObject({
      battery: 0,
      flightStatus: null,
      connectionStatus: "ONLINE",
    });
    expect(await api.observationHistory!(deviceId, 1)).toEqual([
      detail!.latestObservation,
    ]);
    const receipts = [];
    const logger = { warn() {}, error() {} };
    await ingestTelemetry(
      `fleet/v1/devices/${deviceId}/telemetry`,
      Buffer.from(JSON.stringify(message)),
      new Date(),
      {
        save: async (value, receivedAt, isRetained = false) =>
          (
            await repo.saveBatch([{ message: value, receivedAt, isRetained }])
          )[0],
      },
      logger,
      false,
      undefined,
      undefined,
      async (receipt) => {
        // 別transactionから行が見える＝commit後である。
        expect(
          await database!.db
            .select()
            .from(rosObservations)
            .where(eq(rosObservations.deviceId, deviceId)),
        ).toHaveLength(1);
        receipts.push(receipt);
      },
    );
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      status: "STORED",
      sessionId: message.sessionId,
      sequence: message.sequence,
    });
  });
});
