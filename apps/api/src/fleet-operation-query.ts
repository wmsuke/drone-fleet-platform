import { sql, type SQL } from "drizzle-orm";
import { operationAggregation, type Database } from "@drone-fleet/database";
import {
  operationListResponseSchema,
  operationDetailResponseSchema,
  type OperationListQuery,
  type OperationTargetQuery,
} from "./fleet-operation-schema.js";

// 一つのstatementでcommand/outbox、集計、絞り込み件数、pageを読む。
// 更新transactionの途中や、pageをまたぐ評価時刻のずれを同一応答へ混ぜない。
const aggregation = operationAggregation;
// PostgreSQLのJSON timestamp表現を既存APIと同じUTC ISO 8601へ揃える。
function dates(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => [
      key,
      v !== null && (key.endsWith("At") || key === "resultDeadline")
        ? new Date(v as string).toISOString()
        : v,
    ]),
  );
}
export function createFleetOperationQueries(db: Database, clock: () => Date) {
  return {
    async list(query: OperationListQuery) {
      const now = clock();
      const predicates: SQL[] = [sql`true`];
      if (query.groupId)
        predicates.push(sql`o.group_id = ${query.groupId}::uuid`);
      if (query.type) predicates.push(sql`o.type = ${query.type}`);
      if (query.from)
        predicates.push(sql`o.created_at >= ${query.from}::timestamptz`);
      if (query.to)
        predicates.push(sql`o.created_at <= ${query.to}::timestamptz`);
      const [row] = await db.execute<{
        items: Record<string, unknown>[];
        total: number;
      }>(sql`
        ${aggregation(sql.join(predicates, sql` AND `), now)}, filtered AS (
          SELECT * FROM summaries WHERE ${query.status ? sql`status = ${query.status}` : sql`true`}
        ), page AS (
          SELECT * FROM filtered ORDER BY "createdAt" DESC, "operationId" DESC
          LIMIT ${query.limit} OFFSET ${query.offset}
        )
        SELECT coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY p."createdAt" DESC, p."operationId" DESC) FROM page p), '[]'::jsonb) AS items,
          (SELECT count(*)::integer FROM filtered) AS total`);
      if (!row) throw new Error("operation query returned no row");
      return operationListResponseSchema.parse({
        ...row,
        items: row.items.map(dates),
        limit: query.limit,
        offset: query.offset,
        evaluatedAt: now.toISOString(),
      });
    },
    async find(operationId: string, query: OperationTargetQuery) {
      const now = clock();
      const [row] = await db.execute<{
        summary: Record<string, unknown>;
        items: Record<string, unknown>[];
        total: number;
      }>(operationDetailStatement(operationId, query, now));
      if (!row) return null;
      return operationDetailResponseSchema.parse({
        ...dates(row.summary),
        evaluatedAt: now.toISOString(),
        targets: {
          items: row.items.map(dates),
          total: row.total,
          limit: query.limit,
          offset: query.offset,
        },
      });
    },
  };
}

// 負荷検証でも本番GETと同じstatementをEXPLAINする。
export function operationDetailStatement(
  operationId: string,
  query: OperationTargetQuery,
  now: Date,
) {
  const predicates: SQL[] = [sql`true`];
  if (query.status) predicates.push(sql`t.status = ${query.status}`);
  if (query.deviceId) predicates.push(sql`t."deviceId" = ${query.deviceId}`);
  return sql`${aggregation(sql`o.operation_id = ${operationId}::uuid`, now)}, filtered AS (
    SELECT * FROM targets t WHERE ${sql.join(predicates, sql` AND `)}
  ), page AS (
    SELECT * FROM filtered ORDER BY "deviceId" COLLATE "C" ASC LIMIT ${query.limit} OFFSET ${query.offset}
  )
  SELECT to_jsonb(s) AS summary,
    coalesce((SELECT jsonb_agg(to_jsonb(p) - 'operation_id' ORDER BY p."deviceId" COLLATE "C" ASC) FROM page p), '[]'::jsonb) AS items,
    (SELECT count(*)::integer FROM filtered) AS total
  FROM summaries s`;
}
