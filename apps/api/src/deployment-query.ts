import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  otaDeployments,
  otaStages,
  otaTargets,
  otaAttempts,
  otaEvents,
  otaEvaluations,
  otaDeviceStates,
  otaRejections,
  type Database,
} from "@drone-fleet/database";

export function createDeploymentQueries(db: Database) {
  return {
    async list(limit: number, before?: string) {
      return db.transaction(
        async (tx) => {
          const rows = await tx
            .select()
            .from(otaDeployments)
            .where(
              before ? sql`${otaDeployments.createdAt} < ${before}` : undefined,
            )
            .orderBy(
              desc(otaDeployments.createdAt),
              desc(otaDeployments.deploymentId),
            )
            .limit(limit + 1);
          const items = [];
          for (const row of rows.slice(0, limit)) {
            const targets = await tx
              .select()
              .from(otaTargets)
              .where(eq(otaTargets.deploymentId, row.deploymentId));
            const counts: Record<string, number> = {};
            for (const target of targets)
              counts[target.status] = (counts[target.status] ?? 0) + 1;
            items.push({
              deploymentId: row.deploymentId,
              releaseId: row.releaseId,
              status: row.status,
              targetCount: row.targetCount,
              counts,
              createdAt: row.createdAt.toISOString(),
            });
          }
          return {
            items,
            limit,
            nextBefore:
              rows.length > limit
                ? rows[limit - 1]!.createdAt.toISOString()
                : null,
          };
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },
    async find(id: string, eventLimit: number, stageId?: string) {
      return db.transaction(
        async (tx) => {
          const [deployment] = await tx
            .select()
            .from(otaDeployments)
            .where(eq(otaDeployments.deploymentId, id));
          if (!deployment) return null;
          const [time] = await tx.execute<{ now: string }>(
            sql`SELECT clock_timestamp()::text AS now`,
          );
          const now = new Date(time!.now);
          const stages = await tx
            .select()
            .from(otaStages)
            .where(eq(otaStages.deploymentId, id))
            .orderBy(asc(otaStages.position));
          const targets = await tx
            .select()
            .from(otaTargets)
            .where(
              and(
                eq(otaTargets.deploymentId, id),
                stageId ? eq(otaTargets.stageId, stageId) : undefined,
              ),
            )
            .orderBy(asc(otaTargets.deviceId));
          const items = [];
          const stageCounts = new Map<string, Record<string, number>>();
          for (const target of targets) {
            const counts = stageCounts.get(target.stageId) ?? {};
            counts[target.status] = (counts[target.status] ?? 0) + 1;
            stageCounts.set(target.stageId, counts);
            const attempts = await tx
              .select()
              .from(otaAttempts)
              .where(eq(otaAttempts.targetId, target.targetId))
              .orderBy(desc(otaAttempts.ordinal));
            const histories = [];
            for (const attempt of attempts) {
              const events = await tx
                .select()
                .from(otaEvents)
                .where(eq(otaEvents.attemptId, attempt.attemptId))
                .orderBy(desc(otaEvents.sequence))
                .limit(eventLimit + 1);
              const evaluations = await tx
                .select()
                .from(otaEvaluations)
                .where(eq(otaEvaluations.attemptId, attempt.attemptId))
                .orderBy(
                  desc(otaEvaluations.evaluatedAt),
                  desc(otaEvaluations.evaluationId),
                )
                .limit(20);
              const rejections = await tx
                .select()
                .from(otaRejections)
                .where(eq(otaRejections.attemptId, attempt.attemptId))
                .orderBy(
                  desc(otaRejections.receivedAt),
                  desc(otaRejections.rejectionId),
                )
                .limit(20);
              const [counts] = await tx.execute<{
                events: number;
                rejected: number;
                conflicts: number;
                queries: number;
              }>(
                sql`SELECT (SELECT count(*)::int FROM ota_events WHERE attempt_id=${attempt.attemptId}) AS events, (SELECT count(*)::int FROM ota_events WHERE attempt_id=${attempt.attemptId} AND acceptance<>'ACCEPTED') AS rejected, (SELECT count(*)::int FROM ota_rejections WHERE attempt_id=${attempt.attemptId}) AS conflicts, (SELECT count(*)::int FROM ota_queries WHERE attempt_id=${attempt.attemptId}) AS queries`,
              );
              const health = await tx
                .select()
                .from(otaEvents)
                .where(
                  and(
                    eq(otaEvents.attemptId, attempt.attemptId),
                    eq(otaEvents.acceptance, "ACCEPTED"),
                    sql`${otaEvents.payload}->>'type'='HEALTH'`,
                  ),
                )
                .orderBy(desc(otaEvents.sequence))
                .limit(1);
              const state = await tx
                .select()
                .from(otaDeviceStates)
                .where(eq(otaDeviceStates.deviceId, target.deviceId))
                .limit(1);
              const sample = health[0],
                running = sample?.payload.running as
                  | { bootId?: string }
                  | undefined;
              const currentBoot = state[0]?.snapshot.bootId;
              const fresh = Boolean(
                sample &&
                now >= sample.storedAt &&
                now.getTime() - sample.storedAt.getTime() < 15000 &&
                Object.values(
                  sample.payload.checks as Record<string, string>,
                ).every((v) => v === "PASSED") &&
                (!currentBoot || currentBoot === running?.bootId),
              );
              histories.push({
                ...attempt,
                fence: attempt.fence.toString(),
                startedAt: attempt.startedAt?.toISOString() ?? null,
                expiresAt: attempt.expiresAt?.toISOString() ?? null,
                resultDeadline: attempt.resultDeadline?.toISOString() ?? null,
                freshHealth: fresh,
                counts,
                rejections: rejections.map((r) => ({
                  ...r,
                  receivedAt: r.receivedAt.toISOString(),
                })),
                events: events.slice(0, eventLimit).map((e) => ({
                  ...e,
                  sequence: e.sequence.toString(),
                  receivedAt: e.receivedAt.toISOString(),
                  storedAt: e.storedAt.toISOString(),
                  occurredAt: e.occurredAt.toISOString(),
                })),
                eventsTruncated: events.length > eventLimit,
                evaluations: evaluations.map((e) => ({
                  ...e,
                  evaluatedAt: e.evaluatedAt.toISOString(),
                })),
              });
            }
            const [current] = await tx
              .select()
              .from(otaDeviceStates)
              .where(eq(otaDeviceStates.deviceId, target.deviceId));
            items.push({
              ...target,
              current: current
                ? {
                    releaseId: current.snapshot.releaseId,
                    version: current.snapshot.version,
                    digest: current.snapshot.digest,
                    buildId: current.snapshot.buildId,
                    bootId: current.snapshot.bootId,
                    observedAt: current.observedAt.toISOString(),
                  }
                : null,
              attempts: histories,
            });
          }
          const stageItems = stages
            .filter((s) => !stageId || s.stageId === stageId)
            .map((s) => {
              const counts = stageCounts.get(s.stageId) ?? {};
              return { ...s, denominator: s.deviceIds.length, counts };
            });
          return {
            ...deployment,
            createdAt: deployment.createdAt.toISOString(),
            evaluatedAt: now.toISOString(),
            stages: stageItems,
            targets: items,
          };
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },
  };
}
