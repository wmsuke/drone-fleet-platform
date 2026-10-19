import { and, eq, sql } from "drizzle-orm";
import {
  auditLogs,
  commands,
  alerts,
  type Database,
} from "@drone-fleet/database";
import { deviceIdSchema } from "./schema.js";
import {
  auditItemSchema,
  decodeAuditCursor,
  encodeAuditCursor,
  publicMetadata,
  type AuditItem,
  type AuditQuery,
} from "./audit-schema.js";
export interface AuditQueryRepository {
  list(
    query: AuditQuery,
  ): Promise<{ items: AuditItem[]; limit: number; nextCursor: string | null }>;
  find(id: string): Promise<AuditItem | null>;
}
export function createAuditQueryRepository(db: Database): AuditQueryRepository {
  const read = () =>
    db
      .select({
        row: auditLogs,
        time: sql<string>`to_char(${auditLogs.occurredAt} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        commandDevice: commands.deviceId,
        alertDevice: alerts.deviceId,
      })
      .from(auditLogs)
      .leftJoin(commands, eq(commands.commandId, auditLogs.commandId))
      .leftJoin(alerts, eq(alerts.alertId, auditLogs.alertId));
  type Row = Awaited<ReturnType<typeof read>>[number];
  function project({ row, time, commandDevice, alertDevice }: Row): AuditItem {
    const action = auditItemSchema.shape.action.parse(row.action);
    const metadata = publicMetadata(action, row.result, row.metadata);
    const deviceId = deviceIdSchema.safeParse(
      commandDevice ??
        alertDevice ??
        (row.targetKind === "device" ? row.targetId : metadata.memberDeviceId),
    );
    return auditItemSchema.parse({
      eventId: row.eventId,
      schemaVersion: row.schemaVersion,
      occurredAt: time,
      actorKind: row.actorKind,
      actorId: row.actorId,
      action,
      targetKind: row.targetKind,
      targetId: row.targetId,
      result: row.result,
      requestId: row.requestId,
      groupId: row.groupId,
      operationId: row.operationId,
      commandId: row.commandId,
      alertId: row.alertId,
      deviceId: deviceId.success ? deviceId.data : null,
      metadata,
    });
  }
  return {
    async list(q) {
      const cursor = q.cursor ? decodeAuditCursor(q.cursor) : null;
      if (q.cursor && !cursor) throw new TypeError("invalid audit cursor");
      const where = and(
        q.from
          ? sql`${auditLogs.occurredAt}>=${q.from}::timestamptz`
          : undefined,
        q.to ? sql`${auditLogs.occurredAt}<=${q.to}::timestamptz` : undefined,
        q.actorKind ? eq(auditLogs.actorKind, q.actorKind) : undefined,
        q.actorId ? eq(auditLogs.actorId, q.actorId) : undefined,
        q.action ? eq(auditLogs.action, q.action) : undefined,
        q.targetKind ? eq(auditLogs.targetKind, q.targetKind) : undefined,
        q.targetId ? eq(auditLogs.targetId, q.targetId) : undefined,
        q.result ? eq(auditLogs.result, q.result) : undefined,
        q.requestId ? eq(auditLogs.requestId, q.requestId) : undefined,
        q.groupId ? eq(auditLogs.groupId, q.groupId) : undefined,
        q.operationId ? eq(auditLogs.operationId, q.operationId) : undefined,
        q.commandId ? eq(auditLogs.commandId, q.commandId) : undefined,
        q.alertId ? eq(auditLogs.alertId, q.alertId) : undefined,
        cursor
          ? sql`(${auditLogs.occurredAt},${auditLogs.eventId})<(${cursor.time}::timestamptz,${cursor.id}::uuid)`
          : undefined,
      );
      const rows = await read()
        .where(where)
        .orderBy(
          sql`${auditLogs.occurredAt} DESC NULLS LAST`,
          sql`${auditLogs.eventId} DESC NULLS LAST`,
        )
        .limit(q.limit + 1);
      const page = rows.slice(0, q.limit);
      const last = page.at(-1);
      return {
        items: page.map(project),
        limit: q.limit,
        nextCursor:
          rows.length > q.limit && last
            ? encodeAuditCursor(last.time, last.row.eventId)
            : null,
      };
    },
    async find(id) {
      const [row] = await read().where(eq(auditLogs.eventId, id));
      return row ? project(row) : null;
    },
  };
}
