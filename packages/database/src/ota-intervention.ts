import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "./connection.js";
import { appendAudit, type AuditEvent } from "./audit.js";
import { otaDeploymentLock } from "./ota.js";
import { OtaControlError } from "./ota-rollout.js";
import {
  otaDeployments,
  otaTargets,
  otaAttempts,
  otaRecoveries,
  otaInterventions,
} from "./schema.js";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type NewIntervention = typeof otaInterventions.$inferInsert;
const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const conflict = (reason: string): never => {
  throw new OtaControlError(409, reason);
};

// 呼出元の操作・状態変更と同じtransactionで保存する。replayは呼出元で解決する。
export async function recordOtaIntervention(
  tx: Tx,
  input: Omit<NewIntervention, "auditEventId" | "actorKind" | "actorId">,
  audit: AuditEvent,
) {
  const auditEventId = await appendAudit(tx, {
    ...audit,
    metadata: { ...audit.metadata, interventionId: input.interventionId },
  });
  await tx
    .insert(otaInterventions)
    .values({ ...input, actorKind: "anonymous", actorId: null, auditEventId });
}

export interface ReviewCompletion {
  reason: string;
  outcome: "KEEP_STOPPED" | "ESCALATED" | "RECOVERY_REQUESTED";
  recoveryId?: string;
  durationMs?: number;
}
export function createOtaInterventions(db: Database) {
  async function lock(tx: Tx, id: string) {
    await otaDeploymentLock(tx, id);
    const [d] = await tx
      .select()
      .from(otaDeployments)
      .where(eq(otaDeployments.deploymentId, id));
    if (!d) throw new OtaControlError(404, "DEPLOYMENT_NOT_FOUND");
    const [time] = await tx.execute<{ now: string }>(
      sql`SELECT clock_timestamp()::text AS now`,
    );
    return { d, now: new Date(time!.now) };
  }
  return {
    async startReview(id: string, key: string, reason: string) {
      const requestHash = hash({ reason });
      return db.transaction(async (tx) => {
        const { d, now } = await lock(tx, id);
        const [prior] = await tx
          .select()
          .from(otaInterventions)
          .where(
            and(
              eq(otaInterventions.deploymentId, id),
              eq(otaInterventions.key, key),
            ),
          );
        if (prior) {
          if (prior.requestHash !== requestHash)
            conflict("IDEMPOTENCY_CONFLICT");
          return {
            interventionId: prior.interventionId,
            deploymentId: id,
            startedAt: prior.startedAt.toISOString(),
          };
        }
        if (!["WAITING_FOR_HUMAN", "PAUSED"].includes(d.status))
          conflict("HUMAN_REVIEW_NOT_READY");
        const [open] = await tx
          .select()
          .from(otaInterventions)
          .where(
            and(
              eq(otaInterventions.deploymentId, id),
              eq(otaInterventions.kind, "HUMAN_REVIEW"),
              sql`${otaInterventions.finishedAt} IS NULL`,
            ),
          );
        if (open) conflict("HUMAN_REVIEW_ACTIVE");
        const scope = await tx
          .select({
            targetId: otaTargets.targetId,
            attemptId: otaAttempts.attemptId,
          })
          .from(otaTargets)
          .innerJoin(otaAttempts, eq(otaAttempts.targetId, otaTargets.targetId))
          .where(
            and(
              eq(otaTargets.deploymentId, id),
              sql`NOT EXISTS (SELECT 1 FROM ota_attempts newer WHERE newer.target_id=${otaTargets.targetId} AND newer.ordinal>${otaAttempts.ordinal})`,
            ),
          )
          .orderBy(otaTargets.targetId);
        const interventionId = randomUUID();
        await recordOtaIntervention(
          tx,
          {
            interventionId,
            deploymentId: id,
            scope,
            kind: "HUMAN_REVIEW",
            category: "FAULT_RESPONSE",
            reason,
            operationResult: "OPEN",
            startedAt: now,
            key,
            requestHash,
          },
          {
            action: "deployment.intervention_started",
            targetKind: "deployment",
            targetId: id,
            metadata: { reason, afterStatus: "OPEN" },
          },
        );
        return {
          interventionId,
          deploymentId: id,
          startedAt: now.toISOString(),
        };
      });
    },
    async completeReview(
      id: string,
      interventionId: string,
      key: string,
      input: ReviewCompletion,
    ) {
      // 項目順・省略/nullの違いを正規化し、利用者がactorや終了時刻を指定する余地を作らない。
      const completionHash = hash({
        reason: input.reason,
        outcome: input.outcome,
        recoveryId: input.recoveryId ?? null,
        durationMs: input.durationMs ?? null,
      });
      return db.transaction(async (tx) => {
        const { now } = await lock(tx, id);
        const [r] = await tx
          .select()
          .from(otaInterventions)
          .where(
            and(
              eq(otaInterventions.deploymentId, id),
              eq(otaInterventions.interventionId, interventionId),
              eq(otaInterventions.kind, "HUMAN_REVIEW"),
            ),
          );
        if (!r) throw new OtaControlError(404, "INTERVENTION_NOT_FOUND");
        const present = (finishedAt: Date, outcome: string) => ({
          interventionId,
          deploymentId: id,
          finishedAt: finishedAt.toISOString(),
          outcome,
        });
        if (r.finishedAt) {
          if (r.completionKey !== key || r.completionHash !== completionHash)
            conflict("IDEMPOTENCY_CONFLICT");
          return present(r.finishedAt, r.operationResult);
        }
        if (
          input.durationMs !== undefined &&
          input.durationMs > now.getTime() - r.startedAt.getTime()
        )
          conflict("INVALID_INTERVENTION_DURATION");
        if (input.outcome === "RECOVERY_REQUESTED") {
          if (!input.recoveryId) conflict("RECOVERY_REFERENCE_REQUIRED");
          const [recovery] = await tx
            .select()
            .from(otaRecoveries)
            .where(
              and(
                eq(otaRecoveries.deploymentId, id),
                eq(otaRecoveries.recoveryId, input.recoveryId!),
              ),
            );
          if (!recovery?.attemptId || recovery.approvedAt < r.startedAt)
            conflict("INVALID_RECOVERY_REFERENCE");
        } else if (input.recoveryId) conflict("INVALID_RECOVERY_REFERENCE");
        const completionAuditEventId = await appendAudit(tx, {
          action: "deployment.intervention_completed",
          targetKind: "deployment",
          targetId: id,
          metadata: {
            reason: input.reason,
            afterStatus: input.outcome,
            interventionId,
          },
        });
        await tx
          .update(otaInterventions)
          .set({
            finishedAt: now,
            durationMs: input.durationMs ?? null,
            operationResult: input.outcome,
            completionReason: input.reason,
            resolutionRecoveryId: input.recoveryId ?? null,
            completionAuditEventId,
            completionKey: key,
            completionHash,
          })
          .where(eq(otaInterventions.interventionId, interventionId));
        // 判断記録だけで停止latch、予約、評価、WAITING_FOR_HUMANを解除しない。
        return present(now, input.outcome);
      });
    },
    async interventions(
      id: string,
      limit: number,
      cursor?: { startedAt: string; interventionId: string },
    ) {
      return db.transaction(
        async (tx) => {
          const [d] = await tx
            .select({ id: otaDeployments.deploymentId })
            .from(otaDeployments)
            .where(eq(otaDeployments.deploymentId, id));
          if (!d) return null;
          const rows = await tx
            .select()
            .from(otaInterventions)
            .where(
              and(
                eq(otaInterventions.deploymentId, id),
                cursor
                  ? sql`(${otaInterventions.startedAt},${otaInterventions.interventionId}) < (${cursor.startedAt}::timestamptz,${cursor.interventionId}::uuid)`
                  : undefined,
              ),
            )
            .orderBy(
              desc(otaInterventions.startedAt),
              desc(otaInterventions.interventionId),
            )
            .limit(limit + 1);
          const items = [];
          for (const r of rows.slice(0, limit)) {
            const recoveryId = r.recoveryId ?? r.resolutionRecoveryId;
            const [recovery] = recoveryId
              ? await tx
                  .select()
                  .from(otaRecoveries)
                  .where(eq(otaRecoveries.recoveryId, recoveryId))
              : [];
            items.push({
              interventionId: r.interventionId,
              deploymentId: r.deploymentId,
              stageId: r.stageId,
              targetId: r.targetId,
              attemptId: r.attemptId,
              recoveryId: r.recoveryId,
              actionId: r.actionId,
              scope: r.scope,
              actorKind: r.actorKind,
              actorId: r.actorId,
              kind: r.kind,
              category: r.category,
              reason: r.reason,
              operationResult: r.operationResult,
              durationMs: r.durationMs,
              cost: r.cost,
              auditEventId: r.auditEventId,
              completionAuditEventId: r.completionAuditEventId,
              completionReason: r.completionReason,
              resolutionRecoveryId: r.resolutionRecoveryId,
              startedAt: r.startedAt.toISOString(),
              finishedAt: r.finishedAt?.toISOString() ?? null,
              durationSource:
                r.durationMs === null ? null : "OPERATOR_REPORTED",
              excludesAutonomousCompletion: true,
              recovery: recovery
                ? {
                    recoveryId: recovery.recoveryId,
                    kind: recovery.kind,
                    previousAttemptId: recovery.previousAttemptId,
                    rootAttemptId: recovery.rootAttemptId,
                    attemptId: recovery.attemptId,
                    status: recovery.status,
                    detectedAt: recovery.detectedAt.toISOString(),
                    startedAt: recovery.startedAt?.toISOString() ?? null,
                    finishedAt: recovery.finishedAt?.toISOString() ?? null,
                    bytesAtApproval: recovery.bytesAtApproval,
                    downloadedBytes: recovery.downloadedBytes,
                    cost: recovery.cost,
                    evidence: recovery.evidence,
                    failureReason: recovery.failureReason,
                    requiredAction: recovery.requiredAction,
                  }
                : null,
            });
          }
          const last = rows[limit - 1];
          return {
            items,
            limit,
            nextCursor:
              rows.length > limit && last
                ? {
                    startedAt: last.startedAt.toISOString(),
                    interventionId: last.interventionId,
                  }
                : null,
          };
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },
  };
}
