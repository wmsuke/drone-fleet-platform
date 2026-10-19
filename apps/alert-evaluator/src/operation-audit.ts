import { asc, eq, sql } from "drizzle-orm";
import {
  appendAudit,
  fleetOperations,
  operationAuditStates,
  operationAggregation,
  type Database,
} from "@drone-fleet/database";
export function createOperationAuditRepository(db: Database) {
  return {
    async operationIds() {
      return (
        await db
          .select({ id: fleetOperations.operationId })
          .from(fleetOperations)
          .orderBy(asc(fleetOperations.operationId))
      ).map((r) => r.id);
    },
    async evaluateOperation(id: string, now: Date) {
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${"operation-audit:" + id},0))`,
        );
        const [previous] = await tx
          .select()
          .from(operationAuditStates)
          .where(eq(operationAuditStates.operationId, id));
        if (previous && previous.evaluatedAt > now) return false;
        const [current] = await tx.execute<{
          operationId: string;
          groupId: string;
          status: string;
        }>(
          sql`${operationAggregation(sql`o.operation_id=${id}::uuid`, now)} SELECT "operationId","groupId",status FROM summaries`,
        );
        if (!current) return false;
        const finished = ["COMPLETED", "PARTIALLY_FAILED", "FAILED"].includes(
          current.status,
        );
        const firstFinishedAt =
          previous?.firstFinishedAt ?? (finished ? now : null);
        if (previous?.status !== current.status)
          await appendAudit(tx, {
            action: "operation.status_changed",
            targetKind: "operation",
            targetId: id,
            operationId: id,
            groupId: current.groupId,
            system: "operation-evaluator",
            metadata: {
              beforeStatus: previous?.status ?? null,
              afterStatus: current.status,
            },
          });
        await tx
          .insert(operationAuditStates)
          .values({
            operationId: id,
            status: current.status,
            evaluatedAt: now,
            firstFinishedAt,
          })
          .onConflictDoUpdate({
            target: operationAuditStates.operationId,
            set: { status: current.status, evaluatedAt: now, firstFinishedAt },
          });
        return previous?.status !== current.status;
      });
    },
  };
}
export function createOperationAuditWorker(
  repository: ReturnType<typeof createOperationAuditRepository>,
  intervalMs: number,
  report: (metrics: {
    evaluated: number;
    changed: number;
    failed: number;
  }) => void,
) {
  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> | undefined;
  function runOnce() {
    active ??= (async () => {
      const metrics = { evaluated: 0, changed: 0, failed: 0 };
      const now = new Date();
      try {
        for (const id of await repository.operationIds()) {
          if (stopping) break;
          try {
            if (await repository.evaluateOperation(id, now)) metrics.changed++;
            metrics.evaluated++;
          } catch {
            metrics.failed++;
          }
        }
      } catch {
        metrics.failed++;
      }
      try {
        report(metrics);
      } catch {
        /* 計測失敗はcommit結果を変えない */
      }
    })().finally(() => {
      active = undefined;
    });
    return active;
  }
  async function tick() {
    await runOnce();
    if (!stopping) timer = setTimeout(() => void tick(), intervalMs);
  }
  return {
    runOnce,
    start() {
      if (!stopping && !active && !timer) void tick();
    },
    async stop() {
      stopping = true;
      clearTimeout(timer);
      await active;
    },
  };
}
