import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { eq, inArray } from "drizzle-orm";
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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFleetOperationRepository } from "../src/fleet-operation-repository.js";
import { createGroupRepository } from "../src/group-repository.js";
import { createCommandAcknowledgementRepository } from "../../telemetry-ingestor/src/acknowledgement.js";
import { createCommandOutbox } from "../src/command-outbox.js";
import { buildApi } from "../src/app.js";
import { createDeviceRepository } from "../src/repository.js";
import { createCommandRepository } from "../src/command-repository.js";
import { createCommandService } from "../src/command-service.js";
import type { OperationTargetQuery } from "../src/fleet-operation-schema.js";

const enabled = process.env.DATABASE_INTEGRATION === "true";
const database = enabled ? createDatabase() : undefined;
const deviceIds = Array.from(
  { length: 100 },
  (_, i) => `integration-op-result-${String(i).padStart(3, "0")}`,
);
const groupIds: string[] = [];
const base = new Date("2026-10-14T00:00:00.000Z");
const at = (seconds: number) => new Date(base.getTime() + seconds * 1000);
let now = at(10);
const page: OperationTargetQuery = { limit: 100, offset: 0 };
function configured() {
  if (!database) throw new Error("missing test DB");
  return database;
}
function repo() {
  return createFleetOperationRepository(configured().db, {
    maxTargets: 100,
    clock: () => now,
  });
}
async function cleanup() {
  const { db } = configured();
  if (groupIds.length) {
    const ops = await db
      .select()
      .from(fleetOperations)
      .where(inArray(fleetOperations.groupId, groupIds));
    if (ops.length) {
      const ids = ops.map((o) => o.operationId);
      await db
        .delete(fleetOperationTargets)
        .where(inArray(fleetOperationTargets.operationId, ids));
      await db
        .delete(fleetOperations)
        .where(inArray(fleetOperations.operationId, ids));
    }
    await db
      .delete(groupMemberships)
      .where(inArray(groupMemberships.groupId, groupIds));
    await db.delete(groups).where(inArray(groups.groupId, groupIds.splice(0)));
  }
  await db.delete(commands).where(inArray(commands.deviceId, deviceIds));
  await db.delete(devices).where(inArray(devices.deviceId, deviceIds));
}
async function fixture(
  count = 2,
  type: "REBOOT" | "RETURN_HOME" = "RETURN_HOME",
  createdAt = base,
) {
  const { db } = configured();
  const groupId = randomUUID(),
    operationId = randomUUID();
  groupIds.push(groupId);
  await db.insert(groups).values({ groupId, name: "保存した隊名" });
  await db
    .insert(groupMemberships)
    .values(
      deviceIds.slice(0, count).map((deviceId) => ({ groupId, deviceId })),
    );
  const expiresAt = new Date(createdAt.getTime() + 30_000),
    resultDeadline = new Date(createdAt.getTime() + 120_000);
  await db.insert(fleetOperations).values({
    operationId,
    groupId,
    groupName: "保存した隊名",
    groupRevision: 1,
    type,
    idempotencyScope: "anonymous",
    idempotencyKey: operationId,
    targetCount: count,
    createdAt,
    expiresAt,
    resultDeadline,
  });
  const pending = deviceIds.slice(0, count).map((deviceId) => ({
    deviceId,
    commandId: randomUUID(),
    type,
    createdAt,
    expiresAt,
  }));
  await db.insert(commands).values(pending);
  await db.insert(commandOutbox).values(
    pending.map((c) => ({
      commandId: c.commandId,
      topic: `fleet/v1/devices/${c.deviceId}/commands`,
      payload: JSON.stringify({
        schemaVersion: 2,
        commandId: c.commandId,
        deviceId: c.deviceId,
        type,
        timestamp: createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      }),
      createdAt,
      expiresAt,
      nextAttemptAt: createdAt,
    })),
  );
  await db.insert(fleetOperationTargets).values(
    pending.map((c) => ({
      operationId,
      deviceId: c.deviceId,
      commandId: c.commandId,
    })),
  );
  return { operationId, groupId, pending };
}
type Pending = Awaited<ReturnType<typeof fixture>>["pending"][number];
async function notify(
  c: Pending,
  status: "RUNNING" | "SUCCEEDED" | "FAILED" | "UNCERTAIN",
  receivedAt = at(10),
) {
  return createCommandAcknowledgementRepository(configured().db).acknowledge(
    {
      schemaVersion: 3,
      commandId: c.commandId,
      deviceId: c.deviceId,
      status,
      startedAt: at(1).toISOString(),
      timestamp: at(status === "RUNNING" ? 1 : 5).toISOString(),
    },
    receivedAt,
  );
}
async function receipt(c: Pending, receivedAt = at(8)) {
  return createCommandAcknowledgementRepository(configured().db).acknowledge(
    {
      schemaVersion: 2,
      commandId: c.commandId,
      deviceId: c.deviceId,
      status: "ACKNOWLEDGED",
      timestamp: at(2).toISOString(),
    },
    receivedAt,
  );
}
describe.skipIf(!enabled)("fleet operation result aggregation", () => {
  beforeAll(async () => {
    await migrate(configured().db, {
      migrationsFolder: fileURLToPath(
        new URL("../../../packages/database/drizzle", import.meta.url),
      ),
    });
  });
  beforeEach(async () => {
    await cleanup();
    now = at(10);
    await configured()
      .db.insert(devices)
      .values(deviceIds.map((deviceId) => ({ deviceId })));
  });
  afterAll(async () => {
    await cleanup();
    await configured().client.end();
  });

  it("separates all target states and counts received evidence without double-counting", async () => {
    const f = await fixture(10);
    const c = f.pending;
    await configured()
      .db.update(commands)
      .set({ status: "SENT", sentAt: at(2) })
      .where(eq(commands.commandId, c[1]!.commandId));
    await receipt(c[2]!);
    await notify(c[3]!, "RUNNING");
    await notify(c[4]!, "SUCCEEDED");
    await receipt(c[4]!);
    await notify(c[5]!, "FAILED");
    await configured()
      .db.update(commands)
      .set({ status: "FAILED" })
      .where(eq(commands.commandId, c[6]!.commandId));
    await configured()
      .db.update(commands)
      .set({ status: "EXPIRED", expiredAt: at(3) })
      .where(eq(commands.commandId, c[7]!.commandId));
    await configured()
      .db.update(commands)
      .set({ status: "TIMED_OUT", timedOutAt: at(4) })
      .where(eq(commands.commandId, c[8]!.commandId));
    await notify(c[9]!, "UNCERTAIN");
    const result = (await repo().find(f.operationId, page))!;
    expect(result.status).toBe("IN_PROGRESS");
    expect(Object.values(result.counts)).toEqual(Array(10).fill(1));
    expect(result).toMatchObject({
      succeededCount: 1,
      unsuccessfulCount: 5,
      inProgressCount: 4,
      acknowledgedCount: 2,
    });
    expect(result.targets.items.map((t) => t.status)).toEqual([
      "PENDING",
      "SENT",
      "ACKNOWLEDGED",
      "RUNNING",
      "SUCCEEDED",
      "EXECUTION_FAILED",
      "DELIVERY_FAILED",
      "EXPIRED",
      "UNRESPONSIVE",
      "UNCERTAIN",
    ]);
    expect(result.targets.items[4]).toMatchObject({
      executionStatus: "SUCCEEDED",
      commandStatus: "ACKNOWLEDGED",
      updatedAt: at(10).toISOString(),
      executionResultAt: at(5).toISOString(),
    });
    expect(JSON.stringify(result)).not.toMatch(
      /idempotency|payload|topic|anonymous/,
    );
  });
  it("distinguishes accepted, in-progress, partial failure, all failure and all success", async () => {
    const f = await fixture();
    expect((await repo().find(f.operationId, page))!.status).toBe("ACCEPTED");
    await receipt(f.pending[0]!);
    expect((await repo().find(f.operationId, page))!.status).toBe(
      "IN_PROGRESS",
    );
    now = at(120);
    expect((await repo().find(f.operationId, page))!).toMatchObject({
      status: "FAILED",
      counts: { UNRESPONSIVE: 2 },
    });
    await notify(f.pending[0]!, "SUCCEEDED", at(130));
    now = at(130);
    expect((await repo().find(f.operationId, page))!.status).toBe(
      "PARTIALLY_FAILED",
    );
    await notify(f.pending[1]!, "SUCCEEDED", at(131));
    now = at(131);
    expect((await repo().find(f.operationId, page))!).toMatchObject({
      status: "COMPLETED",
      acknowledgedCount: 1,
      counts: { SUCCEEDED: 2 },
      updatedAt: at(131).toISOString(),
    });
  });
  it.each(["FAILED", "TIMED_OUT"] as const)(
    "evaluates late receipts and every execution state after delivery %s at the deadline boundary",
    async (delivery) => {
      const f = await fixture(5);
      await configured()
        .db.update(commands)
        .set({ status: delivery })
        .where(
          inArray(
            commands.commandId,
            f.pending.map((c) => c.commandId),
          ),
        );
      await receipt(f.pending[0]!, at(90));
      for (const [i, s] of (
        ["RUNNING", "SUCCEEDED", "FAILED", "UNCERTAIN"] as const
      ).entries())
        await notify(f.pending[i + 1]!, s, at(90));
      for (const second of [119.999, 120, 120.001]) {
        now = at(second);
        const result = (await repo().find(f.operationId, page))!;
        expect(result.targets.items.map((t) => t.status)).toEqual([
          second < 120 ? "ACKNOWLEDGED" : "UNRESPONSIVE",
          second < 120 ? "RUNNING" : "UNRESPONSIVE",
          "SUCCEEDED",
          "EXECUTION_FAILED",
          "UNCERTAIN",
        ]);
        expect(result.status).toBe(
          second < 120 ? "IN_PROGRESS" : "PARTIALLY_FAILED",
        );
      }
      // 期限後の受領/RUNNINGだけでは未応答を解消しない。
      await receipt(f.pending[1]!, at(121));
      expect(
        (await repo().find(f.operationId, page))!.targets.items[1]!.status,
      ).toBe("UNRESPONSIVE");
      await notify(f.pending[1]!, "SUCCEEDED", at(130));
      expect(
        (await repo().find(f.operationId, page))!.targets.items[1]!.status,
      ).toBe("SUCCEEDED");
    },
  );
  it.each([
    ["FAILED", 119.999],
    ["FAILED", 120],
    ["FAILED", 120.001],
    ["TIMED_OUT", 119.999],
    ["TIMED_OUT", 120],
    ["TIMED_OUT", 120.001],
  ] as const)(
    "handles newly received evidence after %s at %s seconds",
    async (delivery, seconds) => {
      const f = await fixture(5);
      await configured()
        .db.update(commands)
        .set({ status: delivery })
        .where(
          inArray(
            commands.commandId,
            f.pending.map((c) => c.commandId),
          ),
        );
      now = at(seconds);
      await receipt(f.pending[0]!, now);
      for (const [index, status] of (
        ["RUNNING", "SUCCEEDED", "FAILED", "UNCERTAIN"] as const
      ).entries())
        expect(await notify(f.pending[index + 1]!, status, now)).toBe(
          "updated",
        );
      const result = (await repo().find(f.operationId, page))!;
      expect(result.targets.items.map((t) => t.status)).toEqual([
        seconds < 120 ? "ACKNOWLEDGED" : "UNRESPONSIVE",
        seconds < 120 ? "RUNNING" : "UNRESPONSIVE",
        "SUCCEEDED",
        "EXECUTION_FAILED",
        "UNCERTAIN",
      ]);
      expect(
        Object.values(result.counts).reduce((sum, value) => sum + value, 0),
      ).toBe(5);
      expect(
        result.succeededCount +
          result.unsuccessfulCount +
          result.inProgressCount,
      ).toBe(5);
    },
  );
  it("re-evaluates without a worker and keeps expired and uncertain distinct from no response", async () => {
    const f = await fixture(4);
    await receipt(f.pending[0]!);
    await notify(f.pending[1]!, "RUNNING");
    await configured()
      .db.update(commands)
      .set({ status: "EXPIRED", expiredAt: at(30) })
      .where(eq(commands.commandId, f.pending[2]!.commandId));
    await notify(f.pending[3]!, "UNCERTAIN");
    now = at(120);
    const r = (await repo().find(f.operationId, page))!;
    expect(r).toMatchObject({
      status: "FAILED",
      counts: { UNRESPONSIVE: 2, EXPIRED: 1, UNCERTAIN: 1 },
      updatedAt: at(120).toISOString(),
    });
    const [stored] = await configured()
      .db.select()
      .from(commands)
      .where(eq(commands.commandId, f.pending[0]!.commandId));
    expect(stored!.status).toBe("ACKNOWLEDGED");
    expect(stored!.executionStatus).toBe("NOT_REPORTED");
    await notify(f.pending[3]!, "SUCCEEDED", at(130));
    expect((await repo().find(f.operationId, page))!.counts.UNCERTAIN).toBe(0);
  });
  it("does not promote conflicting expiry/results and preserves definitive results", async () => {
    const f = await fixture();
    const ack = createCommandAcknowledgementRepository(configured().db);
    const reject = (c: Pending) =>
      ack.acknowledge(
        {
          schemaVersion: 2,
          deviceId: c.deviceId,
          commandId: c.commandId,
          status: "REJECTED_EXPIRED",
          timestamp: at(31).toISOString(),
        },
        at(31),
      );
    await reject(f.pending[0]!);
    expect(await notify(f.pending[0]!, "SUCCEEDED")).toBe("conflict");
    await notify(f.pending[1]!, "SUCCEEDED");
    expect(await reject(f.pending[1]!)).toBe("conflict");
    expect(await notify(f.pending[1]!, "FAILED")).toBe("conflict");
    await notify(f.pending[1]!, "RUNNING");
    now = at(130);
    const r = (await repo().find(f.operationId, page))!;
    expect(r.targets.items.map((t) => t.status)).toEqual([
      "EXPIRED",
      "SUCCEEDED",
    ]);
    expect(r.status).toBe("PARTIALLY_FAILED");
  });
  it("reflects actual outbox transitions and ACK/results after each commit", async () => {
    const f = await fixture();
    now = at(2);
    const worker = createCommandOutbox(
      configured().client,
      async () => {},
      { pollMs: 1, baseMs: 1000, maxMs: 1000, maxAttempts: 1 },
      () => now,
      () => 0,
    );
    try {
      await worker.runOnce();
      let r = (await repo().find(f.operationId, page))!;
      expect(r.counts.SENT).toBe(2);
      expect(r.targets.items[0]).toMatchObject({
        attempts: 1,
        failures: 0,
        outboxState: "WAITING_ACK",
        updatedAt: now.toISOString(),
      });
      now = at(3);
      await receipt(f.pending[0]!, now);
      now = at(30);
      await worker.runOnce();
      r = (await repo().find(f.operationId, page))!;
      expect(r.targets.items.map((t) => t.status)).toEqual([
        "ACKNOWLEDGED",
        "UNRESPONSIVE",
      ]);
      expect(r.targets.items[1]).toMatchObject({
        commandStatus: "TIMED_OUT",
        outboxState: "TIMED_OUT",
        updatedAt: now.toISOString(),
      });
      await notify(f.pending[1]!, "SUCCEEDED", at(31));
      now = at(31);
      expect(
        (await repo().find(f.operationId, page))!.targets.items[1]!.status,
      ).toBe("SUCCEEDED");
    } finally {
      await worker.stop();
    }
  });
  it("reports the actual delivery-failure update time rather than its future retry time", async () => {
    const f = await fixture(1);
    now = at(4);
    const worker = createCommandOutbox(
      configured().client,
      async () => {
        throw new Error("disconnected");
      },
      { pollMs: 1, baseMs: 1000, maxMs: 1000, maxAttempts: 1 },
      () => now,
      () => 0,
    );
    try {
      await worker.runOnce();
      expect((await repo().find(f.operationId, page))!).toMatchObject({
        status: "FAILED",
        targets: {
          items: [
            {
              status: "DELIVERY_FAILED",
              failures: 1,
              updatedAt: now.toISOString(),
            },
          ],
        },
      });
    } finally {
      await worker.stop();
    }
  });

  it("does not expose uncommitted partial updates and reads consistent counts and target pages", async () => {
    const f = await fixture();
    let release!: () => void;
    let prepared!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      prepared = resolve;
    });
    const write = configured().client.begin(async (tx) => {
      await tx`UPDATE commands SET status='SENT', sent_at=${at(2).toISOString()} WHERE command_id=${f.pending[0]!.commandId}`;
      prepared();
      await gate;
      await tx`UPDATE commands SET status='SENT', sent_at=${at(2).toISOString()} WHERE command_id=${f.pending[1]!.commandId}`;
    });
    try {
      await Promise.race([
        ready,
        write.then(() => {
          throw new Error("write ended before preparation");
        }),
      ]);
      const before = (await repo().find(f.operationId, page))!;
      expect(before.status).toBe("ACCEPTED");
      expect(before.counts.PENDING).toBe(2);
      expect(before.targets.items.map((t) => t.status)).toEqual([
        "PENDING",
        "PENDING",
      ]);
    } finally {
      release();
      await write;
    }
    const after = (await repo().find(f.operationId, page))!;
    expect(after.status).toBe("IN_PROGRESS");
    expect(after.counts.SENT).toBe(2);
    expect(after.targets.items.map((t) => t.status)).toEqual(["SENT", "SENT"]);
  });
  it("paginates/filter targets while retaining whole-operation counts and stored group snapshot", async () => {
    const f = await fixture(4);
    await notify(f.pending[0]!, "SUCCEEDED");
    await notify(f.pending[2]!, "SUCCEEDED");
    const gr = createGroupRepository(configured().db);
    await gr.removeMember(f.groupId, deviceIds[0]!);
    await gr.update(f.groupId, { name: "変更後" });
    await gr.remove(f.groupId);
    const r = (await repo().find(f.operationId, {
      limit: 1,
      offset: 1,
      status: "SUCCEEDED",
    }))!;
    expect(r).toMatchObject({
      groupName: "保存した隊名",
      groupRevision: 1,
      targetCount: 4,
      counts: { SUCCEEDED: 2, PENDING: 2 },
      targets: { total: 2, items: [{ deviceId: deviceIds[2] }] },
    });
    expect(
      (await repo().find(f.operationId, { ...page, deviceId: deviceIds[0] }))!
        .targets.total,
    ).toBe(1);
    expect(
      (await repo().find(f.operationId, {
        ...page,
        deviceId: "unknown-device",
      }))!.targets,
    ).toMatchObject({ total: 0, items: [] });
    expect(
      (await repo().find(f.operationId, { limit: 1, offset: 50 }))!.targets,
    ).toMatchObject({ total: 4, items: [] });
    // 削除APIは設けない。参照中のoperation/group/command/deviceの物理削除は拒否する。
    await expect(
      configured()
        .db.delete(fleetOperations)
        .where(eq(fleetOperations.operationId, f.operationId)),
    ).rejects.toThrow();
    await expect(
      configured().db.delete(groups).where(eq(groups.groupId, f.groupId)),
    ).rejects.toThrow();
    await expect(
      configured()
        .db.delete(commands)
        .where(eq(commands.commandId, f.pending[0]!.commandId)),
    ).rejects.toThrow();
    await expect(
      configured()
        .db.delete(devices)
        .where(eq(devices.deviceId, deviceIds[0]!)),
    ).rejects.toThrow();
  });
  it("lists/filter operations by current aggregate state, group, type, dates and stable ordering", async () => {
    const f = await fixture(1),
      g = await fixture(1, "REBOOT"),
      h = await fixture(1, "REBOOT", at(1));
    await notify(f.pending[0]!, "SUCCEEDED");
    const list = await repo().list({ limit: 2, offset: 0 });
    expect(list.total).toBe(3);
    expect(list.items[0]!.operationId).toBe(h.operationId);
    expect((await repo().list({ limit: 2, offset: 2 })).items).toHaveLength(1);
    expect(await repo().list({ limit: 1, offset: 10 })).toMatchObject({
      total: 3,
      items: [],
    });
    expect(
      (
        await repo().list({
          limit: 10,
          offset: 0,
          groupId: f.groupId,
          status: "COMPLETED",
          type: "RETURN_HOME",
        })
      ).items.map((o) => o.operationId),
    ).toEqual([f.operationId]);
    expect(
      (
        await repo().list({
          limit: 10,
          offset: 0,
          type: "REBOOT",
          from: at(1).toISOString(),
          to: at(1).toISOString(),
        })
      ).items.map((o) => o.operationId),
    ).toEqual([h.operationId]);
    expect(
      await repo().list({
        limit: 10,
        offset: 0,
        groupId: g.groupId,
        status: "COMPLETED",
      }),
    ).toMatchObject({ total: 0, items: [] });
    now = at(121);
    expect(
      (await repo().list({ limit: 10, offset: 0, status: "FAILED" })).total,
    ).toBe(2);
    expect(await repo().find(randomUUID(), page)).toBeNull();
  });
  it("uses one query for 1 and 100 targets and bounded list/detail pages", async () => {
    const f = await fixture(1),
      g = await fixture(100);
    let queries = 0;
    const db = drizzle(configured().client, {
      schema,
      logger: {
        logQuery() {
          queries++;
        },
      },
    });
    let clocks = 0;
    const r = createFleetOperationRepository(db, {
      maxTargets: 100,
      clock: () => {
        clocks++;
        return now;
      },
    });
    for (const operationId of [f.operationId, g.operationId]) {
      queries = 0;
      clocks = 0;
      const start = performance.now();
      const result = (await r.find(operationId, { limit: 10, offset: 0 }))!;
      expect(queries).toBe(1);
      expect(clocks).toBe(1);
      expect(result.targets.items.length).toBe(
        Math.min(result.targetCount, 10),
      );
      console.log(
        JSON.stringify({
          targets: result.targetCount,
          queryCount: queries,
          durationMs: Number((performance.now() - start).toFixed(3)),
          returnedTargets: result.targets.items.length,
        }),
      );
    }
    queries = 0;
    clocks = 0;
    const list = await r.list({ limit: 1, offset: 0 });
    expect(queries).toBe(1);
    expect(clocks).toBe(1);
    expect(list.total).toBe(2);
    expect(list.items).toHaveLength(1);
  });
  it("returns aggregates through the API with the real repository", async () => {
    const f = await fixture();
    await notify(f.pending[0]!, "SUCCEEDED");
    now = at(120);
    const app = buildApi(
      createDeviceRepository(configured().db),
      createCommandService(createCommandRepository(configured().db)),
      { fleetOperationRepository: repo() },
    );
    try {
      const detail = await app.inject(
        `/fleet-operations/${f.operationId}?status=SUCCEEDED&limit=1`,
      );
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toMatchObject({
        status: "PARTIALLY_FAILED",
        counts: { UNRESPONSIVE: 1, SUCCEEDED: 1 },
        targets: { total: 1 },
      });
      expect(
        (await app.inject(`/fleet-operations?status=PARTIALLY_FAILED`)).json()
          .total,
      ).toBe(1);
      expect(
        (await app.inject(`/fleet-operations/${randomUUID()}`)).statusCode,
      ).toBe(404);
    } finally {
      await app.close();
    }
  });
});
