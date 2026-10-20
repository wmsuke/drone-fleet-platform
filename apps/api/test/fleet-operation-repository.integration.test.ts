import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import {
  createDatabase,
  devices,
  groups,
  groupMemberships,
  commands,
  commandOutbox,
  fleetOperations,
  fleetOperationTargets,
} from "@drone-fleet/database";
import * as schema from "../../../packages/database/src/schema.js";
import { commandV2MessageSchema } from "@drone-fleet/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFleetOperationRepository } from "../src/fleet-operation-repository.js";
import { createGroupRepository } from "../src/group-repository.js";
import { buildApi } from "../src/app.js";
import { createDeviceRepository } from "../src/repository.js";
import { createCommandService } from "../src/command-service.js";
import { createCommandRepository } from "../src/command-repository.js";
const enabled = process.env.DATABASE_INTEGRATION === "true";
const database = enabled ? createDatabase() : undefined;
const groupIds: string[] = [],
  deviceIds = Array.from(
    { length: 100 },
    (_, index) => `integration-operation-${index}`,
  );
function configured() {
  if (!database) throw new Error("integration database is not configured");
  return database;
}
async function cleanup() {
  const { db } = configured();
  if (groupIds.length) {
    const operations = await db
      .select()
      .from(fleetOperations)
      .where(inArray(fleetOperations.groupId, groupIds));
    const opIds = operations.map((row) => row.operationId);
    if (opIds.length) {
      const targets = await db
        .select()
        .from(fleetOperationTargets)
        .where(inArray(fleetOperationTargets.operationId, opIds));
      await db
        .delete(fleetOperationTargets)
        .where(inArray(fleetOperationTargets.operationId, opIds));
      await db
        .delete(fleetOperations)
        .where(inArray(fleetOperations.operationId, opIds));
      if (targets.length)
        await db.delete(commands).where(
          inArray(
            commands.commandId,
            targets.map((row) => row.commandId),
          ),
        );
    }
    await db
      .delete(groupMemberships)
      .where(inArray(groupMemberships.groupId, groupIds));
    await db.delete(groups).where(inArray(groups.groupId, groupIds.splice(0)));
  }
  await db.delete(commands).where(inArray(commands.deviceId, deviceIds));
  await db.delete(devices).where(inArray(devices.deviceId, deviceIds));
}
async function group(count = 2) {
  const { db } = configured();
  const groupId = randomUUID();
  groupIds.push(groupId);
  await db.insert(groups).values({ groupId, name: "試験隊" });
  if (count)
    await db
      .insert(groupMemberships)
      .values(
        deviceIds.slice(0, count).map((deviceId) => ({ groupId, deviceId })),
      );
  return groupId;
}
describe.skipIf(!enabled)("fleet operation acceptance", () => {
  beforeAll(async () => {
    await migrate(configured().db, {
      migrationsFolder: fileURLToPath(
        new URL("../../../packages/database/drizzle", import.meta.url),
      ),
    });
  });
  beforeEach(async () => {
    await cleanup();
    await configured()
      .db.insert(devices)
      .values(
        deviceIds.map((deviceId) => ({
          deviceId,
          connectionStatus: "OFFLINE" as const,
        })),
      );
  });
  afterAll(async () => {
    await cleanup();
    await configured().client.end();
  });
  it("snapshots membership and creates distinct v2 commands/outboxes atomically", async () => {
    const { db } = configured();
    const groupId = await group();
    const repo = createFleetOperationRepository(db);
    const accepted = await repo.create(
      { groupId, type: "RETURN_HOME" },
      "snapshot",
    );
    expect(accepted).toMatchObject({ status: "ACCEPTED", targetCount: 2 });
    const targets = await db
      .select()
      .from(fleetOperationTargets)
      .where(eq(fleetOperationTargets.operationId, accepted.operationId));
    expect(new Set(targets.map((row) => row.commandId)).size).toBe(2);
    const rows = await db
      .select({
        target: fleetOperationTargets,
        command: commands,
        outbox: commandOutbox,
      })
      .from(fleetOperationTargets)
      .innerJoin(
        commands,
        eq(commands.commandId, fleetOperationTargets.commandId),
      )
      .innerJoin(commandOutbox, eq(commandOutbox.commandId, commands.commandId))
      .where(eq(fleetOperationTargets.operationId, accepted.operationId));
    for (const row of rows) {
      expect(row.command.status).toBe("PENDING");
      expect(row.command.deviceId).toBe(row.target.deviceId);
      expect(row.outbox.attempts).toBe(0);
      expect(row.outbox.topic).toBe(
        `fleet/v1/devices/${row.target.deviceId}/commands`,
      );
      expect(
        commandV2MessageSchema.parse(JSON.parse(row.outbox.payload)),
      ).toMatchObject({
        commandId: row.command.commandId,
        deviceId: row.target.deviceId,
        expiresAt: accepted.expiresAt,
      });
    }
    await createGroupRepository(db).removeMember(groupId, deviceIds[0]!);
    await createGroupRepository(db).update(groupId, { name: "変更隊" });
    await createGroupRepository(db).remove(groupId);
    const [stored] = await db
      .select()
      .from(fleetOperations)
      .where(eq(fleetOperations.operationId, accepted.operationId));
    expect(stored).toMatchObject({
      groupName: "試験隊",
      groupRevision: 1,
      targetCount: 2,
      actorKind: "anonymous",
    });
    expect(
      await repo.create({ groupId, type: "RETURN_HOME" }, "snapshot"),
    ).toEqual(accepted);
    expect(
      await db
        .select()
        .from(fleetOperationTargets)
        .where(eq(fleetOperationTargets.operationId, accepted.operationId)),
    ).toHaveLength(2);
    await expect(
      db.delete(commands).where(eq(commands.commandId, targets[0]!.commandId)),
    ).rejects.toThrow();
  });
  it("serializes simultaneous requests with the same key, and rejects changed requests", async () => {
    const { db } = configured();
    const groupId = await group();
    const repo = createFleetOperationRepository(db);
    const request = { groupId, type: "REBOOT" as const };
    const results = await Promise.all([
      repo.create(request, "same-key"),
      repo.create(request, "same-key"),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(
      await db
        .select()
        .from(fleetOperations)
        .where(eq(fleetOperations.groupId, groupId)),
    ).toHaveLength(1);
    await expect(
      repo.create({ groupId, type: "RETURN_HOME" }, "same-key"),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      repo.create({ groupId: await group(), type: "REBOOT" }, "same-key"),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("rejects empty, unknown, deleted and oversized groups without consuming keys", async () => {
    const { db } = configured();
    const repo = createFleetOperationRepository(db, { maxTargets: 1 });
    await expect(
      repo.create({ groupId: randomUUID(), type: "REBOOT" }, "rejected"),
    ).rejects.toMatchObject({ status: 404 });
    const empty = await group(0);
    await expect(
      repo.create({ groupId: empty, type: "REBOOT" }, "rejected"),
    ).rejects.toMatchObject({ status: 409 });
    const tooLarge = await group();
    await expect(
      repo.create({ groupId: tooLarge, type: "REBOOT" }, "rejected"),
    ).rejects.toMatchObject({ status: 400 });
    const deleted = await group(1);
    await createGroupRepository(db).remove(deleted);
    await expect(
      repo.create({ groupId: deleted, type: "REBOOT" }, "rejected"),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (
        await repo.create(
          { groupId: await group(1), type: "REBOOT" },
          "rejected",
        )
      ).targetCount,
    ).toBe(1);
  });
  it("rolls back every row if outbox insertion fails and allows retry with the same key", async () => {
    const { db, client } = configured();
    const groupId = await group();
    const repo = createFleetOperationRepository(db);
    await client.unsafe(
      "CREATE FUNCTION issue139_fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.topic LIKE 'fleet/v1/devices/integration-operation-%' THEN RAISE EXCEPTION 'forced test failure'; END IF; RETURN NEW; END $$",
    );
    await client.unsafe(
      "CREATE TRIGGER issue139_fail_outbox BEFORE INSERT ON command_outbox FOR EACH ROW EXECUTE FUNCTION issue139_fail_outbox()",
    );
    try {
      await expect(
        repo.create({ groupId, type: "REBOOT" }, "rollback"),
      ).rejects.toThrow();
      expect(
        await db
          .select()
          .from(fleetOperations)
          .where(eq(fleetOperations.groupId, groupId)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(commands)
          .where(inArray(commands.deviceId, deviceIds)),
      ).toHaveLength(0);
      expect(await db.select().from(fleetOperationTargets)).toHaveLength(0);
    } finally {
      await client.unsafe(
        "DROP TRIGGER issue139_fail_outbox ON command_outbox",
      );
      await client.unsafe("DROP FUNCTION issue139_fail_outbox()");
    }
    expect(
      (await repo.create({ groupId, type: "REBOOT" }, "rollback")).targetCount,
    ).toBe(2);
  });
  it("takes a coherent snapshot when membership changes concurrently", async () => {
    const { db } = configured();
    const groupId = await group();
    const repo = createFleetOperationRepository(db);
    const [accepted] = await Promise.all([
      repo.create({ groupId, type: "REBOOT" }, "concurrent-membership"),
      createGroupRepository(db).removeMember(groupId, deviceIds[0]!),
    ]);
    const [operation] = await db
      .select()
      .from(fleetOperations)
      .where(eq(fleetOperations.operationId, accepted.operationId));
    const targets = await db
      .select()
      .from(fleetOperationTargets)
      .where(eq(fleetOperationTargets.operationId, accepted.operationId));
    if (targets.length === 2) expect(operation!.groupRevision).toBe(1);
    else {
      expect(targets.map((row) => row.deviceId)).toEqual([deviceIds[1]]);
      expect(operation!.groupRevision).toBe(2);
    }
  });
  it("reports creation stages only after commit and does not fail acceptance when metrics fail", async () => {
    const { db } = configured();
    const groupId = await group();
    const metrics: {
      operationId: string;
      stagesMs: Record<string, number>;
      durationMs: number;
    }[] = [];
    const repo = createFleetOperationRepository(db, {
      maxTargets: 100,
      onAccepted(value) {
        metrics.push(value);
        throw new Error("metrics unavailable");
      },
    });
    const accepted = await repo.create(
      { groupId, type: "RETURN_HOME" },
      "metrics",
    );
    expect(metrics).toHaveLength(1);
    expect(metrics[0]!.operationId).toBe(accepted.operationId);
    expect(Object.keys(metrics[0]!.stagesMs)).toEqual([
      "validationAndLocks",
      "operation",
      "commands",
      "outbox",
      "targets",
      "auditAndCommit",
    ]);
    expect(
      Object.values(metrics[0]!.stagesMs).every(
        (v) => Number.isFinite(v) && v >= 0,
      ),
    ).toBe(true);
    expect(
      Object.values(metrics[0]!.stagesMs).reduce((a, b) => a + b, 0),
    ).toBeLessThanOrEqual(metrics[0]!.durationMs);
    expect(
      await db
        .select()
        .from(fleetOperations)
        .where(eq(fleetOperations.operationId, accepted.operationId)),
    ).toHaveLength(1);
  });
  it("benchmarks three 100-target acceptances with actual query counting", async () => {
    const { client } = configured();
    const groupId = await group(100);
    let queryCount = 0;
    const db = drizzle(client, {
      schema,
      logger: {
        logQuery() {
          queryCount++;
        },
      },
    });
    const repo = createFleetOperationRepository(db);
    const measurements = [];
    for (let run = 0; run < 3; run++) {
      queryCount = 0;
      const start = performance.now();
      const accepted = await repo.create(
        { groupId, type: "RETURN_HOME" },
        `benchmark-${run}`,
      );
      measurements.push({
        run: run + 1,
        targets: accepted.targetCount,
        durationMs: Number((performance.now() - start).toFixed(3)),
        queryCount,
      });
      // 既存8件にoperation audit、command auditの一括INSERT、checkpointを加える。
      expect(queryCount).toBe(11);
      expect(accepted.targetCount).toBe(100);
    }
    console.info("issue139 benchmark", JSON.stringify(measurements));
  });
  it("wires acceptance into the production app and preserves single-device commands", async () => {
    const { db } = configured();
    const groupId = await group();
    const app = buildApi(
      createDeviceRepository(db),
      createCommandService(createCommandRepository(db)),
      { fleetOperationRepository: createFleetOperationRepository(db) },
    );
    try {
      const accepted = await app.inject({
        method: "POST",
        url: "/fleet-operations",
        headers: { "Idempotency-Key": "api" },
        payload: { groupId, type: "REBOOT" },
      });
      expect(accepted.statusCode).toBe(202);
      const single = await app.inject({
        method: "POST",
        url: `/devices/${deviceIds[0]}/commands`,
        payload: { type: "RETURN_HOME" },
      });
      expect(single.statusCode).toBe(202);
      expect(single.json()).toMatchObject({
        status: "PENDING",
        deviceId: deviceIds[0],
      });
      const [operation] = await db
        .select()
        .from(fleetOperations)
        .where(
          and(
            eq(fleetOperations.groupId, groupId),
            eq(fleetOperations.idempotencyKey, "api"),
          ),
        );
      expect(operation!.targetCount).toBe(2);
    } finally {
      await app.close();
    }
  });
});
