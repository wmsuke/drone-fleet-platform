import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabase,
  auditLogs,
  alerts,
  devices,
  groups,
  groupMemberships,
  commands,
  commandOutbox,
  fleetOperations,
  fleetOperationTargets,
  appendAudit,
} from "@drone-fleet/database";
import { buildApi } from "../src/app.js";
import { createDeviceRepository } from "../src/repository.js";
import { createCommandRepository } from "../src/command-repository.js";
import { createCommandService } from "../src/command-service.js";
import { createGroupRepository } from "../src/group-repository.js";
import { createFleetOperationRepository } from "../src/fleet-operation-repository.js";
import { createAlertRepository } from "../src/alert-repository.js";
const enabled = process.env.DATABASE_INTEGRATION === "true";
const database = enabled ? createDatabase() : undefined;
function configured() {
  if (!database) throw Error("database required");
  return database;
}
const deviceId = `audit-${randomUUID()}`;
const groupIds: string[] = [];
const commandIds: string[] = [];
const operationIds: string[] = [];
const alertIds: string[] = [];
function app() {
  const { db } = configured();
  return buildApi(
    createDeviceRepository(db),
    createCommandService(createCommandRepository(db)),
    {
      auditDatabase: db,
      groupRepository: createGroupRepository(db),
      fleetOperationRepository: createFleetOperationRepository(db),
      alertRepository: createAlertRepository(db),
    },
  );
}
async function forRequest(id: string) {
  return configured()
    .db.select()
    .from(auditLogs)
    .where(eq(auditLogs.requestId, id));
}
async function failing(action: string, run: () => Promise<void>) {
  const { client } = configured();
  await client.unsafe(
    `CREATE FUNCTION issue144_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test audit unavailable'; END $$`,
  );
  await client.unsafe(
    `CREATE TRIGGER issue144_fail_audit BEFORE INSERT ON audit_logs FOR EACH ROW WHEN (NEW.action='${action}' AND NEW.result='SUCCEEDED') EXECUTE FUNCTION issue144_fail_audit()`,
  );
  try {
    await run();
  } finally {
    await client.unsafe("DROP TRIGGER issue144_fail_audit ON audit_logs");
    await client.unsafe("DROP FUNCTION issue144_fail_audit()");
  }
}
describe.skipIf(!enabled)("audit log transactions with PostgreSQL", () => {
  it("keeps concurrent HTTP request correlation separate", async () => {
    const api = app();
    try {
      const results = await Promise.all(
        ["同時A", "同時B"].map((name) =>
          api.inject({ method: "POST", url: "/groups", payload: { name } }),
        ),
      );
      const requestIds = results.map((r) => String(r.headers["x-request-id"]));
      expect(new Set(requestIds).size).toBe(2);
      for (const [i, r] of results.entries()) {
        expect(r.statusCode).toBe(201);
        const groupId = r.json().groupId as string;
        groupIds.push(groupId);
        expect(await forRequest(requestIds[i]!)).toMatchObject([
          { groupId, metadata: { afterName: i === 0 ? "同時A" : "同時B" } },
        ]);
      }
    } finally {
      await api.close();
    }
  });
  it("limits a non-owner runtime role to INSERT/SELECT and prevents disabling the audit trigger", async () => {
    const { client } = configured();
    await client.unsafe("CREATE ROLE issue144_runtime NOLOGIN");
    try {
      await client.unsafe("GRANT USAGE ON SCHEMA public TO issue144_runtime");
      await client.unsafe(
        "GRANT INSERT, SELECT ON audit_logs TO issue144_runtime",
      );
      await client.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE issue144_runtime");
        await tx.unsafe(
          "INSERT INTO audit_logs(event_id,actor_kind,action,target_kind,result) VALUES(gen_random_uuid(),'anonymous','group.created','group','SUCCEEDED')",
        );
        expect(
          await tx.unsafe("SELECT event_id FROM audit_logs LIMIT 1"),
        ).toHaveLength(1);
      });
      for (const statement of [
        "ALTER TABLE audit_logs DISABLE TRIGGER USER",
        "UPDATE audit_logs SET result='FAILED'",
        "DELETE FROM audit_logs",
        "TRUNCATE audit_logs",
      ])
        await expect(
          client.begin(async (tx) => {
            await tx.unsafe("SET LOCAL ROLE issue144_runtime");
            await tx.unsafe(statement);
          }),
        ).rejects.toThrow();
    } finally {
      await client.unsafe("REVOKE ALL ON audit_logs FROM issue144_runtime");
      await client.unsafe(
        "REVOKE USAGE ON SCHEMA public FROM issue144_runtime",
      );
      await client.unsafe("DROP ROLE issue144_runtime");
    }
  });
  beforeAll(async () => {
    await migrate(configured().db, {
      migrationsFolder: fileURLToPath(
        new URL("../../../packages/database/drizzle", import.meta.url),
      ),
    });
    await configured().db.insert(devices).values({ deviceId });
  });
  afterAll(async () => {
    const { db, client } = configured();
    for (const id of alertIds)
      await db.delete(alerts).where(eq(alerts.alertId, id));
    for (const id of operationIds) {
      await db
        .delete(fleetOperationTargets)
        .where(eq(fleetOperationTargets.operationId, id));
      await db
        .delete(fleetOperations)
        .where(eq(fleetOperations.operationId, id));
    }
    for (const id of commandIds) {
      await db.delete(commandOutbox).where(eq(commandOutbox.commandId, id));
      await db.delete(commands).where(eq(commands.commandId, id));
    }
    for (const id of groupIds) {
      await db.delete(groupMemberships).where(eq(groupMemberships.groupId, id));
      await db.delete(groups).where(eq(groups.groupId, id));
    }
    await db.delete(devices).where(eq(devices.deviceId, deviceId));
    await client.end();
  });
  it("records group/member changes with server request IDs, anonymous actor and bounded metadata", async () => {
    const api = app();
    try {
      const response = await api.inject({
        method: "POST",
        url: "/groups",
        headers: {
          "x-request-id": "untrusted",
          authorization: "Bearer audit-test-secret",
          "x-actor-id": "administrator",
        },
        payload: { name: "訓練隊", description: "not-for-audit" },
      });
      expect(response.statusCode).toBe(201);
      const groupId = response.json().groupId as string;
      groupIds.push(groupId);
      const rows = await forRequest(String(response.headers["x-request-id"]));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorKind: "anonymous",
        actorId: null,
        action: "group.created",
        result: "SUCCEEDED",
        groupId,
        targetId: groupId,
        metadata: { afterName: "訓練隊" },
      });
      expect(JSON.stringify(rows)).not.toMatch(
        /untrusted|audit-test-secret|administrator|not-for-audit/,
      );
      for (const [method, url, payload, action] of [
        [
          "PATCH",
          `/groups/${groupId}`,
          { name: "変更隊", description: "changed-private" },
          "group.updated",
        ],
        [
          "POST",
          `/groups/${groupId}/devices`,
          { deviceId },
          "membership.added",
        ],
        [
          "DELETE",
          `/groups/${groupId}/devices/${deviceId}`,
          undefined,
          "membership.removed",
        ],
        ["DELETE", `/groups/${groupId}`, undefined, "group.deleted"],
      ] as const) {
        const r = await api.inject({ method, url, payload });
        expect(r.statusCode).toBeLessThan(300);
        expect(
          await forRequest(String(r.headers["x-request-id"])),
        ).toMatchObject([{ action, result: "SUCCEEDED" }]);
        const changes = await forRequest(String(r.headers["x-request-id"]));
        expect(JSON.stringify(changes)).not.toContain("changed-private");
        if (action === "group.updated")
          expect(changes[0]?.metadata.descriptionChanged).toBe(true);
      }
    } finally {
      await api.close();
    }
  });
  it("links fleet/individual command acceptance, replays and rejections without duplicate acceptance", async () => {
    const api = app();
    const { db } = configured();
    try {
      const group = await createGroupRepository(db).create({
        name: "command隊",
      });
      groupIds.push(group.groupId);
      await createGroupRepository(db).addMember(group.groupId, deviceId);
      const key = randomUUID();
      const input = {
        method: "POST" as const,
        url: "/fleet-operations",
        headers: { "idempotency-key": key },
        payload: { groupId: group.groupId, type: "REBOOT" },
      };
      const accepted = await api.inject(input);
      expect(accepted.statusCode).toBe(202);
      const operationId = accepted.json().operationId as string;
      operationIds.push(operationId);
      const targets = await db
        .select()
        .from(fleetOperationTargets)
        .where(eq(fleetOperationTargets.operationId, operationId));
      commandIds.push(...targets.map((t) => t.commandId));
      const events = await forRequest(String(accepted.headers["x-request-id"]));
      expect(events).toHaveLength(2);
      expect(events.map((e) => e.action).sort()).toEqual([
        "command.accepted",
        "operation.accepted",
      ]);
      expect(events.every((e) => e.operationId === operationId)).toBe(true);
      expect(
        events.find((e) => e.action === "command.accepted")?.commandId,
      ).toBe(targets[0]?.commandId);
      const replay = await api.inject(input);
      expect(replay.json().operationId).toBe(operationId);
      expect(
        await forRequest(String(replay.headers["x-request-id"])),
      ).toMatchObject([{ action: "operation.replayed", operationId }]);
      const conflict = await api.inject({
        ...input,
        payload: { ...input.payload, type: "RETURN_HOME" },
      });
      expect(conflict.statusCode).toBe(409);
      expect(
        await forRequest(String(conflict.headers["x-request-id"])),
      ).toMatchObject([
        { result: "REJECTED", metadata: { reason: "IDEMPOTENCY_CONFLICT" } },
      ]);
      const single = await api.inject({
        method: "POST",
        url: `/devices/${deviceId}/commands`,
        payload: { type: "RETURN_HOME" },
      });
      expect(single.statusCode).toBe(202);
      commandIds.push(single.json().commandId as string);
      expect(
        await forRequest(String(single.headers["x-request-id"])),
      ).toMatchObject([
        {
          action: "command.accepted",
          operationId: null,
          commandId: single.json().commandId,
        },
      ]);
    } finally {
      await api.close();
    }
  });
  it("records invalid and missing targets, never raw input, and does not expose audit mutation APIs", async () => {
    const api = app();
    try {
      for (const input of [
        {
          method: "POST" as const,
          url: "/groups",
          payload: { name: "", secret: "audit-test-secret" },
        },
        {
          method: "PATCH" as const,
          url: `/groups/${randomUUID()}`,
          payload: { name: "不存在" },
        },
        { method: "POST" as const, url: `/alerts/${randomUUID()}/acknowledge` },
      ]) {
        const r = await api.inject(input);
        expect(r.statusCode).toBeGreaterThanOrEqual(400);
        const rows = await forRequest(String(r.headers["x-request-id"]));
        expect(rows).toHaveLength(1);
        expect(rows[0]?.result).toBe("REJECTED");
        expect(JSON.stringify(rows)).not.toContain("audit-test-secret");
      }
      for (const method of ["PATCH", "DELETE"] as const)
        expect(
          (await api.inject({ method, url: `/audit-logs/${randomUUID()}` }))
            .statusCode,
        ).toBe(404);
    } finally {
      await api.close();
    }
  });
  it("rolls back group/member/command/fleet/alert writes when success audit fails", async () => {
    const api = app();
    const { db } = configured();
    try {
      await failing("group.created", async () => {
        const count = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(groups);
        const r = await api.inject({
          method: "POST",
          url: "/groups",
          payload: { name: "rollback隊" },
        });
        expect(r.statusCode).toBe(500);
        expect(
          await db.select({ n: sql<number>`count(*)::int` }).from(groups),
        ).toEqual(count);
        expect(
          await forRequest(String(r.headers["x-request-id"])),
        ).toMatchObject([{ result: "FAILED" }]);
      });
      const group = await createGroupRepository(db).create({
        name: "rollback隊",
      });
      groupIds.push(group.groupId);
      await failing("membership.added", async () => {
        const r = await api.inject({
          method: "POST",
          url: `/groups/${group.groupId}/devices`,
          payload: { deviceId },
        });
        expect(r.statusCode).toBe(500);
        expect(
          (await createGroupRepository(db).find(group.groupId)).revision,
        ).toBe(1);
        expect(
          (await createGroupRepository(db).find(group.groupId)).deviceCount,
        ).toBe(0);
      });
      await createGroupRepository(db).addMember(group.groupId, deviceId);
      await failing("command.accepted", async () => {
        const before = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(commands);
        expect(
          (
            await api.inject({
              method: "POST",
              url: `/devices/${deviceId}/commands`,
              payload: { type: "REBOOT" },
            })
          ).statusCode,
        ).toBe(500);
        const fleet = await api.inject({
          method: "POST",
          url: "/fleet-operations",
          headers: { "idempotency-key": randomUUID() },
          payload: { groupId: group.groupId, type: "REBOOT" },
        });
        expect(fleet.statusCode).toBe(500);
        expect(
          await db.select({ n: sql<number>`count(*)::int` }).from(commands),
        ).toEqual(before);
        expect(
          await db
            .select()
            .from(fleetOperations)
            .where(eq(fleetOperations.groupId, group.groupId)),
        ).toHaveLength(0);
      });
      const alertId = randomUUID();
      alertIds.push(alertId);
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
      await failing("alert.acknowledged", async () => {
        expect(
          (
            await api.inject({
              method: "POST",
              url: `/alerts/${alertId}/acknowledge`,
            })
          ).statusCode,
        ).toBe(500);
        expect(
          (await createAlertRepository(db).find(alertId))?.acknowledgedAt,
        ).toBeNull();
      });
      await Promise.all(
        Array.from({ length: 6 }, () =>
          api.inject({ method: "POST", url: `/alerts/${alertId}/acknowledge` }),
        ),
      );
      expect(
        await db
          .select()
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.alertId, alertId),
              eq(auditLogs.result, "SUCCEEDED"),
            ),
          ),
      ).toHaveLength(1);
    } finally {
      await api.close();
    }
  });
  it("rejects UPDATE DELETE and TRUNCATE, validates metadata and preserves records without foreign keys", async () => {
    const { db } = configured();
    for (const statement of [
      sql`UPDATE audit_logs SET result='FAILED'`,
      sql`DELETE FROM audit_logs`,
      sql`TRUNCATE audit_logs`,
    ])
      await expect(db.execute(statement)).rejects.toThrow();
    await expect(
      appendAudit(db, {
        action: "group.created",
        targetKind: "group",
        metadata: JSON.parse('{"authorization":"audit-test-secret"}') as never,
      }),
    ).rejects.toThrow("unknown audit metadata");
    for (const [actorKind, actorId] of [
      ["anonymous", "spoofed"],
      ["system", null],
    ] as const)
      await expect(
        db.insert(auditLogs).values({
          eventId: randomUUID(),
          actorKind,
          actorId,
          action: "group.created",
          targetKind: "group",
          result: "SUCCEEDED",
        }),
      ).rejects.toThrow();
  });
});
