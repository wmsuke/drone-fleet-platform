import { sql, type SQL } from "drizzle-orm";
export function operationAggregation(where: SQL, now: Date) {
  const time = now.toISOString();
  const counts = [
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
  ].map(
    (status) =>
      sql`count(*) FILTER (WHERE t.status = ${status})::integer AS ${sql.identifier(status)}`,
  );
  return sql`WITH targets AS (
    SELECT t.operation_id, t.device_id AS "deviceId", t.command_id AS "commandId",
      c.status AS "commandStatus", c.execution_status AS "executionStatus",
      b.state AS "outboxState", coalesce(b.attempts, 0) AS attempts,
      coalesce(b.failures, 0) AS failures,
      c.sent_at AS "sentAt", c.acknowledgement_received_at AS "acknowledgementReceivedAt",
      c.execution_started_at AS "executionStartedAt",
      c.execution_started_received_at AS "executionStartedReceivedAt",
      c.execution_result_at AS "executionResultAt",
      c.execution_result_received_at AS "executionResultReceivedAt",
      CASE
        WHEN c.execution_status = 'SUCCEEDED' THEN 'SUCCEEDED'
        WHEN c.execution_status = 'FAILED' THEN 'EXECUTION_FAILED'
        WHEN c.execution_status = 'UNCERTAIN' THEN 'UNCERTAIN'
        WHEN c.status = 'EXPIRED' THEN 'EXPIRED'
        WHEN ${time}::timestamptz >= o.result_deadline THEN 'UNRESPONSIVE'
        WHEN c.execution_status = 'RUNNING' THEN 'RUNNING'
        WHEN c.acknowledgement_received_at IS NOT NULL THEN 'ACKNOWLEDGED'
        WHEN c.status = 'FAILED' THEN 'DELIVERY_FAILED'
        WHEN c.status = 'TIMED_OUT' THEN 'UNRESPONSIVE'
        WHEN c.status = 'SENT' THEN 'SENT'
        ELSE 'PENDING'
      END AS status,
      greatest(c.created_at, c.sent_at, c.acknowledgement_received_at,
        c.expired_at, c.timed_out_at, c.execution_started_received_at,
        c.execution_result_received_at, b.published_at, b.updated_at,
        CASE WHEN ${time}::timestamptz >= o.result_deadline AND c.status <> 'EXPIRED'
          AND c.execution_status IN ('NOT_REPORTED', 'RUNNING') THEN o.result_deadline END
      ) AS "updatedAt"
    FROM fleet_operation_targets t
    JOIN fleet_operations o ON o.operation_id = t.operation_id
    JOIN commands c ON c.command_id = t.command_id
    LEFT JOIN command_outbox b ON b.command_id = c.command_id
    WHERE ${where}
  ), counts AS (
    SELECT t.operation_id, ${sql.join(counts, sql`, `)},
      count(*) FILTER (WHERE t."acknowledgementReceivedAt" IS NOT NULL)::integer AS "acknowledgedCount",
      max(t."updatedAt") AS "updatedAt"
    FROM targets t GROUP BY t.operation_id
  ), summaries AS (
    SELECT o.operation_id AS "operationId", o.group_id AS "groupId",
      o.group_name AS "groupName", o.group_revision AS "groupRevision", o.type,
      o.target_count AS "targetCount", o.created_at AS "createdAt",
      o.expires_at AS "expiresAt", o.result_deadline AS "resultDeadline",
      CASE WHEN n."PENDING" = o.target_count THEN 'ACCEPTED'
        WHEN n."PENDING" + n."SENT" + n."ACKNOWLEDGED" + n."RUNNING" > 0 THEN 'IN_PROGRESS'
        WHEN n."SUCCEEDED" = o.target_count THEN 'COMPLETED'
        WHEN n."SUCCEEDED" > 0 THEN 'PARTIALLY_FAILED' ELSE 'FAILED' END AS status,
      to_jsonb(n) - 'operation_id' - 'acknowledgedCount' - 'updatedAt' AS counts,
      n."SUCCEEDED" AS "succeededCount",
      (n."EXECUTION_FAILED" + n."DELIVERY_FAILED" + n."EXPIRED" + n."UNRESPONSIVE" + n."UNCERTAIN") AS "unsuccessfulCount",
      (n."PENDING" + n."SENT" + n."ACKNOWLEDGED" + n."RUNNING") AS "inProgressCount",
      n."acknowledgedCount", n."updatedAt"
    FROM fleet_operations o JOIN counts n ON n.operation_id = o.operation_id
  )`;
}
