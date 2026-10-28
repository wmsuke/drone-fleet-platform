import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { Database } from "./connection.js";
import { auditLogs, fleetOperationTargets, fleetOperations } from "./schema.js";
import { eq } from "drizzle-orm";

export type AuditAction =
  | "deployment.accepted"
  | "deployment.replayed"
  | "release.registered"
  | "group.created"
  | "group.updated"
  | "group.deleted"
  | "membership.added"
  | "membership.removed"
  | "command.accepted"
  | "operation.accepted"
  | "operation.replayed"
  | "alert.acknowledged"
  | "command.acknowledged"
  | "command.expired"
  | "command.execution_changed"
  | "command.conflict"
  | "alert.raised"
  | "alert.resolved"
  | "alert.reason_changed"
  | "operation.status_changed";
export interface AuditContext {
  requestId: string;
  rejectionReason?: string;
}
export const auditContext = new AsyncLocalStorage<AuditContext>();
export type AuditWriter = Pick<Database, "insert">;
export interface AuditEvent {
  action: AuditAction;
  targetKind:
    | "group"
    | "device"
    | "command"
    | "operation"
    | "alert"
    | "release"
    | "deployment";
  targetId?: string | null;
  result?: "SUCCEEDED" | "REJECTED" | "FAILED";
  system?: "telemetry-ingestor" | "alert-evaluator" | "operation-evaluator";
  requestId?: string | null;
  groupId?: string | null;
  operationId?: string | null;
  commandId?: string | null;
  alertId?: string | null;
  metadata?: {
    beforeName?: string;
    afterName?: string;
    descriptionChanged?: boolean;
    memberDeviceId?: string;
    commandType?: "REBOOT" | "RETURN_HOME";
    targetCount?: number;
    beforeStatus?: string | null;
    afterStatus?: string;
    beforeReason?: string;
    reason?: string;
    statusCode?: number;
  };
}
const identifiers = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
function auditRow(event: AuditEvent): typeof auditLogs.$inferInsert {
  const metadata = event.metadata ?? {};
  for (const [key, value] of Object.entries(metadata)) {
    if (["beforeName", "afterName"].includes(key)) {
      if (
        typeof value !== "string" ||
        value.length > 100 ||
        value.includes("\0")
      )
        throw new TypeError("invalid audit name");
    } else if (key === "descriptionChanged") {
      if (typeof value !== "boolean")
        throw new TypeError("invalid audit change flag");
    } else if (key === "memberDeviceId") {
      if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value))
        throw new TypeError("invalid audit device ID");
    } else if (
      [
        "commandType",
        "beforeStatus",
        "afterStatus",
        "beforeReason",
        "reason",
      ].includes(key)
    ) {
      if (
        value !== null &&
        (typeof value !== "string" || !identifiers.test(value))
      )
        throw new TypeError("invalid audit code");
    } else if (["targetCount", "statusCode"].includes(key)) {
      if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 0
      )
        throw new TypeError("invalid audit count");
    } else throw new TypeError("unknown audit metadata");
  }
  return {
    eventId: randomUUID(),
    schemaVersion: 1,
    actorKind: event.system ? "system" : "anonymous",
    actorId: event.system ?? null,
    action: event.action,
    targetKind: event.targetKind,
    targetId: event.targetId ?? null,
    result: event.result ?? "SUCCEEDED",
    requestId: event.requestId ?? auditContext.getStore()?.requestId ?? null,
    groupId: event.groupId ?? null,
    operationId: event.operationId ?? null,
    commandId: event.commandId ?? null,
    alertId: event.alertId ?? null,
    metadata,
  };
}
let writeFailures = 0;
export async function appendAudits(writer: AuditWriter, events: AuditEvent[]) {
  if (events.length) {
    const rows = events.map(auditRow);
    try {
      await writer.insert(auditLogs).values(rows);
    } catch (error) {
      writeFailures++;
      try {
        console.error(
          JSON.stringify({
            event: "audit.transaction_write_failed",
            failures: writeFailures,
            actions: [...new Set(events.map((e) => e.action))],
            requestId: auditContext.getStore()?.requestId ?? null,
          }),
        );
      } catch {
        /* 診断出力の失敗で元のDBエラーを置き換えない */
      }
      throw error;
    }
  }
}
export async function appendAudit(writer: AuditWriter, event: AuditEvent) {
  await appendAudits(writer, [event]);
}
export async function commandAuditLinks(
  reader: Pick<Database, "select">,
  commandId: string,
) {
  const [operation] = await reader
    .select({
      operationId: fleetOperations.operationId,
      groupId: fleetOperations.groupId,
    })
    .from(fleetOperationTargets)
    .innerJoin(
      fleetOperations,
      eq(fleetOperations.operationId, fleetOperationTargets.operationId),
    )
    .where(eq(fleetOperationTargets.commandId, commandId));
  return { commandId, ...operation };
}
