import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  createDatabase,
  auditLogs,
  commands,
  devices,
  alerts,
} from "@drone-fleet/database";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuditQueryRepository } from "../src/audit-query-repository.js";
import { auditQuerySchema } from "../src/audit-schema.js";
const enabled = process.env.DATABASE_INTEGRATION === "true";
const database = enabled ? createDatabase() : undefined;
function configured() {
  if (!database) throw Error("database required");
  return database;
}
describe.skipIf(!enabled)("audit query PostgreSQL", () => {
  beforeAll(async () => {
    await migrate(configured().db, {
      migrationsFolder: fileURLToPath(
        new URL("../../../packages/database/drizzle", import.meta.url),
      ),
    });
  });
  afterAll(async () => {
    await configured().client.end();
  });
  it("pages equal and sub-millisecond timestamps without gaps or duplicates, even after a newer insert", async () => {
    const { db } = configured();
    const requestId = randomUUID();
    const repo = createAuditQueryRepository(db);
    const ids: string[] = [];
    for (const time of [
      "2026-10-19T00:00:00.123457Z",
      "2026-10-19T00:00:00.123456Z",
      "2026-10-19T00:00:00.123455Z",
    ]) {
      const rows = Array.from({ length: 23 }, () => ({
        eventId: randomUUID(),
        actorKind: "anonymous",
        action: "group.created",
        targetKind: "group",
        result: "SUCCEEDED",
        requestId,
        occurredAt: sql`${time}::timestamptz`,
        metadata: {
          afterName: "公開名",
          authorization: "test-private-value",
          privateDescription: "hidden-value",
        },
      }));
      ids.push(...rows.map((r) => r.eventId));
      await db.insert(auditLogs).values(rows);
    }
    const first = await repo.list(
      auditQuerySchema.parse({ requestId, limit: "10" }),
    );
    expect(first.items[0]?.occurredAt).toBe("2026-10-19T00:00:00.123457Z");
    expect(first.items[0]?.metadata).toEqual({ afterName: "公開名" });
    const newest = randomUUID();
    await db.insert(auditLogs).values({
      eventId: newest,
      actorKind: "anonymous",
      action: "group.created",
      targetKind: "group",
      result: "SUCCEEDED",
      requestId,
      occurredAt: sql`'2026-10-19T00:00:01Z'::timestamptz`,
    });
    const seen = [...first.items];
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await repo.list(
        auditQuerySchema.parse({ requestId, limit: "10", cursor }),
      );
      seen.push(...page.items);
      cursor = page.nextCursor;
      expect(seen.length).toBeLessThan(100);
    }
    expect(seen).toHaveLength(69);
    expect(new Set(seen.map((r) => r.eventId))).toEqual(new Set(ids));
    expect(JSON.stringify(seen)).not.toMatch(/test-private-value|hidden-value/);
    expect(
      (
        await repo.list(
          auditQuerySchema.parse({
            requestId,
            from: "2026-10-19T00:00:00.123456Z",
            to: "2026-10-19T00:00:00.123456Z",
            limit: "100",
          }),
        )
      ).items,
    ).toHaveLength(23);
  });
  it("combines actor/action/target/result/related IDs and projects detail metadata", async () => {
    const { db } = configured();
    const eventId = randomUUID(),
      groupId = randomUUID(),
      operationId = randomUUID(),
      commandId = randomUUID(),
      alertId = randomUUID(),
      requestId = randomUUID();
    await db.insert(auditLogs).values({
      eventId,
      actorKind: "system",
      actorId: "telemetry-ingestor",
      action: "command.conflict",
      targetKind: "command",
      targetId: commandId,
      result: "REJECTED",
      groupId,
      operationId,
      commandId,
      alertId,
      requestId,
      metadata: {
        reason: "RESULT_CONFLICT",
        beforeStatus: "RUNNING",
        afterStatus: "FAILED",
        certificate: "test-private-value",
        afterName: "not-for-this-action",
      },
    });
    const repo = createAuditQueryRepository(db);
    const filters = {
      actorKind: "system",
      actorId: "telemetry-ingestor",
      action: "command.conflict",
      targetKind: "command",
      targetId: commandId,
      result: "REJECTED",
      groupId,
      operationId,
      commandId,
      alertId,
      requestId,
    };
    expect(
      (await repo.list(auditQuerySchema.parse(filters))).items,
    ).toHaveLength(1);
    expect(
      (
        await repo.list(
          auditQuerySchema.parse({ ...filters, result: "FAILED" }),
        )
      ).items,
    ).toEqual([]);
    const detail = await repo.find(eventId);
    expect(detail?.metadata).toEqual({
      reason: "RESULT_CONFLICT",
      beforeStatus: "RUNNING",
      afterStatus: "FAILED",
    });
    expect(detail?.operationId).toBe(operationId);
    expect(await repo.find(randomUUID())).toBeNull();
  });
  it("resolves related devices in the page query for commands, alerts and membership changes", async () => {
    const { db } = configured();
    const deviceId = `audit-query-${randomUUID()}`,
      commandId = randomUUID(),
      alertId = randomUUID(),
      requestId = randomUUID();
    await db.insert(devices).values({ deviceId });
    await db.insert(commands).values({ commandId, deviceId, type: "REBOOT" });
    await db.insert(alerts).values({
      alertId,
      deviceId,
      deduplicationKey: alertId,
      kind: "OFFLINE",
      reason: "OFFLINE",
      occurredAt: new Date(),
      lastObservedAt: new Date(),
      ruleVersion: "test",
      parameters: {},
      evidence: {},
    });
    try {
      await db.insert(auditLogs).values([
        {
          eventId: randomUUID(),
          actorKind: "anonymous",
          action: "command.accepted",
          targetKind: "command",
          targetId: commandId,
          commandId,
          requestId,
          result: "SUCCEEDED",
        },
        {
          eventId: randomUUID(),
          actorKind: "anonymous",
          action: "alert.acknowledged",
          targetKind: "alert",
          targetId: alertId,
          alertId,
          requestId,
          result: "SUCCEEDED",
        },
        {
          eventId: randomUUID(),
          actorKind: "anonymous",
          action: "membership.added",
          targetKind: "group",
          requestId,
          result: "SUCCEEDED",
          metadata: { memberDeviceId: deviceId },
        },
      ]);
      const page = await createAuditQueryRepository(db).list(
        auditQuerySchema.parse({ requestId }),
      );
      expect(page.items).toHaveLength(3);
      expect(page.items.every((r) => r.deviceId === deviceId)).toBe(true);
    } finally {
      await db.delete(alerts).where(eq(alerts.alertId, alertId));
      await db.delete(commands).where(eq(commands.commandId, commandId));
      await db.delete(devices).where(eq(devices.deviceId, deviceId));
    }
  });
});
