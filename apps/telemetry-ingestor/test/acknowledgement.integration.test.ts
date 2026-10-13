import { commands, createDatabase, devices } from "@drone-fleet/database";
import type { CommandAcknowledgementMessage } from "@drone-fleet/protocol";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createCommandAcknowledgementRepository } from "../src/acknowledgement.js";

const runIntegration = process.env.DATABASE_INTEGRATION === "true";
const integration = describe.skipIf(!runIntegration);
const deviceId = "integration-command-ack";
const otherDeviceId = "integration-command-ack-other";
const commandId = "5c15de4f-6957-4f4f-b3cf-8cb9e733d63c";
const migrationsFolder = fileURLToPath(
  new URL("../../../packages/database/drizzle", import.meta.url),
);
const database = runIntegration ? createDatabase() : undefined;

function acknowledgement(
  receivedDeviceId = deviceId,
): CommandAcknowledgementMessage {
  return {
    schemaVersion: 1,
    commandId,
    deviceId: receivedDeviceId,
    status: "ACKNOWLEDGED",
    timestamp: "2026-09-30T02:00:01.000Z",
  };
}

integration("command acknowledgement repository", () => {
  it("records a late acceptance ACK without undoing an earlier expiry rejection", async () => {
    if (database === undefined) throw new Error("database required");
    await database.db.insert(commands).values({
      commandId,
      deviceId,
      type: "REBOOT",
      expiresAt: new Date("2026-10-13T00:00:30Z"),
    });
    const repository = createCommandAcknowledgementRepository(database.db);
    const ack = { ...acknowledgement(), schemaVersion: 2 as const };
    await repository.acknowledge(
      { ...ack, status: "REJECTED_EXPIRED" },
      new Date(),
    );
    expect(await repository.acknowledge(ack, new Date())).toBe("updated");
    expect(await readCommand()).toMatchObject({
      status: "EXPIRED",
      acknowledgementReceivedAt: expect.any(Date),
    });
  });
  it("keeps expiry terminal while preserving a previously accepted ACK and ignores v1 for v2 commands", async () => {
    if (database === undefined) throw new Error("database required");
    await database.db.insert(commands).values({
      commandId,
      deviceId,
      type: "RETURN_HOME",
      expiresAt: new Date("2026-10-13T00:00:30Z"),
    });
    const repository = createCommandAcknowledgementRepository(database.db);
    expect(await repository.acknowledge(acknowledgement(), new Date())).toBe(
      "not_found",
    );
    const ack = { ...acknowledgement(), schemaVersion: 2 as const };
    const acceptedAt = new Date("2026-10-13T00:00:01Z");
    expect(await repository.acknowledge(ack, acceptedAt)).toBe("updated");
    expect(
      await repository.acknowledge(
        { ...ack, status: "REJECTED_EXPIRED" },
        new Date("2026-10-13T00:00:30Z"),
      ),
    ).toBe("updated");
    expect(
      await repository.acknowledge(ack, new Date("2026-10-13T00:00:31Z")),
    ).toBe("duplicate");
    expect(await readCommand()).toMatchObject({
      status: "EXPIRED",
      acknowledgementReceivedAt: acceptedAt,
      expiredAt: new Date("2026-10-13T00:00:30Z"),
    });
  });

  it("rejects a v2 ACK for an existing v1 command", async () => {
    if (database === undefined) throw new Error("database required");
    await database.db
      .insert(commands)
      .values({ commandId, deviceId, type: "REBOOT", status: "SENT" });
    expect(
      await createCommandAcknowledgementRepository(database.db).acknowledge(
        { ...acknowledgement(), schemaVersion: 2 },
        new Date(),
      ),
    ).toBe("not_found");
    expect(await readCommand()).toMatchObject({ status: "SENT" });
  });
  beforeAll(async () => {
    if (database !== undefined) {
      await migrate(database.db, { migrationsFolder });
    }
  });

  beforeEach(async () => {
    if (database === undefined) {
      return;
    }
    await database.db.delete(commands).where(eq(commands.commandId, commandId));
    await database.db.delete(devices).where(eq(devices.deviceId, deviceId));
    await database.db
      .delete(devices)
      .where(eq(devices.deviceId, otherDeviceId));
    await database.db
      .insert(devices)
      .values([{ deviceId }, { deviceId: otherDeviceId }]);
  });

  afterAll(async () => {
    if (database !== undefined) {
      await database.db
        .delete(commands)
        .where(eq(commands.commandId, commandId));
      await database.db.delete(devices).where(eq(devices.deviceId, deviceId));
      await database.db
        .delete(devices)
        .where(eq(devices.deviceId, otherDeviceId));
      await database.client.end();
    }
  });

  it("updates a matching command and treats the same ACK as a duplicate", async () => {
    if (database === undefined) {
      throw new Error("database integration test is not configured");
    }
    const repository = createCommandAcknowledgementRepository(database.db);
    const firstReceivedAt = new Date("2026-09-30T02:00:02.000Z");
    await database.db.insert(commands).values({
      commandId,
      deviceId,
      type: "RETURN_HOME",
      status: "SENT",
    });

    await expect(
      repository.acknowledge(acknowledgement(), firstReceivedAt),
    ).resolves.toBe("updated");
    await expect(
      repository.acknowledge(
        acknowledgement(),
        new Date("2026-09-30T02:00:03.000Z"),
      ),
    ).resolves.toBe("duplicate");
    await expect(readCommand()).resolves.toMatchObject({
      status: "ACKNOWLEDGED",
      acknowledgementReceivedAt: firstReceivedAt,
    });
  });

  it("does not update an unknown or device-mismatched ACK", async () => {
    if (database === undefined) {
      throw new Error("database integration test is not configured");
    }
    const repository = createCommandAcknowledgementRepository(database.db);
    await database.db.insert(commands).values({
      commandId,
      deviceId,
      type: "REBOOT",
      status: "SENT",
    });

    await expect(
      repository.acknowledge(acknowledgement(otherDeviceId), new Date()),
    ).resolves.toBe("not_found");
    await expect(readCommand()).resolves.toMatchObject({ status: "SENT" });
  });

  it("acknowledges a timed-out command while preserving timeout metadata", async () => {
    if (database === undefined) {
      throw new Error("database integration test is not configured");
    }
    const repository = createCommandAcknowledgementRepository(database.db);
    const timedOutAt = new Date("2026-09-30T02:00:30.000Z");
    const receivedAt = new Date("2026-09-30T02:00:31.000Z");
    await database.db.insert(commands).values({
      commandId,
      deviceId,
      type: "RETURN_HOME",
      status: "TIMED_OUT",
      timedOutAt,
    });

    await expect(
      repository.acknowledge(acknowledgement(), receivedAt),
    ).resolves.toBe("updated");
    await expect(readCommand()).resolves.toMatchObject({
      status: "ACKNOWLEDGED",
      acknowledgementReceivedAt: receivedAt,
      timedOutAt,
    });
  });
});

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
