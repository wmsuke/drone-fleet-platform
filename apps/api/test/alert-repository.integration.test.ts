import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  createDatabase,
  alerts,
  devices,
  groups,
  groupMemberships,
  commands,
  fleetOperations,
  fleetOperationTargets,
} from "@drone-fleet/database";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAlertRepository } from "../src/alert-repository.js";
import { alertQuerySchema } from "../src/alert-schema.js";
const enabled = process.env.DATABASE_INTEGRATION === "true";
const database = enabled ? createDatabase() : undefined;
function configured() {
  if (!database) throw new Error("integration database is not configured");
  return database;
}
const deviceId = "integration-alert-api";
const groupId = randomUUID();
const operationId = randomUUID();
const commandId = randomUUID();
async function clean() {
  const { db } = configured();
  await db.delete(alerts).where(eq(alerts.deviceId, deviceId));
  await db
    .delete(fleetOperationTargets)
    .where(eq(fleetOperationTargets.operationId, operationId));
  await db
    .delete(fleetOperations)
    .where(eq(fleetOperations.operationId, operationId));
  await db.delete(commands).where(eq(commands.commandId, commandId));
  await db
    .delete(groupMemberships)
    .where(eq(groupMemberships.groupId, groupId));
  await db.delete(groups).where(eq(groups.groupId, groupId));
  await db.delete(devices).where(eq(devices.deviceId, deviceId));
}
async function seed(
  status: "ACTIVE" | "RESOLVED" = "ACTIVE",
  at = "2026-10-19T00:00:00Z",
) {
  const alertId = randomUUID();
  await configured()
    .db.insert(alerts)
    .values({
      alertId,
      deviceId,
      deduplicationKey: alertId,
      kind: "OFFLINE",
      status,
      severity: "warning",
      reason: "OFFLINE",
      occurredAt: new Date(at),
      lastObservedAt: new Date(at),
      resolvedAt: status === "RESOLVED" ? new Date(at) : null,
      ruleVersion: "test",
      parameters: {},
      evidence: {},
    });
  return alertId;
}
describe.skipIf(!enabled)("alert repository PostgreSQL", () => {
  it("uses historical operation membership for command alerts after group rename/removal", async () => {
    const { db } = configured();
    const repo = createAlertRepository(db);
    await db.insert(groups).values({ groupId, name: "現在名" });
    await db.insert(commands).values({ commandId, deviceId, type: "REBOOT" });
    await db.insert(fleetOperations).values({
      operationId,
      groupId,
      groupName: "開始時名",
      groupRevision: 1,
      type: "REBOOT",
      idempotencyScope: "alert-test",
      idempotencyKey: operationId,
      targetCount: 1,
      createdAt: new Date("2026-10-19T00:00:00Z"),
      expiresAt: new Date("2026-10-19T00:01:00Z"),
      resultDeadline: new Date("2026-10-19T00:02:00Z"),
    });
    await db
      .insert(fleetOperationTargets)
      .values({ operationId, deviceId, commandId });
    const id = await seed();
    await db
      .update(alerts)
      .set({ kind: "COMMAND_OUTCOME", commandId })
      .where(eq(alerts.alertId, id));
    await db
      .update(groups)
      .set({ deletedAt: new Date() })
      .where(eq(groups.groupId, groupId));
    const result = await repo.list(
      alertQuerySchema.parse({ groupId, operationId }),
    );
    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({
      operationId,
      relatedGroups: [{ groupId, name: "開始時名" }],
    });
  });
  beforeAll(async () => {
    await migrate(configured().db, {
      migrationsFolder: fileURLToPath(
        new URL("../../../packages/database/drizzle", import.meta.url),
      ),
    });
  });
  beforeEach(async () => {
    await clean();
    await configured().db.insert(devices).values({ deviceId });
  });
  afterAll(async () => {
    await clean();
    await configured().client.end();
  });
  it("pages deterministically, filters status/kind/severity/device/group/time and returns totals", async () => {
    await Promise.all(
      Array.from({ length: 35 }, (_, i) => seed(i % 2 ? "ACTIVE" : "RESOLVED")),
    );
    await configured().db.insert(groups).values({ groupId, name: "訓練隊" });
    await configured()
      .db.insert(groupMemberships)
      .values({ groupId, deviceId });
    const repo = createAlertRepository(configured().db);
    const q = alertQuerySchema.parse({
      deviceId,
      groupId,
      severity: "warning",
      kind: "OFFLINE",
      from: "2026-10-19T00:00:00Z",
      to: "2026-10-19T00:00:01Z",
    });
    const first = await repo.list(q);
    const second = await repo.list({ ...q, offset: 20 });
    expect(first.total).toBe(35);
    expect(first.items).toHaveLength(20);
    expect(second.items).toHaveLength(15);
    expect(
      new Set([...first.items, ...second.items].map((a) => a.alertId)).size,
    ).toBe(35);
    expect(first.items[0]?.relatedGroups).toEqual([
      { groupId, name: "訓練隊" },
    ]);
    expect((await repo.list({ ...q, status: "ACTIVE" })).total).toBe(17);
    expect((await repo.list({ ...q, kind: "LOW_BATTERY" })).total).toBe(0);
    expect((await repo.list({ ...q, offset: 100 })).items).toEqual([]);
    expect((await repo.list({ ...q, operationId: randomUUID() })).total).toBe(
      0,
    );
  });
  it("acknowledges once under concurrency without resolving and preserves acknowledgement on resolution", async () => {
    const id = await seed();
    const repo = createAlertRepository(configured().db);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => repo.acknowledge(id)),
    );
    expect(new Set(results.map((a) => a?.acknowledgedAt)).size).toBe(1);
    expect(results[0]).toMatchObject({
      status: "ACTIVE",
      acknowledgedActorKind: "anonymous",
      acknowledgedActorId: null,
      resolvedAt: null,
    });
    const time = results[0]?.acknowledgedAt;
    await configured()
      .db.update(alerts)
      .set({ status: "RESOLVED", resolvedAt: new Date() })
      .where(eq(alerts.alertId, id));
    expect(await repo.acknowledge(id)).toMatchObject({
      status: "RESOLVED",
      acknowledgedAt: time,
    });
    expect(
      (
        await repo.list(
          alertQuerySchema.parse({ deviceId, acknowledged: "true" }),
        )
      ).total,
    ).toBe(1);
    expect(
      (
        await repo.list(
          alertQuerySchema.parse({ deviceId, acknowledged: "false" }),
        )
      ).total,
    ).toBe(0);
    expect(await repo.find(randomUUID())).toBeNull();
    expect(await repo.acknowledge(randomUUID())).toBeNull();
  });
});
