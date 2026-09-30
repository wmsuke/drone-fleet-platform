import { commands, createDatabase, devices } from "@drone-fleet/database";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createCommandRepository } from "../src/command-repository.js";

const runIntegration = process.env.DATABASE_INTEGRATION === "true";
const integration = describe.skipIf(!runIntegration);
const deviceId = "integration-command-api";
const otherDeviceId = `${deviceId}-other`;
const commandId = "5c15de4f-6957-4f4f-b3cf-8cb9e733d63c";
const migrationsFolder = fileURLToPath(
  new URL("../../../packages/database/drizzle", import.meta.url),
);
const database = runIntegration ? createDatabase() : undefined;

integration("command repository", () => {
  beforeAll(async () => {
    if (database !== undefined) {
      await migrate(database.db, { migrationsFolder });
    }
  });

  beforeEach(async () => {
    if (database !== undefined) {
      await database.db.delete(commands).where(eq(commands.deviceId, deviceId));
      await database.db
        .delete(commands)
        .where(eq(commands.deviceId, otherDeviceId));
      await database.db.delete(devices).where(eq(devices.deviceId, deviceId));
      await database.db
        .delete(devices)
        .where(eq(devices.deviceId, otherDeviceId));
    }
  });

  afterAll(async () => {
    if (database !== undefined) {
      await database.db.delete(commands).where(eq(commands.deviceId, deviceId));
      await database.db
        .delete(commands)
        .where(eq(commands.deviceId, otherDeviceId));
      await database.db.delete(devices).where(eq(devices.deviceId, deviceId));
      await database.db
        .delete(devices)
        .where(eq(devices.deviceId, otherDeviceId));
      await database.client.end();
    }
  });

  it("returns null without saving for an unregistered device", async () => {
    if (database === undefined) {
      throw new Error("database integration test is not configured");
    }
    const repository = createCommandRepository(database.db);

    await expect(
      repository.createPending(pendingCommand()),
    ).resolves.toBeNull();
    await expect(readCommand()).resolves.toBeUndefined();
  });

  it("persists PENDING and updates it to SENT", async () => {
    if (database === undefined) {
      throw new Error("database integration test is not configured");
    }
    await registerDevice();
    const repository = createCommandRepository(database.db);
    const sentAt = new Date("2026-09-30T02:00:01.000Z");

    await expect(
      repository.createPending(pendingCommand()),
    ).resolves.toMatchObject({ commandId, status: "PENDING" });
    await expect(repository.markSent(commandId, sentAt)).resolves.toMatchObject(
      {
        commandId,
        status: "SENT",
        sentAt: sentAt.toISOString(),
      },
    );
  });

  it("does not move ACKNOWLEDGED back to SENT or FAILED", async () => {
    if (database === undefined) {
      throw new Error("database integration test is not configured");
    }
    await registerDevice();
    const repository = createCommandRepository(database.db);
    await repository.createPending(pendingCommand());
    await database.db
      .update(commands)
      .set({
        status: "ACKNOWLEDGED",
        acknowledgementReceivedAt: new Date("2026-09-30T02:00:00.500Z"),
      })
      .where(eq(commands.commandId, commandId));

    await expect(
      repository.markSent(commandId, new Date("2026-09-30T02:00:01.000Z")),
    ).resolves.toMatchObject({ status: "ACKNOWLEDGED" });
    await expect(repository.markFailed(commandId)).resolves.toMatchObject({
      status: "ACKNOWLEDGED",
    });
  });

  it("returns only the target device commands in newest-first order", async () => {
    if (database === undefined) {
      throw new Error("database integration test is not configured");
    }
    await database.db
      .insert(devices)
      .values([{ deviceId }, { deviceId: otherDeviceId }]);
    await database.db.insert(commands).values([
      {
        commandId,
        deviceId,
        type: "RETURN_HOME",
        status: "ACKNOWLEDGED",
        createdAt: new Date("2026-09-30T02:00:00.000Z"),
        sentAt: new Date("2026-09-30T02:00:01.000Z"),
        acknowledgementReceivedAt: new Date("2026-09-30T02:00:02.000Z"),
      },
      {
        commandId: "6761a788-402d-4b44-b1fd-779ced12e54f",
        deviceId,
        type: "REBOOT",
        status: "TIMED_OUT",
        createdAt: new Date("2026-09-30T03:00:00.000Z"),
        sentAt: new Date("2026-09-30T03:00:01.000Z"),
        timedOutAt: new Date("2026-09-30T03:00:30.000Z"),
      },
      {
        commandId: "efb525c1-8abf-4dc4-b811-b60973b28b54",
        deviceId: otherDeviceId,
        type: "REBOOT",
        status: "FAILED",
        createdAt: new Date("2026-09-30T04:00:00.000Z"),
      },
    ]);
    const repository = createCommandRepository(database.db);

    await expect(repository.history(deviceId, 10)).resolves.toEqual([
      expect.objectContaining({
        commandId: "6761a788-402d-4b44-b1fd-779ced12e54f",
        status: "TIMED_OUT",
        timedOutAt: "2026-09-30T03:00:30.000Z",
      }),
      expect.objectContaining({
        commandId,
        status: "ACKNOWLEDGED",
        acknowledgementReceivedAt: "2026-09-30T02:00:02.000Z",
      }),
    ]);
    await expect(repository.history(deviceId, 1)).resolves.toHaveLength(1);
  });

  it("returns null for an unregistered device", async () => {
    if (database === undefined) {
      throw new Error("database integration test is not configured");
    }
    const repository = createCommandRepository(database.db);

    await expect(repository.history("unknown-device", 100)).resolves.toBeNull();
  });
});

function pendingCommand() {
  return {
    commandId,
    deviceId,
    type: "RETURN_HOME" as const,
    createdAt: new Date("2026-09-30T02:00:00.000Z"),
  };
}

async function registerDevice(): Promise<void> {
  if (database === undefined) {
    throw new Error("database integration test is not configured");
  }
  await database.db.insert(devices).values({ deviceId });
}

async function readCommand() {
  if (database === undefined) {
    throw new Error("database integration test is not configured");
  }
  const rows = await database.db
    .select()
    .from(commands)
    .where(eq(commands.commandId, commandId));
  return rows[0];
}
