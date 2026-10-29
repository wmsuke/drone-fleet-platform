import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  otaRequestMessageSchema,
  otaEventMessageSchema,
  otaInventoryMessageSchema,
} from "@drone-fleet/protocol";
import type { Database } from "./connection.js";
import { otaDeploymentLock } from "./ota.js";
import { appendAudit } from "./audit.js";
import {
  otaDeployments,
  otaStages,
  otaTargets,
  otaAttempts,
  otaOutbox,
  otaRollouts,
  otaActions,
  otaDispatches,
  otaStops,
  otaEvents,
  otaDeviceStates,
  otaReservations,
  otaInventories,
  otaRecoveries,
} from "./schema.js";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Deployment = typeof otaDeployments.$inferSelect;
export class OtaControlError extends Error {
  constructor(
    public readonly status: 404 | 409,
    public readonly reason: string,
  ) {
    super(reason);
  }
}
const fail = (reason: string): never => {
  throw new OtaControlError(409, reason);
};
const delay = (n: number) => {
  const cap = Math.min(8000, 1000 * 2 ** n);
  return Math.floor(cap / 2 + (Math.random() * cap) / 2);
};
async function rows(tx: Tx, id: string) {
  return tx
    .select({ target: otaTargets, attempt: otaAttempts, outbox: otaOutbox })
    .from(otaTargets)
    .innerJoin(otaAttempts, eq(otaAttempts.targetId, otaTargets.targetId))
    .innerJoin(otaOutbox, eq(otaOutbox.commandId, otaAttempts.commandId))
    .where(
      and(
        eq(otaTargets.deploymentId, id),
        sql`NOT EXISTS (SELECT 1 FROM ota_attempts newer WHERE newer.target_id=${otaAttempts.targetId} AND newer.ordinal>${otaAttempts.ordinal})`,
      ),
    )
    .orderBy(asc(otaTargets.deviceId));
}
type Row = Awaited<ReturnType<typeof rows>>[number];
async function facts(tx: Tx, r: Row) {
  const events = await tx
    .select()
    .from(otaEvents)
    .where(
      and(
        eq(otaEvents.attemptId, r.attempt.attemptId),
        eq(otaEvents.acceptance, "ACCEPTED"),
      ),
    )
    .orderBy(desc(otaEvents.sequence));
  return events.map((e) => ({
    ...e,
    event: otaEventMessageSchema.parse(e.payload),
  }));
}
// 履歴の成功だけで解禁しない。現在のINVENTORYとchallenge応答の版・bootを照合する。
async function healthy(tx: Tx, r: Row, now: Date) {
  const [state] = await tx
    .select()
    .from(otaDeviceStates)
    .where(eq(otaDeviceStates.deviceId, r.target.deviceId));
  const events = await facts(tx, r);
  const health = events.find((e) => e.event.type === "HEALTH"),
    version = events.find((e) => e.event.type === "VERSION");
  if (
    !state ||
    !health ||
    health.event.type !== "HEALTH" ||
    !version ||
    version.event.type !== "VERSION"
  )
    return false;
  const h = health.event,
    v = version.event;
  return (
    now >= state.observedAt &&
    now.getTime() - state.observedAt.getTime() < 15000 &&
    now >= health.storedAt &&
    now.getTime() - health.storedAt.getTime() < 15000 &&
    Object.values(h.checks).every((x) => x === "PASSED") &&
    h.running.bootId === v.running.bootId &&
    h.supervisorBootId === v.supervisorBootId &&
    state.snapshot.bootId === h.running.bootId &&
    Object.entries(h.running.release).every(
      ([k, value]) => state.snapshot[k] === value,
    )
  );
}
async function owns(tx: Tx, r: Row) {
  const [state] = await tx
    .select()
    .from(otaDeviceStates)
    .where(eq(otaDeviceStates.deviceId, r.target.deviceId));
  const [reservation] = await tx
    .select()
    .from(otaReservations)
    .where(eq(otaReservations.deviceId, r.target.deviceId));
  return (
    state?.highestFence === r.attempt.fence &&
    reservation?.targetId === r.target.targetId
  );
}
async function stopConfirmed(tx: Tx, r: Row, now: Date) {
  if (!r.outbox.attempts) return true; // claimしていない要求は送っていない。
  if (r.attempt.evaluationStatus === "SUCCEEDED" && (await healthy(tx, r, now)))
    return true;
  const [stop] = await tx
    .select()
    .from(otaStops)
    .where(eq(otaStops.attemptId, r.attempt.attemptId));
  const events = await facts(tx, r);
  const state = events.find((e) => e.event.type === "STATE");
  if (
    r.attempt.evaluationStatus === "FAILED" &&
    state?.event.type === "STATE" &&
    ["FAILED", "APPLIED"].includes(state.event.state) &&
    state.event.running &&
    now >= state.storedAt &&
    now.getTime() - state.storedAt.getTime() < 15000
  )
    return true;
  // STOPPED通知と、その後の実稼働版の照会を両方要求する。
  return Boolean(
    stop?.confirmedEventId &&
    state?.event.type === "STATE" &&
    state.event.state === "STOPPED" &&
    state.event.running &&
    state.receivedAt >= stop.createdAt &&
    now >= state.storedAt &&
    now.getTime() - state.storedAt.getTime() < 15000,
  );
}
async function latch(
  tx: Tx,
  d: Deployment,
  now: Date,
  reason: string,
  automatic = true,
) {
  const [before] = await tx
    .select()
    .from(otaRollouts)
    .where(eq(otaRollouts.deploymentId, d.deploymentId));
  if (!before?.stoppedAt && automatic)
    await appendAudit(tx, {
      action: "deployment.stopped",
      targetKind: "deployment",
      targetId: d.deploymentId,
      system: "ota-worker",
      metadata: { reason, afterStatus: "STOPPING" },
    });
  await tx
    .insert(otaRollouts)
    .values({
      deploymentId: d.deploymentId,
      stoppedAt: now,
      stopReason: reason,
    })
    .onConflictDoUpdate({
      target: otaRollouts.deploymentId,
      set: {
        stoppedAt: sql`COALESCE(${otaRollouts.stoppedAt}, ${now.toISOString()}::timestamptz)`,
        stopReason: sql`COALESCE(${otaRollouts.stopReason}, ${reason})`,
      },
    });
  await tx
    .update(otaDeployments)
    .set({ status: "STOPPING" })
    .where(eq(otaDeployments.deploymentId, d.deploymentId));
  await tx
    .update(otaStages)
    .set({ status: "STOPPING" })
    .where(
      and(
        eq(otaStages.deploymentId, d.deploymentId),
        sql`${otaStages.status} IN ('RUNNING','PAUSED')`,
      ),
    );
}
export function createOtaRollout(
  db: Database,
  options: {
    clock?: () => Date;
    validate?: (
      deployment: Deployment,
      targets: {
        deviceId: string;
        snapshot: Record<string, unknown>;
        observedAt: Date;
      }[],
      now: Date,
    ) => Promise<void>;
  } = {},
) {
  async function clock(tx: Tx) {
    if (options.clock) return options.clock();
    const [t] = await tx.execute<{ now: string }>(
      sql`SELECT clock_timestamp()::text AS now`,
    );
    return new Date(t!.now);
  }
  async function validate(tx: Tx, d: Deployment, selected: Row[], now: Date) {
    for (const r of selected)
      if (!(await owns(tx, r))) fail("FENCE_OR_RESERVATION_CONFLICT");
    const states = [];
    for (const r of selected) {
      const [state] = await tx
        .select()
        .from(otaDeviceStates)
        .where(eq(otaDeviceStates.deviceId, r.target.deviceId));
      if (
        !state ||
        state.observedAt > now ||
        now.getTime() - state.observedAt.getTime() >= 15000
      )
        fail("DEVICE_OTA_UNCONFIRMED");
      states.push({
        deviceId: r.target.deviceId,
        snapshot: state!.snapshot,
        observedAt: state!.observedAt,
      });
    }
    await options.validate?.(d, states, now);
  }
  async function reconcile(tx: Tx, d: Deployment, now: Date) {
    if (["COMPLETED", "CANCELLED", "FAILED"].includes(d.status)) return;
    const recoveries = await tx
      .select()
      .from(otaRecoveries)
      .where(eq(otaRecoveries.deploymentId, d.deploymentId));
    if (
      d.status === "PAUSED" &&
      recoveries.some((r) => ["WAITING", "RUNNING"].includes(r.status))
    )
      return;
    const all = await rows(tx, d.deploymentId);
    for (const r of all) {
      if (
        r.attempt.expiresAt &&
        now >= r.attempt.expiresAt &&
        ["PENDING", "SENT"].includes(r.attempt.deliveryStatus)
      ) {
        await tx
          .update(otaAttempts)
          .set({ deliveryStatus: "EXPIRED" })
          .where(eq(otaAttempts.attemptId, r.attempt.attemptId));
        await tx
          .update(otaOutbox)
          .set({ status: "EXPIRED" })
          .where(eq(otaOutbox.commandId, r.attempt.commandId));
        r.attempt.deliveryStatus = "EXPIRED";
      }
    }
    const stages = await tx
      .select()
      .from(otaStages)
      .where(eq(otaStages.deploymentId, d.deploymentId))
      .orderBy(asc(otaStages.position));
    let [control] = await tx
      .select()
      .from(otaRollouts)
      .where(eq(otaRollouts.deploymentId, d.deploymentId));
    for (const stage of stages.filter((s) =>
      ["RUNNING", "STOPPING"].includes(s.status),
    )) {
      const targets = all.filter((r) => r.target.stageId === stage.stageId);
      const failures = targets.filter(
        (r) =>
          r.attempt.evaluationStatus === "FAILED" ||
          (r.attempt.evaluationStatus !== "SUCCEEDED" &&
            (r.attempt.deliveryStatus === "EXPIRED" ||
              r.attempt.applicationStatus === "STOPPED")),
      ).length;
      const uncertain = targets.some(
        (r) =>
          r.attempt.evaluationStatus === "UNCERTAIN" ||
          (r.attempt.resultDeadline &&
            now >= r.attempt.resultDeadline &&
            r.attempt.evaluationStatus !== "SUCCEEDED"),
      );
      // #170のintegrity検出も同じ永続latchへ引き継ぐ。
      if (
        !control?.stoppedAt &&
        (stage.status === "STOPPING" ||
          uncertain ||
          failures * 10 >= stage.deviceIds.length)
      ) {
        await latch(
          tx,
          d,
          now,
          uncertain
            ? "UNCERTAIN"
            : stage.status === "STOPPING"
              ? "EVALUATION_STOP"
              : "FAILURE_THRESHOLD",
        );
        [control] = await tx
          .select()
          .from(otaRollouts)
          .where(eq(otaRollouts.deploymentId, d.deploymentId));
      }
    }
    if (control?.stoppedAt) {
      let confirmed = true;
      for (const r of all) {
        if (!r.outbox.attempts) continue;
        if (
          r.attempt.evaluationStatus !== "SUCCEEDED" &&
          !(await stopConfirmed(tx, r, now))
        ) {
          const [existing] = await tx
            .select()
            .from(otaStops)
            .where(eq(otaStops.attemptId, r.attempt.attemptId));
          if (!existing) {
            const apply = otaRequestMessageSchema.parse(
              JSON.parse(r.outbox.payload!),
            );
            const payload = otaRequestMessageSchema.parse({
              ...Object.fromEntries(
                Object.entries(apply).filter(
                  ([k]) => !["purpose", "recovery"].includes(k),
                ),
              ),
              type: "STOP_UPDATE",
              commandId: randomUUID(),
              applyCommandId: r.attempt.commandId,
              createdAt: now.toISOString(),
              expiresAt: new Date(now.getTime() + 30000).toISOString(),
              resultDeadline: new Date(now.getTime() + 60000).toISOString(),
            });
            await tx.insert(otaStops).values({
              commandId: payload.commandId,
              attemptId: r.attempt.attemptId,
              payload,
              createdAt: now,
              expiresAt: new Date(payload.expiresAt),
              resultDeadline: new Date(payload.resultDeadline),
              nextAttemptAt: now,
            });
          }
        }
        if (!(await stopConfirmed(tx, r, now))) confirmed = false;
      }
      const stops = await tx
        .select()
        .from(otaStops)
        .innerJoin(otaAttempts, eq(otaAttempts.attemptId, otaStops.attemptId))
        .innerJoin(otaTargets, eq(otaTargets.targetId, otaAttempts.targetId))
        .where(eq(otaTargets.deploymentId, d.deploymentId));
      const timedOut =
        now.getTime() >= control.stoppedAt.getTime() + 60000 ||
        stops.some(
          (s) =>
            !s.ota_stops.confirmedEventId && now >= s.ota_stops.resultDeadline,
        );
      await tx
        .update(otaDeployments)
        .set({
          status: recoveries.some(
            (r) =>
              (r.kind === "ROLLBACK" && r.status === "SUCCEEDED") ||
              (["FAILED", "UNCERTAIN", "UNAVAILABLE"].includes(r.status) &&
                ![
                  "RECOVERY_ACTIVE",
                  "DEPLOYMENT_NOT_PAUSED",
                  "FAILURE_UNCONFIRMED",
                ].includes(r.failureReason ?? "")),
          )
            ? "WAITING_FOR_HUMAN"
            : confirmed
              ? "PAUSED"
              : timedOut
                ? "WAITING_FOR_HUMAN"
                : "STOPPING",
        })
        .where(eq(otaDeployments.deploymentId, d.deploymentId));
      if (confirmed)
        await tx
          .update(otaStages)
          .set({ status: "PAUSED" })
          .where(
            and(
              eq(otaStages.deploymentId, d.deploymentId),
              eq(otaStages.status, "STOPPING"),
            ),
          );
      return;
    }
    for (const stage of stages.filter((s) => s.status === "RUNNING")) {
      const targets = all.filter((r) => r.target.stageId === stage.stageId);
      if (
        targets.length === stage.deviceIds.length &&
        targets.every(
          (r) =>
            r.attempt.evaluationStatus === "SUCCEEDED" &&
            r.attempt.purpose === "APPLY",
        )
      ) {
        if (
          !(await Promise.all(targets.map((r) => healthy(tx, r, now)))).every(
            Boolean,
          )
        )
          continue;
        await tx
          .update(otaStages)
          .set({ status: "PASSED" })
          .where(eq(otaStages.stageId, stage.stageId));
        const next = stages.find((s) => s.position === stage.position + 1);
        if (next)
          await tx
            .update(otaStages)
            .set({ status: "AWAITING_APPROVAL" })
            .where(eq(otaStages.stageId, next.stageId));
      } else if (
        targets.length &&
        targets.every((r) =>
          ["SUCCEEDED", "FAILED"].includes(r.attempt.evaluationStatus),
        )
      ) {
        // 閾値未満でも全N成功でなければ昇格させない。
        await latch(tx, d, now, "STAGE_INCOMPLETE");
      }
    }
    const updated = await tx
      .select()
      .from(otaStages)
      .where(eq(otaStages.deploymentId, d.deploymentId));
    if (
      updated.length &&
      updated.every((s) => s.status === "PASSED") &&
      all.every(
        (r) =>
          r.attempt.evaluationStatus === "SUCCEEDED" &&
          r.attempt.purpose === "APPLY",
      ) &&
      (await Promise.all(all.map((r) => healthy(tx, r, now)))).every(Boolean)
    ) {
      await tx
        .update(otaDeployments)
        .set({ status: "COMPLETED" })
        .where(eq(otaDeployments.deploymentId, d.deploymentId));
      for (const r of all)
        await tx
          .delete(otaReservations)
          .where(
            and(
              eq(otaReservations.deviceId, r.target.deviceId),
              eq(otaReservations.targetId, r.target.targetId),
            ),
          );
    }
  }
  return {
    async act(
      id: string,
      action: "approve" | "stop" | "resume",
      key: string,
      reason: string,
      stageId?: string,
    ) {
      const requestHash = createHash("sha256")
        .update(JSON.stringify({ action, reason, stageId: stageId ?? null }))
        .digest("hex");
      return db.transaction(async (tx) => {
        await otaDeploymentLock(tx, id);
        const [d] = await tx
          .select()
          .from(otaDeployments)
          .where(eq(otaDeployments.deploymentId, id));
        if (!d) throw new OtaControlError(404, "DEPLOYMENT_NOT_FOUND");
        const [previous] = await tx
          .select()
          .from(otaActions)
          .where(and(eq(otaActions.deploymentId, id), eq(otaActions.key, key)));
        if (previous) {
          if (previous.requestHash !== requestHash)
            fail("IDEMPOTENCY_CONFLICT");
          return previous.response;
        }
        const now = await clock(tx);
        if (action === "stop")
          await tx
            .update(otaRecoveries)
            .set({
              status: "CANCELLED",
              finishedAt: now,
              failureReason: "OPERATOR_STOP",
            })
            .where(
              and(
                eq(otaRecoveries.deploymentId, id),
                sql`${otaRecoveries.status} IN ('WAITING','RUNNING')`,
              ),
            );
        await reconcile(tx, d, now);
        const [current] = await tx
          .select()
          .from(otaDeployments)
          .where(eq(otaDeployments.deploymentId, id));
        const [control] = await tx
          .select()
          .from(otaRollouts)
          .where(eq(otaRollouts.deploymentId, id));
        const all = await rows(tx, id);
        let status: string;
        if (action === "stop") {
          if (["COMPLETED", "FAILED", "CANCELLED"].includes(current!.status))
            fail("DEPLOYMENT_TERMINAL");
          await latch(tx, d, now, reason, false);
          status = "STOPPING";
        } else if (action === "resume") {
          if (all.some((r) => r.attempt.purpose === "ROLLBACK"))
            fail("ROLLBACK_REQUIRES_NEW_DEPLOYMENT");
          if (current!.status !== "PAUSED" || !control?.stoppedAt)
            fail("STOP_UNCONFIRMED");
          await validate(tx, d, all, now);
          for (const r of all) {
            if (!(await stopConfirmed(tx, r, now))) fail("STOP_UNCONFIRMED");
            // 端末がtombstone化した同attemptを再実行しない。#172の新attemptが必要。
            const [stop] = await tx
              .select()
              .from(otaStops)
              .where(eq(otaStops.attemptId, r.attempt.attemptId));
            if (
              stop ||
              ["FAILED", "UNCERTAIN"].includes(r.attempt.evaluationStatus)
            )
              fail("NEW_ATTEMPT_REQUIRED");
            if (
              r.attempt.startedAt &&
              r.attempt.evaluationStatus !== "SUCCEEDED" &&
              now >= r.attempt.expiresAt!
            )
              fail("ATTEMPT_EXPIRED");
            if (
              r.attempt.evaluationStatus === "SUCCEEDED" &&
              !(await healthy(tx, r, now))
            )
              fail("HEALTH_UNCONFIRMED");
            if (r.attempt.evaluationStatus !== "SUCCEEDED") {
              const [inventory] = await tx
                .select()
                .from(otaInventories)
                .where(
                  and(
                    eq(otaInventories.deviceId, r.target.deviceId),
                    eq(otaInventories.reason, "ACCEPTED"),
                  ),
                )
                .orderBy(desc(otaInventories.sequence))
                .limit(1);
              const observation = otaInventoryMessageSchema.safeParse(
                inventory?.payload,
              );
              const readiness = observation.success
                ? observation.data.readiness
                : undefined;
              const [state] = await tx
                .select()
                .from(otaDeviceStates)
                .where(eq(otaDeviceStates.deviceId, r.target.deviceId));
              if (
                !inventory ||
                now < inventory.receivedAt ||
                now.getTime() - inventory.receivedAt.getTime() >= 15000 ||
                !readiness ||
                Object.values(readiness).length !== 7 ||
                Object.values(readiness).some((v) => v !== "PASSED") ||
                !observation.success ||
                observation.data.running.bootId !== state?.snapshot.bootId ||
                !Object.entries(observation.data.running.release).every(
                  ([k, v]) => state?.snapshot[k] === v,
                )
              )
                fail("HEALTH_UNCONFIRMED");
            }
          }
          await tx
            .update(otaRollouts)
            .set({ stoppedAt: null, stopReason: null })
            .where(eq(otaRollouts.deploymentId, id));
          await tx
            .update(otaStages)
            .set({ status: "RUNNING" })
            .where(
              and(
                eq(otaStages.deploymentId, id),
                eq(otaStages.status, "PAUSED"),
              ),
            );
          status = "RUNNING";
          await tx
            .update(otaDeployments)
            .set({ status })
            .where(eq(otaDeployments.deploymentId, id));
        } else {
          if (
            control?.stoppedAt ||
            !["ACCEPTED", "RUNNING"].includes(current!.status)
          )
            fail("DEPLOYMENT_STOPPED");
          const stages = await tx
            .select()
            .from(otaStages)
            .where(eq(otaStages.deploymentId, id))
            .orderBy(asc(otaStages.position));
          const stage = stages.find((s) => s.stageId === stageId);
          if (!stage || stage.status !== "AWAITING_APPROVAL")
            fail("STAGE_NOT_READY");
          for (const s of stages.filter((s) => s.position < stage!.position)) {
            const previous = all.filter((r) => r.target.stageId === s.stageId);
            if (
              s.status !== "PASSED" ||
              previous.length !== s.deviceIds.length ||
              previous.some(
                (r) => r.attempt.evaluationStatus !== "SUCCEEDED",
              ) ||
              !(
                await Promise.all(previous.map((r) => healthy(tx, r, now)))
              ).every(Boolean)
            )
              fail("PREVIOUS_STAGE_UNCONFIRMED");
          }
          const selected = all.filter(
            (r) => r.target.stageId === stage!.stageId,
          );
          await validate(tx, d, selected, now);
          const manifest = d.releaseSnapshot.manifest as Record<
            string,
            unknown
          >;
          for (const r of selected) {
            if (r.attempt.deliveryStatus !== "HELD")
              fail("ATTEMPT_ALREADY_RELEASED");
            const expiresAt = new Date(now.getTime() + 300000),
              resultDeadline = new Date(now.getTime() + 600000);
            const payload = otaRequestMessageSchema.parse({
              schemaVersion: 1,
              type: "APPLY_RELEASE",
              purpose: r.attempt.purpose,
              deviceId: r.target.deviceId,
              deploymentId: id,
              stageId: stage!.stageId,
              targetId: r.target.targetId,
              attemptId: r.attempt.attemptId,
              fence: r.attempt.fence.toString(),
              commandId: r.attempt.commandId,
              release: {
                releaseId: manifest.releaseId,
                digest: manifest.digest,
                version: manifest.version,
                buildId: manifest.buildId,
              },
              createdAt: now.toISOString(),
              expiresAt: expiresAt.toISOString(),
              resultDeadline: resultDeadline.toISOString(),
              evaluationVersion: "ota-health-v1",
            });
            await tx
              .update(otaAttempts)
              .set({
                startedAt: now,
                expiresAt,
                resultDeadline,
                deliveryStatus: "PENDING",
              })
              .where(eq(otaAttempts.attemptId, r.attempt.attemptId));
            await tx
              .update(otaOutbox)
              .set({
                payload: JSON.stringify(payload),
                expiresAt,
                nextAttemptAt: now,
                status: "PENDING",
              })
              .where(eq(otaOutbox.commandId, r.attempt.commandId));
          }
          await tx
            .update(otaStages)
            .set({ status: "RUNNING" })
            .where(eq(otaStages.stageId, stage!.stageId));
          status = "RUNNING";
          await tx
            .update(otaDeployments)
            .set({ status })
            .where(eq(otaDeployments.deploymentId, id));
        }
        const response = {
          actionId: randomUUID(),
          deploymentId: id,
          stageId: stageId ?? null,
          action,
          status,
          createdAt: now.toISOString(),
        };
        await tx.insert(otaActions).values({
          actionId: response.actionId,
          deploymentId: id,
          key,
          requestHash,
          action,
          reason,
          response,
          createdAt: now,
        });
        await appendAudit(tx, {
          action:
            action === "approve"
              ? "deployment.approved"
              : action === "stop"
                ? "deployment.stopped"
                : "deployment.resumed",
          targetKind: "deployment",
          targetId: id,
          metadata: { reason, afterStatus: status },
        });
        return response;
      });
    },
    async tick() {
      const deployments = await db
        .select()
        .from(otaDeployments)
        .where(
          sql`${otaDeployments.status} NOT IN ('COMPLETED','FAILED','CANCELLED')`,
        )
        .orderBy(asc(otaDeployments.createdAt));
      const sends: {
        deploymentId: string;
        commandId: string;
        topic: string;
        payload: string;
        expiresAt: Date;
        stop: boolean;
      }[] = [];
      for (const d of deployments)
        await db.transaction(async (tx) => {
          // 全worker・deploymentに共通のclaim速度と同時数。順序はglobal→deployment。
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended('ota-dispatch',0))`,
          );
          await otaDeploymentLock(tx, d.deploymentId);
          const [current] = await tx
            .select()
            .from(otaDeployments)
            .where(eq(otaDeployments.deploymentId, d.deploymentId));
          const now = await clock(tx);
          await reconcile(tx, current!, now);
          const [control] = await tx
            .select()
            .from(otaRollouts)
            .where(eq(otaRollouts.deploymentId, d.deploymentId));
          const all = await rows(tx, d.deploymentId);
          if (control?.stoppedAt) {
            for (const r of all) {
              const [recovering] = await tx
                .select()
                .from(otaRecoveries)
                .where(
                  and(
                    eq(otaRecoveries.attemptId, r.attempt.attemptId),
                    sql`${otaRecoveries.status} IN ('WAITING','RUNNING')`,
                  ),
                );
              if (recovering && current!.status === "PAUSED") continue;
              const [stop] = await tx
                .select()
                .from(otaStops)
                .where(eq(otaStops.attemptId, r.attempt.attemptId));
              if (
                !stop ||
                stop.confirmedEventId ||
                now >= stop.expiresAt ||
                now < stop.nextAttemptAt ||
                stop.attempts >= 5
              )
                continue;
              await tx
                .update(otaStops)
                .set({
                  attempts: stop.attempts + 1,
                  nextAttemptAt: new Date(now.getTime() + delay(stop.attempts)),
                })
                .where(eq(otaStops.commandId, stop.commandId));
              sends.push({
                deploymentId: d.deploymentId,
                commandId: stop.commandId,
                topic: r.outbox.topic,
                payload: JSON.stringify(stop.payload),
                expiresAt: stop.expiresAt,
                stop: true,
              });
            }
            return;
          }
          const [last] = await tx
            .select()
            .from(otaDispatches)
            .orderBy(desc(otaDispatches.claimedAt))
            .limit(1);
          if (last && now.getTime() - last.claimedAt.getTime() < 1000) return;
          const [count] = await tx.execute<{ n: number }>(
            sql`SELECT count(*)::int AS n FROM ota_dispatches d JOIN ota_attempts a USING(attempt_id) WHERE a.evaluation_status<>'SUCCEEDED' AND NOT EXISTS(SELECT 1 FROM ota_stops s WHERE s.attempt_id=a.attempt_id AND s.confirmed_event_id IS NOT NULL) AND NOT (a.evaluation_status='FAILED' AND EXISTS(SELECT 1 FROM ota_events e WHERE e.attempt_id=a.attempt_id AND e.acceptance='ACCEPTED' AND e.payload->>'type'='STATE' AND e.payload->>'state' IN ('FAILED','APPLIED') AND e.payload->'running'<>'null'::jsonb))`,
          );
          const stages = await tx
            .select()
            .from(otaStages)
            .where(eq(otaStages.deploymentId, d.deploymentId));
          // 空きslotへ未送信targetを先に割り当て、同一targetの再送による飢餓を避ける。
          const candidates = [...all].sort(
            (a, b) =>
              Number(a.outbox.attempts > 0) - Number(b.outbox.attempts > 0),
          );
          for (const r of candidates) {
            if (
              !stages.some(
                (s) => s.stageId === r.target.stageId && s.status === "RUNNING",
              ) ||
              !["PENDING", "SENT"].includes(r.outbox.status) ||
              !r.outbox.payload ||
              !r.outbox.expiresAt ||
              now >= r.outbox.expiresAt ||
              now < r.outbox.nextAttemptAt! ||
              r.outbox.attempts >= 5 ||
              (!r.outbox.attempts && count!.n >= 2)
            )
              continue;
            if (!(await owns(tx, r))) {
              await latch(tx, d, now, "FENCE_CONFLICT");
              return;
            }
            // 各送信の前に試行を永続化する。失敗・再起動でも同じpayloadと期限だけ再送。
            await tx
              .update(otaOutbox)
              .set({
                attempts: r.outbox.attempts + 1,
                status: "SENT",
                nextAttemptAt: new Date(
                  now.getTime() + delay(r.outbox.attempts),
                ),
              })
              .where(eq(otaOutbox.commandId, r.outbox.commandId));
            await tx
              .update(otaAttempts)
              .set({ deliveryStatus: "SENT" })
              .where(eq(otaAttempts.attemptId, r.attempt.attemptId));
            await tx
              .insert(otaDispatches)
              .values({ attemptId: r.attempt.attemptId, claimedAt: now })
              .onConflictDoUpdate({
                target: otaDispatches.attemptId,
                set: { claimedAt: now },
              });
            sends.push({
              deploymentId: d.deploymentId,
              commandId: r.outbox.commandId,
              topic: r.outbox.topic,
              payload: r.outbox.payload,
              expiresAt: r.outbox.expiresAt,
              stop: false,
            });
            break; // 新規要求・再送を合わせて全体1件/秒。
          }
        });
      return sends;
    },
    async deliver(
      send: {
        deploymentId: string;
        commandId: string;
        topic: string;
        payload: string;
        expiresAt: Date;
        stop: boolean;
      },
      publish: (
        topic: string,
        payload: string,
        expiresAt: Date,
      ) => Promise<void>,
    ) {
      return db.transaction(async (tx) => {
        await otaDeploymentLock(tx, send.deploymentId);
        const now = await clock(tx);
        if (now >= send.expiresAt) return;
        const [d] = await tx
          .select()
          .from(otaDeployments)
          .where(eq(otaDeployments.deploymentId, send.deploymentId));
        const [control] = await tx
          .select()
          .from(otaRollouts)
          .where(eq(otaRollouts.deploymentId, send.deploymentId));
        if (!send.stop && (control?.stoppedAt || d?.status !== "RUNNING"))
          return;
        const current = (await rows(tx, send.deploymentId)).find(
          (r) => r.attempt.commandId === send.commandId,
        );
        if (
          !send.stop &&
          (!current ||
            !(await owns(tx, current)) ||
            !["PENDING", "SENT"].includes(current.outbox.status))
        )
          return;
        // publish中も同じlockを保持。停止受付後に未送信claimを外へ出さない。
        await publish(send.topic, send.payload, send.expiresAt);
      });
    },
  };
}
