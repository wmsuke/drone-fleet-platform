import {
  and,
  asc,
  desc,
  eq,
  gte,
  lte,
  inArray,
  isNull,
  isNotNull,
  sql,
} from "drizzle-orm";
import {
  alerts,
  groups,
  groupMemberships,
  fleetOperations,
  fleetOperationTargets,
  type Database,
} from "@drone-fleet/database";
import { alertSchema, type Alert, type AlertQuery } from "./alert-schema.js";

export interface AlertRepository {
  list(
    query: AlertQuery,
  ): Promise<{ items: Alert[]; total: number; limit: number; offset: number }>;
  find(id: string): Promise<Alert | null>;
  acknowledge(id: string): Promise<Alert | null>;
}
export function createAlertRepository(db: Database): AlertRepository {
  type Reader =
    | Database
    | Parameters<Parameters<Database["transaction"]>[0]>[0];
  const enrich = async (
    reader: Reader,
    rows: (typeof alerts.$inferSelect)[],
  ): Promise<Alert[]> => {
    if (!rows.length) return [];
    const commandIds = rows.flatMap((row) =>
      row.commandId ? [row.commandId] : [],
    );
    const deviceIds = rows
      .filter((row) => row.commandId === null)
      .map((row) => row.deviceId);
    const operations = commandIds.length
      ? await reader
          .select({
            commandId: fleetOperationTargets.commandId,
            operationId: fleetOperations.operationId,
            groupId: fleetOperations.groupId,
            name: fleetOperations.groupName,
          })
          .from(fleetOperationTargets)
          .innerJoin(
            fleetOperations,
            eq(fleetOperationTargets.operationId, fleetOperations.operationId),
          )
          .where(inArray(fleetOperationTargets.commandId, commandIds))
      : [];
    const memberships = deviceIds.length
      ? await reader
          .select({
            deviceId: groupMemberships.deviceId,
            groupId: groups.groupId,
            name: groups.name,
          })
          .from(groupMemberships)
          .innerJoin(groups, eq(groups.groupId, groupMemberships.groupId))
          .where(
            and(
              inArray(groupMemberships.deviceId, deviceIds),
              isNull(groups.deletedAt),
            ),
          )
          .orderBy(asc(groups.groupId))
      : [];
    return rows.map((row) => {
      const relations = operations.filter((o) => o.commandId === row.commandId);
      const relatedGroups =
        row.commandId !== null
          ? relations.map(({ groupId, name }) => ({ groupId, name }))
          : memberships
              .filter((m) => m.deviceId === row.deviceId)
              .map(({ groupId, name }) => ({ groupId, name }));
      return alertSchema.parse({
        ...row,
        occurredAt: row.occurredAt.toISOString(),
        lastObservedAt: row.lastObservedAt.toISOString(),
        resolvedAt: row.resolvedAt?.toISOString() ?? null,
        acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
        relatedGroups,
        operationId: relations[0]?.operationId ?? null,
      });
    });
  };
  const find = async (id: string) =>
    (
      await enrich(
        db,
        await db.select().from(alerts).where(eq(alerts.alertId, id)),
      )
    )[0] ?? null;
  return {
    find,
    async list(q) {
      const where = and(
        q.status ? eq(alerts.status, q.status) : undefined,
        q.kind ? eq(alerts.kind, q.kind) : undefined,
        q.severity ? eq(alerts.severity, q.severity) : undefined,
        q.deviceId ? eq(alerts.deviceId, q.deviceId) : undefined,
        q.acknowledged
          ? q.acknowledged === "true"
            ? isNotNull(alerts.acknowledgedAt)
            : isNull(alerts.acknowledgedAt)
          : undefined,
        q.from ? gte(alerts.occurredAt, new Date(q.from)) : undefined,
        q.to ? lte(alerts.occurredAt, new Date(q.to)) : undefined,
        q.groupId
          ? sql`(( ${alerts.commandId} is null and exists (select 1 from ${groupMemberships} m join ${groups} g on g.group_id=m.group_id where m.device_id=${alerts.deviceId} and m.group_id=${q.groupId} and g.deleted_at is null)) or exists (select 1 from ${fleetOperationTargets} t join ${fleetOperations} o on o.operation_id=t.operation_id where t.command_id=${alerts.commandId} and o.group_id=${q.groupId}))`
          : undefined,
        q.operationId
          ? sql`exists (select 1 from ${fleetOperationTargets} t where t.command_id=${alerts.commandId} and t.operation_id=${q.operationId})`
          : undefined,
      );
      const result = await db.transaction(
        async (tx) => {
          const [count] = await tx
            .select({ total: sql<number>`count(*)::int` })
            .from(alerts)
            .where(where);
          const rows = await tx
            .select()
            .from(alerts)
            .where(where)
            .orderBy(desc(alerts.occurredAt), desc(alerts.alertId))
            .limit(q.limit)
            .offset(q.offset);
          return { items: await enrich(tx, rows), total: count?.total ?? 0 };
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
      return {
        items: result.items,
        total: result.total,
        limit: q.limit,
        offset: q.offset,
      };
    },
    async acknowledge(id) {
      await db
        .update(alerts)
        .set({
          acknowledgedAt: sql`clock_timestamp()`,
          acknowledgedActorKind: "anonymous",
          acknowledgedActorId: null,
        })
        .where(and(eq(alerts.alertId, id), isNull(alerts.acknowledgedAt)));
      return find(id);
    },
  };
}
