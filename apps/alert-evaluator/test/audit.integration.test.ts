import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { asc, eq, like } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createDatabase,
  devices,
  groups,
  commands,
  fleetOperations,
  fleetOperationTargets,
  operationAuditStates,
  auditLogs,
  alerts,
  alertEvaluationStates,
  commandExecutionEvents,
} from "@drone-fleet/database";
import { createOperationAuditRepository } from "../src/operation-audit.js";
import { createAlertRepository } from "../src/repository.js";
import { loadAlertPolicy } from "../src/config.js";
import { createCommandAcknowledgementRepository } from "../../telemetry-ingestor/src/acknowledgement.js";
const enabled = process.env.DATABASE_INTEGRATION === "true";
const database = enabled ? createDatabase() : undefined;
function configured() {
  if (!database) throw Error("database required");
  return database;
}
const deviceId = `audit-state-${randomUUID()}`,
  groupId = randomUUID();
let commandId: string, operationId: string;
const base = Date.parse("2026-10-19T00:00:00Z"),
  at = (ms: number) => new Date(base + ms);
const commandIds: string[] = [],
  operationIds: string[] = [];
async function commandEvents() {
  return configured()
    .db.select()
    .from(auditLogs)
    .where(eq(auditLogs.commandId, commandId))
    .orderBy(asc(auditLogs.occurredAt), asc(auditLogs.eventId));
}
async function failAudit(run: () => Promise<void>) {
  const { client } = configured();
  await client.unsafe(
    "CREATE FUNCTION issue144_system_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test audit unavailable'; END $$",
  );
  await client.unsafe(
    "CREATE TRIGGER issue144_system_fail BEFORE INSERT ON audit_logs FOR EACH ROW WHEN (NEW.actor_kind='system') EXECUTE FUNCTION issue144_system_fail()",
  );
  try {
    await run();
  } finally {
    await client.unsafe("DROP TRIGGER issue144_system_fail ON audit_logs");
    await client.unsafe("DROP FUNCTION issue144_system_fail()");
  }
}
describe.skipIf(!enabled)("system audit with PostgreSQL", () => {
  beforeAll(async () => {
    await migrate(configured().db, {
      migrationsFolder: fileURLToPath(
        new URL("../../../packages/database/drizzle", import.meta.url),
      ),
    });
    await configured()
      .db.insert(devices)
      .values({
        deviceId,
        connectionStatus: "OFFLINE",
        connectionChangedAt: at(0),
      });
    await configured().db.insert(groups).values({ groupId, name: "監査隊" });
  });
  beforeEach(async () => {
    const { db } = configured();
    commandId = randomUUID();
    operationId = randomUUID();
    commandIds.push(commandId);
    operationIds.push(operationId);
    await db.insert(commands).values({
      commandId,
      deviceId,
      type: "RETURN_HOME",
      createdAt: at(0),
      expiresAt: at(30000),
    });
    await db.insert(fleetOperations).values({
      operationId,
      groupId,
      groupName: "監査隊",
      groupRevision: 1,
      type: "RETURN_HOME",
      idempotencyScope: "audit",
      idempotencyKey: operationId,
      targetCount: 1,
      createdAt: at(0),
      expiresAt: at(30000),
      resultDeadline: at(120000),
    });
    await db
      .insert(fleetOperationTargets)
      .values({ operationId, deviceId, commandId });
  });
  afterAll(async () => {
    const { db, client } = configured();
    await db.delete(alerts).where(eq(alerts.deviceId, deviceId));
    await db
      .delete(alertEvaluationStates)
      .where(like(alertEvaluationStates.targetKey, `device:${deviceId}%`));
    for (const id of operationIds) {
      await db
        .delete(fleetOperationTargets)
        .where(eq(fleetOperationTargets.operationId, id));
      await db
        .delete(fleetOperations)
        .where(eq(fleetOperations.operationId, id));
    }
    for (const id of commandIds) {
      await db
        .delete(alertEvaluationStates)
        .where(eq(alertEvaluationStates.targetKey, `command:${id}`));
      await db
        .delete(commandExecutionEvents)
        .where(eq(commandExecutionEvents.commandId, id));
      await db.delete(commands).where(eq(commands.commandId, id));
    }
    await db.delete(groups).where(eq(groups.groupId, groupId));
    await db.delete(devices).where(eq(devices.deviceId, deviceId));
    await client.end();
  });
  it("audits receipt/result/conflict once and correlates operation/group/command", async () => {
    const repo = createCommandAcknowledgementRepository(configured().db);
    const ack = {
      schemaVersion: 2 as const,
      commandId,
      deviceId,
      status: "ACKNOWLEDGED" as const,
      timestamp: at(1000).toISOString(),
    };
    await Promise.all([
      repo.acknowledge(ack, at(1000)),
      repo.acknowledge(ack, at(1000)),
    ]);
    const result = {
      schemaVersion: 3 as const,
      commandId,
      deviceId,
      status: "SUCCEEDED" as const,
      startedAt: at(1000).toISOString(),
      timestamp: at(11000).toISOString(),
    };
    await repo.acknowledge(result, at(11000));
    await repo.acknowledge(result, at(12000));
    const conflict = { ...result, status: "FAILED" as const };
    await repo.acknowledge(conflict, at(13000));
    await repo.acknowledge(conflict, at(14000));
    const events = await commandEvents();
    expect(events.map((e) => e.action).sort()).toEqual([
      "command.acknowledged",
      "command.conflict",
      "command.execution_changed",
    ]);
    expect(
      events.every(
        (e) =>
          e.operationId === operationId &&
          e.groupId === groupId &&
          e.actorKind === "system" &&
          e.actorId === "telemetry-ingestor",
      ),
    ).toBe(true);
    expect(events.find((e) => e.action === "command.conflict")?.result).toBe(
      "REJECTED",
    );
  });
  it("rolls back receipt/execution event with failed audit and retries safely", async () => {
    const { db } = configured();
    const repo = createCommandAcknowledgementRepository(db);
    const message = {
      schemaVersion: 3 as const,
      commandId,
      deviceId,
      status: "RUNNING" as const,
      startedAt: at(1000).toISOString(),
      timestamp: at(1000).toISOString(),
    };
    await failAudit(async () => {
      await expect(repo.acknowledge(message, at(1000))).rejects.toThrow();
      expect(
        await db
          .select()
          .from(commandExecutionEvents)
          .where(eq(commandExecutionEvents.commandId, commandId)),
      ).toHaveLength(0);
      expect(
        (
          await db
            .select()
            .from(commands)
            .where(eq(commands.commandId, commandId))
        )[0]?.executionStatus,
      ).toBe("NOT_REPORTED");
    });
    expect(await repo.acknowledge(message, at(1000))).toBe("updated");
    expect(await commandEvents()).toHaveLength(1);
  });
  it("records expiry without treating it as successful execution", async () => {
    const message = {
      schemaVersion: 2 as const,
      commandId,
      deviceId,
      status: "REJECTED_EXPIRED" as const,
      timestamp: at(30000).toISOString(),
    };
    const repo = createCommandAcknowledgementRepository(configured().db);
    await repo.acknowledge(message, at(30000));
    await repo.acknowledge(message, at(31000));
    expect(await commandEvents()).toMatchObject([
      {
        action: "command.expired",
        result: "SUCCEEDED",
        metadata: { afterStatus: "EXPIRED" },
      },
    ]);
  });
  it("audits aggregate transitions once, retains first finish on late success and restart", async () => {
    const { db } = configured();
    const repo = createOperationAuditRepository(db);
    await Promise.all([
      repo.evaluateOperation(operationId, at(0)),
      repo.evaluateOperation(operationId, at(0)),
    ]);
    await repo.evaluateOperation(operationId, at(120000));
    await db
      .update(commands)
      .set({
        executionStatus: "SUCCEEDED",
        executionStartedAt: at(1000),
        executionStartedReceivedAt: at(1000),
        executionResultAt: at(2000),
        executionResultReceivedAt: at(2000),
      })
      .where(eq(commands.commandId, commandId));
    await createOperationAuditRepository(db).evaluateOperation(
      operationId,
      at(130000),
    );
    await repo.evaluateOperation(operationId, at(140000));
    await repo.evaluateOperation(operationId, at(125000));
    const events = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.operationId, operationId))
      .orderBy(asc(auditLogs.occurredAt), asc(auditLogs.eventId));
    expect(events.map((e) => e.metadata.afterStatus)).toEqual([
      "ACCEPTED",
      "FAILED",
      "COMPLETED",
    ]);
    expect(
      (
        await db
          .select()
          .from(operationAuditStates)
          .where(eq(operationAuditStates.operationId, operationId))
      )[0],
    ).toMatchObject({
      status: "COMPLETED",
      firstFinishedAt: at(120000),
      evaluatedAt: at(140000),
    });
  });
  it("rolls back aggregate checkpoint when audit fails", async () => {
    const repo = createOperationAuditRepository(configured().db);
    await failAudit(async () => {
      await expect(
        repo.evaluateOperation(operationId, at(0)),
      ).rejects.toThrow();
      expect(
        await configured()
          .db.select()
          .from(operationAuditStates)
          .where(eq(operationAuditStates.operationId, operationId)),
      ).toHaveLength(0);
    });
    await repo.evaluateOperation(operationId, at(0));
  });
  it("rolls back alert/checkpoint on audit failure, then raises and resolves without duplicate audit", async () => {
    const { db } = configured();
    const repo = createAlertRepository(db, loadAlertPolicy({}));
    await failAudit(async () => {
      await expect(repo.evaluateDevice(deviceId, at(60000))).rejects.toThrow();
      expect(
        await db.select().from(alerts).where(eq(alerts.deviceId, deviceId)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(alertEvaluationStates)
          .where(eq(alertEvaluationStates.targetKey, `device:${deviceId}`)),
      ).toHaveLength(0);
    });
    await repo.evaluateDevice(deviceId, at(60000));
    await repo.evaluateDevice(deviceId, at(60000));
    const [alert] = await db
      .select()
      .from(alerts)
      .where(eq(alerts.deviceId, deviceId));
    expect(alert).toBeDefined();
    expect(
      await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.alertId, alert!.alertId)),
    ).toMatchObject([{ action: "alert.raised" }]);
    await db
      .update(commands)
      .set({ status: "FAILED" })
      .where(eq(commands.commandId, commandId));
    await repo.evaluateCommand(commandId, at(1000));
    await db
      .update(commands)
      .set({
        executionStatus: "SUCCEEDED",
        executionStartedAt: at(1000),
        executionStartedReceivedAt: at(1000),
        executionResultAt: at(2000),
        executionResultReceivedAt: at(2000),
      })
      .where(eq(commands.commandId, commandId));
    await repo.evaluateCommand(commandId, at(2000));
    await repo.evaluateCommand(commandId, at(3000));
    expect((await commandEvents()).map((e) => e.action)).toEqual([
      "alert.raised",
      "alert.resolved",
    ]);
  });
});
