import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  otaEventMessageSchema,
  otaRequestMessageSchema,
  otaEventContextError,
  otaReceiptMessageSchema,
  otaInventoryMessageSchema,
  otaInventoryReceiptSchema,
  serializeOtaEvent,
  serializeOtaInventory,
  createOtaRequestsTopic,
  type OtaApplyRequest,
  type OtaEventMessage,
  type OtaReceiptMessage,
} from "@drone-fleet/protocol";
import type { Database } from "./connection.js";
import {
  otaAttempts,
  otaTargets,
  otaDeployments,
  otaStages,
  otaOutbox,
  otaEvents,
  otaRejections,
  otaEvaluations,
  otaQueries,
  otaStops,
  otaDeviceStates,
  otaInventories,
  otaReservations,
  otaRecoveries,
  devices,
  releases,
} from "./schema.js";
import { evaluateOta, type OtaVerdict } from "./ota-evaluation.js";
import { appendAudit } from "./audit.js";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
const hash = (json: string) => createHash("sha256").update(json).digest("hex");
export async function otaDeploymentLock(tx: Tx, id: string) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${"ota-deployment:" + id}, 0))`,
  );
}
async function context(tx: Tx, id: string) {
  const [row] = await tx
    .select({
      attempt: otaAttempts,
      target: otaTargets,
      deployment: otaDeployments,
      outbox: otaOutbox,
    })
    .from(otaAttempts)
    .innerJoin(otaTargets, eq(otaTargets.targetId, otaAttempts.targetId))
    .innerJoin(
      otaDeployments,
      eq(otaDeployments.deploymentId, otaTargets.deploymentId),
    )
    .innerJoin(otaOutbox, eq(otaOutbox.commandId, otaAttempts.commandId))
    .where(eq(otaAttempts.attemptId, id));
  if (!row) return null;
  const [current] = await tx
    .select()
    .from(otaAttempts)
    .where(eq(otaAttempts.targetId, row.target.targetId))
    .orderBy(desc(otaAttempts.ordinal))
    .limit(1);
  const [reservation] = await tx
    .select()
    .from(otaReservations)
    .where(eq(otaReservations.deviceId, row.target.deviceId));
  const [state] = await tx
    .select()
    .from(otaDeviceStates)
    .where(eq(otaDeviceStates.deviceId, row.target.deviceId));
  const apply = otaRequestMessageSchema.safeParse(
    row.outbox.payload ? JSON.parse(row.outbox.payload) : null,
  );
  const parsed =
    apply.success && apply.data.type === "APPLY_RELEASE" ? apply.data : null;
  const [recovery] = await tx
    .select()
    .from(otaRecoveries)
    .where(eq(otaRecoveries.attemptId, id));
  const manifest = (recovery?.releaseSnapshot ?? row.deployment.releaseSnapshot)
    .manifest as Record<string, unknown>;
  const assigned =
    parsed &&
    parsed.deviceId === row.target.deviceId &&
    parsed.deploymentId === row.target.deploymentId &&
    parsed.stageId === row.target.stageId &&
    parsed.targetId === row.target.targetId &&
    parsed.attemptId === id &&
    parsed.commandId === row.attempt.commandId &&
    parsed.purpose === row.attempt.purpose &&
    Boolean(parsed.recovery) === Boolean(recovery) &&
    (!recovery ||
      (parsed.recovery?.recoveryId === recovery.recoveryId &&
        parsed.recovery.previousAttemptId === recovery.previousAttemptId &&
        parsed.recovery.rootAttemptId === recovery.rootAttemptId &&
        parsed.recovery.budgetDeadline ===
          recovery.budgetDeadline.toISOString())) &&
    parsed.fence === row.attempt.fence.toString() &&
    parsed.createdAt === row.attempt.startedAt?.toISOString() &&
    parsed.resultDeadline === row.attempt.resultDeadline?.toISOString() &&
    parsed.expiresAt === row.attempt.expiresAt?.toISOString() &&
    Object.entries(parsed.release).every(
      ([key, value]) => manifest[key] === value,
    );
  return {
    ...row,
    recovery,
    current:
      current?.attemptId === id &&
      reservation?.targetId === row.target.targetId &&
      state?.highestFence === row.attempt.fence,
    apply: assigned ? parsed : null,
  };
}
function scopeValid(event: OtaEventMessage, apply: OtaApplyRequest) {
  return (
    event.deviceId === apply.deviceId &&
    event.deploymentId === apply.deploymentId &&
    event.stageId === apply.stageId &&
    event.targetId === apply.targetId &&
    event.attemptId === apply.attemptId &&
    event.fence === apply.fence &&
    event.applyCommandId === apply.commandId
  );
}
export function createOtaRepository(
  db: Database,
  options: { clock?: () => Date } = {},
) {
  async function clock(tx: Tx) {
    if (options.clock) return options.clock();
    const [row] = await tx.execute<{ now: string }>(
      sql`SELECT clock_timestamp()::text AS now`,
    );
    return new Date(row!.now);
  }
  async function evaluate(tx: Tx, id: string, now: Date) {
    const c = await context(tx, id);
    if (!c?.current || !c.apply) return;
    const rows = await tx
      .select()
      .from(otaEvents)
      .where(eq(otaEvents.attemptId, id))
      .orderBy(asc(otaEvents.sequence));
    const [previous] = await tx
      .select()
      .from(otaEvaluations)
      .where(eq(otaEvaluations.attemptId, id))
      .orderBy(desc(otaEvaluations.revision))
      .limit(1);
    const previousSuccess: OtaVerdict | undefined =
      previous?.status === "SUCCEEDED"
        ? {
            status: "SUCCEEDED",
            reason: previous.reason,
            evidence: previous.evidence,
          }
        : undefined;
    let verdict = evaluateOta(c.apply, rows, now, previousSuccess);
    const conflict = await tx
      .select()
      .from(otaRejections)
      .where(
        and(
          eq(otaRejections.attemptId, id),
          eq(otaRejections.reason, "EVENT_CONFLICT"),
        ),
      )
      .limit(1);
    if (conflict.length)
      verdict = {
        status: "UNCERTAIN",
        reason: "EVENT_CONFLICT",
        evidence: conflict.map((r) => r.rejectionId),
      };
    // 期限後の照合で、期限内成功へ戻さない。後の明示評価/介入は別recordで扱う。
    if (
      ["FAILED", "UNCERTAIN"].includes(previous?.status ?? "") &&
      !["FAILED", "UNCERTAIN"].includes(verdict.status)
    )
      verdict = {
        status: previous!.status as "FAILED" | "UNCERTAIN",
        reason: previous!.reason,
        evidence: previous!.evidence,
      };
    if (
      previous &&
      previous.status === verdict.status &&
      previous.reason === verdict.reason &&
      JSON.stringify(previous.evidence) === JSON.stringify(verdict.evidence)
    )
      return;
    const fingerprint = hash(
      JSON.stringify({ ...verdict, previous: previous?.evaluationId ?? null }),
    );
    await tx.insert(otaEvaluations).values({
      evaluationId: randomUUID(),
      attemptId: id,
      status: verdict.status,
      reason: verdict.reason,
      evidence: verdict.evidence,
      fingerprint,
      evaluatedAt: now,
    });
    await tx
      .update(otaAttempts)
      .set({ evaluationStatus: verdict.status })
      .where(eq(otaAttempts.attemptId, id));
    if (c.recovery) {
      const terminal = ["SUCCEEDED", "FAILED", "UNCERTAIN"].includes(
        verdict.status,
      );
      if (terminal) {
        await appendAudit(tx, {
          action: "deployment.recovery_changed",
          targetKind: "deployment",
          targetId: c.target.deploymentId,
          system: "ota-worker",
          metadata: { afterStatus: verdict.status, reason: verdict.reason },
        });
        const receivedBytes = rows
          .filter(
            (r) => r.acceptance === "ACCEPTED" && r.payload.type === "PROGRESS",
          )
          .map((r) => Number(r.payload.downloadedBytes));
        await tx
          .update(otaRecoveries)
          .set({
            status: verdict.status,
            failureReason:
              verdict.status === "SUCCEEDED" ? null : verdict.reason,
            requiredAction:
              verdict.status === "SUCCEEDED"
                ? null
                : "INSPECT_BACKUP_OR_REPLACE_DEVICE",
            finishedAt: now,
            downloadedBytes:
              receivedBytes.length && c.recovery.bytesAtApproval !== null
                ? c.recovery.bytesAtApproval + Math.max(...receivedBytes)
                : null,
            evidence: [
              ...new Set([...c.recovery.evidence, ...verdict.evidence]),
            ],
          })
          .where(eq(otaRecoveries.recoveryId, c.recovery.recoveryId));
        await tx
          .update(otaDeployments)
          .set({
            status:
              verdict.status === "SUCCEEDED" && c.recovery.kind === "RETRY"
                ? "PAUSED"
                : "WAITING_FOR_HUMAN",
          })
          .where(eq(otaDeployments.deploymentId, c.target.deploymentId));
      }
    }
    await tx
      .update(otaTargets)
      .set({
        status:
          verdict.status === "SUCCEEDED"
            ? c.recovery?.kind === "ROLLBACK"
              ? "RECOVERED"
              : "SUCCEEDED"
            : verdict.status === "FAILED"
              ? "FAILED"
              : verdict.status === "UNCERTAIN"
                ? "WAITING_FOR_HUMAN"
                : "UPDATING",
      })
      .where(eq(otaTargets.targetId, c.target.targetId));
    if (["FAILED", "UNCERTAIN"].includes(verdict.status)) {
      const [stage] = await tx
        .select()
        .from(otaStages)
        .where(eq(otaStages.stageId, c.target.stageId));
      const failed = await tx
        .select({ id: otaTargets.targetId })
        .from(otaTargets)
        .where(
          and(
            eq(otaTargets.stageId, c.target.stageId),
            eq(otaTargets.status, "FAILED"),
          ),
        );
      const integrity = rows.some((r) =>
        [
          "INVALID_SIGNATURE",
          "UNTRUSTED_KEY",
          "DIGEST_MISMATCH",
          "SIZE_MISMATCH",
          "FENCE_CONFLICT",
          "CAPACITY_EXCEEDED",
        ].includes(String(r.payload.reason)),
      );
      if (
        verdict.status !== "UNCERTAIN" &&
        !integrity &&
        failed.length * 10 < stage!.deviceIds.length
      )
        return;
      // 解禁・publishは#171でこの同じdeployment lockとlatchを確認する。停止確認は捏造しない。
      await tx
        .update(otaStages)
        .set({ status: "STOPPING" })
        .where(eq(otaStages.stageId, c.target.stageId));
      await tx
        .update(otaDeployments)
        .set({ status: "WAITING_FOR_HUMAN" })
        .where(eq(otaDeployments.deploymentId, c.target.deploymentId));
    }
  }
  async function reject(
    tx: Tx,
    event: OtaEventMessage,
    payloadHash: string,
    reason: string,
    receivedAt: Date,
  ) {
    await tx
      .insert(otaRejections)
      .values({
        rejectionId: randomUUID(),
        eventId: event.eventId,
        attemptId: event.attemptId,
        deviceId: event.deviceId,
        payloadHash,
        payload: event,
        reason,
        receivedAt,
      })
      .onConflictDoNothing();
  }
  return {
    async ingest(
      input: OtaEventMessage,
      receivedAt: Date,
    ): Promise<OtaReceiptMessage | null> {
      const event = otaEventMessageSchema.parse(input),
        payloadHash = hash(serializeOtaEvent(event));
      return db.transaction(async (tx) => {
        // 正本eventIdとdeploymentの順で直列化。全経路で同じ順を使う。
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${"ota-event:" + event.eventId}, 0))`,
        );
        const c0 = await context(tx, event.attemptId);
        if (!c0) {
          await reject(tx, event, payloadHash, "UNKNOWN_ATTEMPT", receivedAt);
          return null;
        }
        await otaDeploymentLock(tx, c0.target.deploymentId);
        const c = (await context(tx, event.attemptId))!;
        const now = await clock(tx);
        const [original] = await tx
          .select()
          .from(otaEvents)
          .where(eq(otaEvents.eventId, event.eventId));
        if (original) {
          if (original.payloadHash === payloadHash)
            return original.receipt
              ? otaReceiptMessageSchema.parse(original.receipt)
              : null;
          // 別scopeからのeventId衝突で正当なtargetを変更しない。
          const reason =
            c.apply && scopeValid(event, c.apply)
              ? "EVENT_CONFLICT"
              : "SCOPE_MISMATCH";
          await reject(tx, event, payloadHash, reason, receivedAt);
          if (reason === "EVENT_CONFLICT")
            await evaluate(tx, event.attemptId, now);
          return null;
        }
        if (!c.apply || !scopeValid(event, c.apply)) {
          await reject(
            tx,
            event,
            payloadHash,
            c.apply ? "SCOPE_MISMATCH" : "UNRELEASED_ATTEMPT",
            receivedAt,
          );
          return null;
        }
        const [sameSequence] = await tx
          .select()
          .from(otaEvents)
          .where(
            and(
              eq(otaEvents.attemptId, event.attemptId),
              eq(otaEvents.sequence, BigInt(event.sequence)),
            ),
          );
        if (sameSequence) {
          await reject(tx, event, payloadHash, "EVENT_CONFLICT", receivedAt);
          await evaluate(tx, event.attemptId, now);
          return null;
        }
        let reason: string | null = !c.current
          ? "STALE_ATTEMPT"
          : otaEventContextError(event, c.apply);
        if (
          !reason &&
          event.type === "PROGRESS" &&
          event.requestType !== "APPLY_RELEASE"
        ) {
          const [stop] = await tx
            .select()
            .from(otaStops)
            .where(eq(otaStops.commandId, event.commandId));
          if (
            !stop ||
            stop.attemptId !== event.attemptId ||
            stop.attempts < 1 ||
            receivedAt < stop.createdAt ||
            receivedAt >= stop.resultDeadline ||
            now >= stop.resultDeadline
          )
            reason = "UNKNOWN_CONTROL_REQUEST";
        }
        if (
          !reason &&
          event.type === "PROGRESS" &&
          event.requestType === "APPLY_RELEASE" &&
          event.commandId !== c.apply.commandId
        )
          reason = "UNKNOWN_APPLY_REQUEST";
        if (!reason && (receivedAt < c.attempt.startedAt! || receivedAt > now))
          reason = "INVALID_SERVER_TIME";
        if (!reason && (event.type === "HEALTH" || event.type === "STATE")) {
          const [query] = await tx
            .select()
            .from(otaQueries)
            .where(eq(otaQueries.commandId, event.queryCommandId));
          if (
            !query ||
            query.attemptId !== event.attemptId ||
            query.attempts < 1 ||
            receivedAt < query.createdAt ||
            now >= query.expiresAt ||
            receivedAt >= query.expiresAt
          )
            reason = "INVALID_QUERY";
          else if (event.type === "HEALTH") {
            const [version] = await tx
              .select()
              .from(otaEvents)
              .where(
                and(
                  eq(otaEvents.attemptId, event.attemptId),
                  eq(otaEvents.acceptance, "ACCEPTED"),
                  sql`${otaEvents.payload}->>'type'='VERSION'`,
                ),
              )
              .orderBy(desc(otaEvents.sequence))
              .limit(1);
            const v = version
              ? otaEventMessageSchema.parse(version.payload)
              : null;
            if (
              query.challengeId !== event.challengeId ||
              query.consumedEventId
            )
              reason = "CHALLENGE_USED_OR_MISMATCH";
            else if (
              !v ||
              v.type !== "VERSION" ||
              query.expectedBootId !== event.running.bootId ||
              query.expectedSupervisorBootId !== event.supervisorBootId ||
              v.running.bootId !== event.running.bootId ||
              v.supervisorBootId !== event.supervisorBootId
            )
              reason = "BOOT_MISMATCH";
            else if (
              Date.parse(event.measuredAt) < query.createdAt.getTime() ||
              Date.parse(event.timestamp) > now.getTime() ||
              now.getTime() - Date.parse(event.measuredAt) >= 15000
            )
              reason = "STALE_SAMPLE";
            else
              await tx
                .update(otaQueries)
                .set({ consumedEventId: event.eventId })
                .where(eq(otaQueries.commandId, query.commandId));
          } else if (query.challengeId !== null || query.consumedEventId)
            reason = "INVALID_QUERY";
          else
            await tx
              .update(otaQueries)
              .set({ consumedEventId: event.eventId })
              .where(eq(otaQueries.commandId, query.commandId));
          if (
            event.type === "HEALTH" &&
            reason &&
            query &&
            query.attemptId === event.attemptId &&
            query.attempts > 0 &&
            query.challengeId === event.challengeId &&
            query.expectedBootId === event.running.bootId &&
            query.expectedSupervisorBootId === event.supervisorBootId &&
            Object.values(event.checks).includes("FAILED")
          )
            reason = "LATE_HEALTH_FAILURE";
        }
        const receipt = otaReceiptMessageSchema.parse({
          schemaVersion: 1,
          deviceId: event.deviceId,
          deploymentId: event.deploymentId,
          stageId: event.stageId,
          targetId: event.targetId,
          attemptId: event.attemptId,
          fence: event.fence,
          release: event.release,
          eventId: event.eventId,
          payloadHash,
          status: "STORED",
          receivedAt: receivedAt.toISOString(),
          storedAt: new Date(
            Math.max(now.getTime(), receivedAt.getTime()),
          ).toISOString(),
        });
        await tx.insert(otaEvents).values({
          eventId: event.eventId,
          attemptId: event.attemptId,
          sequence: BigInt(event.sequence),
          payloadHash,
          payload: event,
          occurredAt: new Date(event.timestamp),
          receivedAt,
          storedAt: now,
          acceptance: reason ? "REJECTED" : "ACCEPTED",
          reason,
          receipt,
        });
        if (
          !reason &&
          event.type === "STATE" &&
          event.state === "STOPPED" &&
          event.running
        ) {
          const [stop] = await tx
            .select()
            .from(otaStops)
            .where(eq(otaStops.attemptId, event.attemptId));
          if (
            stop &&
            !stop.confirmedEventId &&
            receivedAt < stop.resultDeadline &&
            now < stop.resultDeadline
          ) {
            const [confirmation] = await tx
              .select()
              .from(otaEvents)
              .where(
                and(
                  eq(otaEvents.attemptId, event.attemptId),
                  eq(otaEvents.acceptance, "ACCEPTED"),
                  sql`${otaEvents.payload}->>'type'='PROGRESS' AND ${otaEvents.payload}->>'requestType'='STOP_UPDATE' AND ${otaEvents.payload}->>'state'='STOPPED' AND ${otaEvents.payload}->>'commandId'=${stop.commandId} AND ${otaEvents.sequence}<${BigInt(event.sequence)}`,
                ),
              )
              .limit(1);
            if (confirmation)
              await tx
                .update(otaStops)
                .set({ confirmedEventId: event.eventId })
                .where(eq(otaStops.commandId, stop.commandId));
          }
        }
        if (c.current) {
          const acceptedProgress = await tx
            .select()
            .from(otaEvents)
            .where(
              and(
                eq(otaEvents.attemptId, event.attemptId),
                eq(otaEvents.acceptance, "ACCEPTED"),
                sql`${otaEvents.payload}->>'type'='PROGRESS'`,
              ),
            )
            .orderBy(desc(otaEvents.sequence));
          const terminal = acceptedProgress.find((r) =>
            ["FAILED", "UNCERTAIN", "APPLIED", "STOPPED"].includes(
              String(r.payload.state),
            ),
          );
          const ranks = [
            "RECEIVED",
            "DOWNLOADING",
            "VERIFIED",
            "QUIESCING",
            "SWITCHING",
            "BOOTING",
            "HEALTH_CHECKING",
            "APPLIED",
          ];
          const best =
            terminal ??
            [...acceptedProgress].sort(
              (a, b) =>
                ranks.indexOf(String(b.payload.state)) -
                ranks.indexOf(String(a.payload.state)),
            )[0];
          if (best) {
            await tx
              .update(otaAttempts)
              .set({
                deliveryStatus:
                  c.attempt.deliveryStatus === "EXPIRED"
                    ? "EXPIRED"
                    : "ACKNOWLEDGED",
                applicationStatus: String(best.payload.state),
              })
              .where(eq(otaAttempts.attemptId, event.attemptId));
            await tx
              .update(otaOutbox)
              .set({
                status:
                  c.attempt.deliveryStatus === "EXPIRED"
                    ? "EXPIRED"
                    : "ACKNOWLEDGED",
              })
              .where(eq(otaOutbox.commandId, c.attempt.commandId));
          }
          await evaluate(tx, event.attemptId, await clock(tx));
        }
        return receipt;
      });
    },
    async inventory(input: unknown, receivedAt: Date) {
      const event = otaInventoryMessageSchema.parse(input),
        payloadHash = hash(serializeOtaInventory(event));
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${"ota-inventory:" + event.deviceId}, 0))`,
        );
        const [original] = await tx
          .select()
          .from(otaInventories)
          .where(eq(otaInventories.eventId, event.eventId));
        if (original) {
          if (original.payloadHash === payloadHash)
            return otaInventoryReceiptSchema.parse(original.receipt);
          await tx
            .insert(otaRejections)
            .values({
              rejectionId: randomUUID(),
              eventId: event.eventId,
              attemptId: null,
              deviceId: event.deviceId,
              payloadHash,
              payload: event,
              reason: "INVENTORY_CONFLICT",
              receivedAt,
            })
            .onConflictDoNothing();
          return null;
        }
        const [duplicate] = await tx
          .select()
          .from(otaInventories)
          .where(
            and(
              eq(otaInventories.deviceId, event.deviceId),
              eq(otaInventories.sequence, BigInt(event.sequence)),
            ),
          );
        if (duplicate) {
          await tx
            .insert(otaRejections)
            .values({
              rejectionId: randomUUID(),
              eventId: event.eventId,
              attemptId: null,
              deviceId: event.deviceId,
              payloadHash,
              payload: event,
              reason: "INVENTORY_CONFLICT",
              receivedAt,
            })
            .onConflictDoNothing();
          return null;
        }
        const now = await clock(tx);
        const [release] = await tx
          .select()
          .from(releases)
          .where(eq(releases.releaseId, event.running.release.releaseId));
        const m = release?.envelope.manifest as
          | Record<string, unknown>
          | undefined;
        let reason =
          !m ||
          ["releaseId", "digest", "version", "buildId"].some(
            (k) =>
              m[k] !==
              event.running.release[k as keyof typeof event.running.release],
          ) ||
          m.application !== event.capabilities.application ||
          m.platform !== event.capabilities.platform
            ? "UNKNOWN_RELEASE"
            : now.getTime() - Date.parse(event.measuredAt) >= 15000 ||
                Date.parse(event.timestamp) > now.getTime() ||
                receivedAt > now
              ? "STALE_INVENTORY"
              : "ACCEPTED";
        const [device] = await tx
          .select()
          .from(devices)
          .where(eq(devices.deviceId, event.deviceId))
          .for("update");
        const [state] = await tx
          .select()
          .from(otaDeviceStates)
          .where(eq(otaDeviceStates.deviceId, event.deviceId));
        if (!device) reason = "UNKNOWN_DEVICE";
        if (
          state &&
          (BigInt(event.sequence) <= state.inventorySequence ||
            receivedAt <= state.observedAt)
        )
          reason = "STALE_INVENTORY";
        if (reason === "ACCEPTED")
          await tx
            .insert(otaDeviceStates)
            .values({
              deviceId: event.deviceId,
              observedAt: receivedAt,
              inventorySequence: BigInt(event.sequence),
              snapshot: {
                ...event.capabilities,
                ...event.running.release,
                bootId: event.running.bootId,
              },
            })
            .onConflictDoUpdate({
              target: otaDeviceStates.deviceId,
              set: {
                observedAt: receivedAt,
                inventorySequence: BigInt(event.sequence),
                snapshot: {
                  ...event.capabilities,
                  ...event.running.release,
                  bootId: event.running.bootId,
                },
              },
            });
        const receipt = otaInventoryReceiptSchema.parse({
          schemaVersion: 1,
          type: "INVENTORY",
          deviceId: event.deviceId,
          eventId: event.eventId,
          payloadHash,
          status: "STORED",
          receivedAt: receivedAt.toISOString(),
          storedAt: new Date(
            Math.max(now.getTime(), receivedAt.getTime()),
          ).toISOString(),
        });
        await tx.insert(otaInventories).values({
          eventId: event.eventId,
          deviceId: event.deviceId,
          sequence: BigInt(event.sequence),
          payloadHash,
          payload: event,
          reason,
          receipt,
          receivedAt,
        });
        return receipt;
      });
    },
    async tick() {
      const candidates = await db
        .select({
          id: otaAttempts.attemptId,
          deploymentId: otaTargets.deploymentId,
        })
        .from(otaAttempts)
        .innerJoin(otaTargets, eq(otaTargets.targetId, otaAttempts.targetId))
        .where(
          sql`${otaAttempts.startedAt} IS NOT NULL AND (${otaAttempts.evaluationStatus} IN ('PENDING','OBSERVING') OR ${otaAttempts.resultDeadline} > clock_timestamp() - interval '60 seconds' OR EXISTS(SELECT 1 FROM ota_stops s WHERE s.attempt_id=${otaAttempts.attemptId} AND s.result_deadline>clock_timestamp() AND s.confirmed_event_id IS NULL))`,
        )
        .orderBy(asc(otaAttempts.resultDeadline))
        .limit(1000);
      const sends: {
        commandId: string;
        topic: string;
        payload: string;
        expiresAt: Date;
      }[] = [];
      for (const candidate of candidates)
        await db.transaction(async (tx) => {
          await otaDeploymentLock(tx, candidate.deploymentId);
          const c = await context(tx, candidate.id);
          if (!c?.current || !c.apply) return;
          const now = await clock(tx);
          if (
            now >= c.attempt.expiresAt! &&
            ["PENDING", "SENT"].includes(c.attempt.deliveryStatus)
          ) {
            await tx
              .update(otaAttempts)
              .set({ deliveryStatus: "EXPIRED" })
              .where(eq(otaAttempts.attemptId, candidate.id));
            await tx
              .update(otaOutbox)
              .set({ status: "EXPIRED" })
              .where(eq(otaOutbox.commandId, c.attempt.commandId));
          }
          await evaluate(tx, candidate.id, now);
          const [stop] = await tx
            .select()
            .from(otaStops)
            .where(eq(otaStops.attemptId, candidate.id));
          if (
            now.getTime() >=
            Math.max(
              c.attempt.resultDeadline!.getTime() + 60000,
              stop?.resultDeadline.getTime() ?? 0,
            )
          )
            return;
          const queries = await tx
            .select()
            .from(otaQueries)
            .where(eq(otaQueries.attemptId, candidate.id))
            .orderBy(desc(otaQueries.createdAt));
          if (
            (stop
              ? queries.filter((q) => q.createdAt >= stop.createdAt).length < 12
              : queries.length < 144) &&
            (!queries[0] ||
              now.getTime() - queries[0].createdAt.getTime() >= 5000)
          ) {
            const [version] = await tx
              .select()
              .from(otaEvents)
              .where(
                and(
                  eq(otaEvents.attemptId, candidate.id),
                  eq(otaEvents.acceptance, "ACCEPTED"),
                  sql`${otaEvents.payload}->>'type'='VERSION'`,
                ),
              )
              .orderBy(desc(otaEvents.sequence))
              .limit(1);
            const v = version
              ? otaEventMessageSchema.parse(version.payload)
              : null;
            const commandId = randomUUID(),
              challengeId =
                !stop &&
                !["FAILED", "UNCERTAIN"].includes(c.attempt.evaluationStatus) &&
                v?.type === "VERSION"
                  ? randomUUID()
                  : null;
            const payload = otaRequestMessageSchema.parse({
              ...Object.fromEntries(
                Object.entries(c.apply).filter(
                  ([key]) => !["purpose", "recovery"].includes(key),
                ),
              ),
              type: "QUERY_STATE",
              commandId,
              applyCommandId: c.apply.commandId,
              challengeId,
              createdAt: now.toISOString(),
              expiresAt: new Date(now.getTime() + 15000).toISOString(),
              resultDeadline: new Date(now.getTime() + 15000).toISOString(),
            });
            // strict schemaへpurposeを渡さない。
            await tx.insert(otaQueries).values({
              commandId,
              attemptId: candidate.id,
              challengeId,
              expectedBootId: v?.type === "VERSION" ? v.running.bootId : null,
              expectedSupervisorBootId:
                v?.type === "VERSION" ? v.supervisorBootId : null,
              payload,
              createdAt: now,
              expiresAt: new Date(now.getTime() + 15000),
              nextAttemptAt: now,
            });
          }
          const due = await tx
            .select()
            .from(otaQueries)
            .where(
              and(
                eq(otaQueries.attemptId, candidate.id),
                sql`${otaQueries.expiresAt} > ${now.toISOString()} AND ${otaQueries.nextAttemptAt} <= ${now.toISOString()} AND ${otaQueries.attempts} < 5 AND ${otaQueries.consumedEventId} IS NULL`,
              ),
            );
          for (const q of due) {
            const cap = Math.min(8000, 1000 * 2 ** q.attempts);
            await tx
              .update(otaQueries)
              .set({
                attempts: q.attempts + 1,
                nextAttemptAt: new Date(
                  now.getTime() +
                    Math.floor(cap / 2 + (Math.random() * cap) / 2),
                ),
              })
              .where(eq(otaQueries.commandId, q.commandId));
            sends.push({
              commandId: q.commandId,
              topic: createOtaRequestsTopic(c.target.deviceId),
              payload: JSON.stringify(q.payload),
              expiresAt: q.expiresAt,
            });
          }
        });
      return sends;
    },
  };
}
