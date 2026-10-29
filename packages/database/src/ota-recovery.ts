import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  otaInventoryMessageSchema,
  otaEventMessageSchema,
  otaRequestMessageSchema,
  createOtaRequestsTopic,
} from "@drone-fleet/protocol";
import type { Database } from "./connection.js";
import { otaDeploymentLock } from "./ota.js";
import { OtaControlError } from "./ota-rollout.js";
import { appendAudit } from "./audit.js";
import {
  otaRecoveries,
  otaAttempts,
  otaTargets,
  otaDeployments,
  otaReservations,
  otaDeviceStates,
  otaInventories,
  otaEvents,
  otaEvaluations,
  otaOutbox,
  otaDispatches,
  releases,
} from "./schema.js";
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Recovery = typeof otaRecoveries.$inferSelect;
const MAX_BYTES = 268435456;
const deny = (reason: string): never => {
  throw new OtaControlError(409, reason);
};
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
async function view(tx: Tx, targetId: string) {
  const [t] = await tx
    .select()
    .from(otaTargets)
    .where(eq(otaTargets.targetId, targetId));
  if (!t) throw new OtaControlError(404, "TARGET_NOT_FOUND");
  const [d] = await tx
    .select()
    .from(otaDeployments)
    .where(eq(otaDeployments.deploymentId, t.deploymentId));
  const [a] = await tx
    .select()
    .from(otaAttempts)
    .where(eq(otaAttempts.targetId, targetId))
    .orderBy(desc(otaAttempts.ordinal))
    .limit(1);
  return { t, d: d!, a: a! };
}
async function gate(
  tx: Tx,
  targetId: string,
  previousId: string,
  expectedFence: bigint,
  kind: string,
  now: Date,
  expectedBoot?: string | null,
) {
  const c = await view(tx, targetId);
  const [p] = await tx
    .select()
    .from(otaAttempts)
    .where(eq(otaAttempts.attemptId, previousId));
  if (!p || p.targetId !== targetId || p.evaluationStatus !== "FAILED")
    deny("PREVIOUS_ATTEMPT_UNCONFIRMED");
  const [reservation] = await tx
    .select()
    .from(otaReservations)
    .where(eq(otaReservations.deviceId, c.t.deviceId));
  const [state] = await tx
    .select()
    .from(otaDeviceStates)
    .where(eq(otaDeviceStates.deviceId, c.t.deviceId));
  if (
    reservation?.targetId !== targetId ||
    state?.highestFence !== expectedFence
  )
    deny("FENCE_OR_RESERVATION_CONFLICT");
  const [inventory] = await tx
    .select()
    .from(otaInventories)
    .where(
      and(
        eq(otaInventories.deviceId, c.t.deviceId),
        eq(otaInventories.reason, "ACCEPTED"),
      ),
    )
    .orderBy(desc(otaInventories.sequence))
    .limit(1);
  const parsed = otaInventoryMessageSchema.safeParse(inventory?.payload);
  if (
    !inventory ||
    !parsed.success ||
    !parsed.data.recovery ||
    now < inventory.receivedAt ||
    now.getTime() - inventory.receivedAt.getTime() >= 15000 ||
    now < state!.observedAt ||
    now.getTime() - state!.observedAt.getTime() >= 15000
  )
    deny("RECOVERY_OBSERVATION_MISSING");
  const i = parsed.success ? parsed.data : null;
  if (
    !i ||
    i.recovery!.attemptId !== previousId ||
    i.running.bootId !== state!.snapshot.bootId ||
    (expectedBoot && i.running.bootId !== expectedBoot) ||
    !Object.entries(i.running.release).every(
      ([k, v]) => state!.snapshot[k] === v,
    )
  )
    deny("RECOVERY_BOOT_MISMATCH");
  if (!["FAILED", "STOPPED", "APPLIED"].includes(i!.recovery!.phase))
    deny("RESULT_UNKNOWN");
  const expectedRunning =
    kind === "RETRY"
      ? c.t.snapshot
      : (c.d.releaseSnapshot.manifest as Record<string, unknown>);
  if (
    !Object.entries(i!.running.release).every(
      ([k, v]) => expectedRunning[k] === v,
    )
  )
    deny("RECOVERY_RELEASE_MISMATCH");
  const [observedBytes] = await tx.execute<{ bytes: string }>(
    sql`SELECT COALESCE(sum(bytes),0)::text AS bytes FROM (SELECT max((e.payload->>'downloadedBytes')::bigint) AS bytes FROM ota_events e JOIN ota_attempts a USING(attempt_id) WHERE a.target_id=${targetId} AND e.acceptance='ACCEPTED' AND e.payload->>'type'='PROGRESS' GROUP BY e.attempt_id) totals`,
  );
  if (i!.recovery!.downloadedBytes < Number(observedBytes!.bytes))
    deny("RECOVERY_BUDGET_REGRESSION");
  const events = await tx
    .select()
    .from(otaEvents)
    .where(
      and(
        eq(otaEvents.attemptId, previousId),
        eq(otaEvents.acceptance, "ACCEPTED"),
      ),
    )
    .orderBy(desc(otaEvents.sequence));
  const facts = events.map((e) => ({
    ...e,
    event: otaEventMessageSchema.parse(e.payload),
  }));
  const terminal = facts.find((e) => e.event.type === "STATE");
  if (
    !terminal ||
    terminal.event.type !== "STATE" ||
    !["FAILED", "STOPPED", "APPLIED"].includes(terminal.event.state) ||
    !terminal.event.running ||
    terminal.event.running.bootId !== i!.running.bootId ||
    terminal.event.supervisorBootId !== i!.supervisorBootId ||
    !Object.entries(terminal.event.running.release).every(
      ([k, v]) =>
        i!.running.release[
          k as keyof NonNullable<typeof i>["running"]["release"]
        ] === v,
    )
  )
    deny("STOP_UNCONFIRMED");
  if (
    facts.some(
      (e) => e.event.type === "PROGRESS" && e.event.state === "UNCERTAIN",
    )
  )
    deny("RESULT_UNKNOWN");
  const readiness = i!.readiness;
  const required =
    kind === "RETRY"
      ? [
          "eventLoop",
          "telemetry",
          "sqlite",
          "commandReady",
          "mqtt",
          "subscriptions",
          "receipts",
        ]
      : ["eventLoop", "sqlite", "mqtt", "subscriptions", "receipts"];
  if (
    !readiness ||
    required.some((k) => readiness[k as keyof typeof readiness] !== "PASSED")
  )
    deny("HEALTH_UNCONFIRMED");
  if (kind === "RETRY") {
    const failure = facts.find(
      (e) =>
        e.event.type === "PROGRESS" &&
        e.event.requestType === "APPLY_RELEASE" &&
        e.event.state === "FAILED",
    );
    if (
      !failure ||
      failure.event.type !== "PROGRESS" ||
      failure.event.reason !== "DOWNLOAD_FAILED" ||
      facts.some(
        (e) =>
          e.event.type === "VERSION" ||
          (e.event.type === "PROGRESS" &&
            [
              "VERIFIED",
              "QUIESCING",
              "SWITCHING",
              "BOOTING",
              "HEALTH_CHECKING",
              "APPLIED",
            ].includes(e.event.state)),
      )
    )
      deny("RETRY_NOT_ALLOWLISTED");
  }
  return {
    ...c,
    p: p!,
    inventory: i!,
    evidence: [inventory!.eventId, terminal!.eventId],
    bytes: i!.recovery!.downloadedBytes,
  };
}
export function createOtaRecovery(
  db: Database,
  options: {
    clock?: () => Date;
    random?: () => number;
    validate?: (
      envelope: Record<string, unknown>,
      current: Record<string, unknown>,
      kind: string,
      currentEnvelope: Record<string, unknown>,
    ) => Promise<void>;
  } = {},
) {
  async function clock(tx: Tx) {
    if (options.clock) return options.clock();
    const [v] = await tx.execute<{ now: string }>(
      sql`SELECT clock_timestamp()::text AS now`,
    );
    return new Date(v!.now);
  }
  async function unavailable(tx: Tx, r: Recovery, now: Date, reason: string) {
    await tx
      .update(otaRecoveries)
      .set({
        status: "UNAVAILABLE",
        failureReason: reason,
        requiredAction: "INSPECT_BACKUP_OR_REPLACE_DEVICE",
        finishedAt: now,
      })
      .where(eq(otaRecoveries.recoveryId, r.recoveryId));
    await tx
      .update(otaDeployments)
      .set({ status: "WAITING_FOR_HUMAN" })
      .where(eq(otaDeployments.deploymentId, r.deploymentId));
    await tx
      .update(otaTargets)
      .set({ status: "WAITING_FOR_HUMAN" })
      .where(eq(otaTargets.targetId, r.targetId));
    await appendAudit(tx, {
      action: "deployment.recovery_changed",
      targetKind: "deployment",
      targetId: r.deploymentId,
      system: "ota-worker",
      metadata: { reason, afterStatus: "UNAVAILABLE" },
    });
  }
  return {
    async request(
      id: string,
      targetId: string,
      key: string,
      kind: "RETRY" | "ROLLBACK",
      reason: string,
    ) {
      const requestHash = digest(JSON.stringify({ targetId, kind, reason }));
      return db.transaction(async (tx) => {
        await otaDeploymentLock(tx, id);
        const c = await view(tx, targetId);
        if (c.t.deploymentId !== id)
          throw new OtaControlError(404, "TARGET_NOT_FOUND");
        const [replay] = await tx
          .select()
          .from(otaRecoveries)
          .where(
            and(eq(otaRecoveries.deploymentId, id), eq(otaRecoveries.key, key)),
          );
        if (replay) {
          if (replay.requestHash !== requestHash) deny("IDEMPOTENCY_CONFLICT");
          return replay.response;
        }
        const now = await clock(tx);
        const attempts = await tx
          .select()
          .from(otaAttempts)
          .where(eq(otaAttempts.targetId, targetId))
          .orderBy(asc(otaAttempts.ordinal));
        const root = attempts[0]!;
        const [failure] = await tx
          .select()
          .from(otaEvaluations)
          .where(
            and(
              eq(otaEvaluations.attemptId, root.attemptId),
              sql`${otaEvaluations.status} IN ('FAILED','UNCERTAIN')`,
            ),
          )
          .orderBy(asc(otaEvaluations.revision))
          .limit(1);
        let detectedAt = failure?.evaluatedAt ?? now,
          budgetDeadline = new Date(detectedAt.getTime() + 900000);
        let failureReason: string | null = null,
          releaseSnapshot: Record<string, unknown> | null = null,
          bytes: number | null = null,
          boot: string | null = null,
          evidence: string[] = [];
        const prior = await tx
          .select()
          .from(otaRecoveries)
          .where(eq(otaRecoveries.targetId, targetId));
        try {
          if (c.d.status !== "PAUSED") deny("DEPLOYMENT_NOT_PAUSED");
          if (!failure) deny("FAILURE_UNCONFIRMED");
          if (prior.some((r) => ["WAITING", "RUNNING"].includes(r.status)))
            deny("RECOVERY_ACTIVE");
          if (prior.some((r) => r.kind === kind && r.attemptId !== null))
            deny("RECOVERY_LIMIT_REACHED");
          if (
            prior.some(
              (r) =>
                r.kind === "ROLLBACK" &&
                ["FAILED", "UNCERTAIN"].includes(r.status),
            )
          )
            deny("RECOVERY_FAILED_NO_RECURSION");
          const g = await gate(
            tx,
            targetId,
            c.a.attemptId,
            c.a.fence,
            kind,
            now,
          );
          evidence = g.evidence;
          bytes = g.bytes;
          boot = g.inventory.running.bootId;
          const local = g.inventory.recovery!;
          if (
            !local.detectedAt ||
            !local.budgetDeadline ||
            Date.parse(local.budgetDeadline) - Date.parse(local.detectedAt) !==
              900000 ||
            Date.parse(local.detectedAt) > now.getTime()
          )
            deny("RECOVERY_TIME_UNCONFIRMED");
          detectedAt = new Date(
            Math.min(detectedAt.getTime(), Date.parse(local.detectedAt!)),
          );
          budgetDeadline = new Date(detectedAt.getTime() + 900000);
          if (kind === "RETRY") releaseSnapshot = c.d.releaseSnapshot;
          else {
            const good = g.inventory.recovery!.knownGood;
            if (
              good.releaseId !== c.t.snapshot.releaseId ||
              good.digest !== c.t.snapshot.digest ||
              good.releaseId === g.inventory.running.release.releaseId
            )
              deny("ROLLBACK_UNAVAILABLE");
            const [release] = await tx
              .select()
              .from(releases)
              .where(eq(releases.releaseId, good.releaseId));
            if (!release) deny("ROLLBACK_UNAVAILABLE");
            releaseSnapshot = release!.envelope;
            const manifest = releaseSnapshot!.manifest as Record<
              string,
              unknown
            >;
            if (
              !Object.entries(good).every(([k, v]) => manifest[k] === v) ||
              manifest.rollbackCompatible !== true
            )
              deny("ROLLBACK_UNAVAILABLE");
          }
          if (!options.validate) deny("RECOVERY_VALIDATOR_UNAVAILABLE");
          await options.validate!(
            releaseSnapshot!,
            {
              ...g.inventory.capabilities,
              ...g.inventory.running.release,
              bootId: boot,
            },
            kind,
            c.d.releaseSnapshot,
          );
          const size = Number(
            (releaseSnapshot!.manifest as Record<string, unknown>).size,
          );
          if (
            bytes! >= MAX_BYTES ||
            !Number.isSafeInteger(size) ||
            size < 1 ||
            bytes! + (kind === "RETRY" ? size + 16384 : 0) > MAX_BYTES
          )
            deny("DOWNLOAD_BUDGET_EXCEEDED");
          if (
            now.getTime() + 600000 + (kind === "RETRY" ? 60000 : 0) >
            budgetDeadline.getTime()
          )
            deny("RECOVERY_TIME_BUDGET_EXCEEDED");
          if (c.a.fence >= 9223372036854775807n) deny("FENCE_EXHAUSTED");
        } catch (error) {
          if (error instanceof OtaControlError) failureReason = error.reason;
          else
            failureReason =
              kind === "ROLLBACK"
                ? "ROLLBACK_UNAVAILABLE"
                : "RELEASE_UNAVAILABLE";
        }
        const recoveryId = randomUUID(),
          attemptId = failureReason ? null : randomUUID();
        const notBefore = new Date(
          now.getTime() +
            (kind === "RETRY"
              ? 30000 +
                Math.floor((options.random?.() ?? Math.random()) * 30000)
              : 0),
        );
        const response = {
          recoveryId,
          deploymentId: id,
          targetId,
          previousAttemptId: c.a.attemptId,
          attemptId,
          kind,
          status: failureReason ? "UNAVAILABLE" : "WAITING",
          failureReason,
          detectedAt: detectedAt.toISOString(),
          budgetDeadline: budgetDeadline.toISOString(),
          notBefore: notBefore.toISOString(),
        };
        if (attemptId) {
          const commandId = randomUUID(),
            fence = c.a.fence + 1n;
          await tx.insert(otaAttempts).values({
            attemptId,
            targetId,
            ordinal: c.a.ordinal + 1,
            commandId,
            fence,
            purpose: kind === "ROLLBACK" ? "ROLLBACK" : "APPLY",
            previousAttemptId: c.a.attemptId,
          });
          await tx
            .insert(otaOutbox)
            .values({ commandId, topic: createOtaRequestsTopic(c.t.deviceId) });
          await tx
            .update(otaDeviceStates)
            .set({ highestFence: fence })
            .where(eq(otaDeviceStates.deviceId, c.t.deviceId));
          await tx
            .update(otaTargets)
            .set({ status: "RECOVERING" })
            .where(eq(otaTargets.targetId, targetId));
        }
        await tx.insert(otaRecoveries).values({
          recoveryId,
          deploymentId: id,
          targetId,
          previousAttemptId: c.a.attemptId,
          rootAttemptId: root.attemptId,
          attemptId,
          kind,
          key,
          requestHash,
          reason,
          status: response.status,
          failureReason,
          requiredAction: failureReason
            ? "INSPECT_BACKUP_OR_REPLACE_DEVICE"
            : null,
          releaseSnapshot,
          previousBootId: boot,
          detectedAt,
          budgetDeadline,
          notBefore,
          approvedAt: now,
          finishedAt: failureReason ? now : null,
          bytesAtApproval: bytes,
          evidence,
          response,
        });
        if (
          failureReason &&
          ![
            "RECOVERY_ACTIVE",
            "DEPLOYMENT_NOT_PAUSED",
            "FAILURE_UNCONFIRMED",
          ].includes(failureReason)
        )
          await tx
            .update(otaDeployments)
            .set({ status: "WAITING_FOR_HUMAN" })
            .where(eq(otaDeployments.deploymentId, id));
        await appendAudit(tx, {
          action: "deployment.recovery_requested",
          targetKind: "deployment",
          targetId: id,
          result: failureReason ? "REJECTED" : "SUCCEEDED",
          metadata: {
            reason: failureReason ?? reason,
            afterStatus: response.status,
          },
        });
        return response;
      });
    },
    async tick() {
      const pending = await db
        .select()
        .from(otaRecoveries)
        .where(sql`${otaRecoveries.status} IN ('WAITING','RUNNING')`)
        .orderBy(asc(otaRecoveries.approvedAt));
      const sends: {
        deploymentId: string;
        commandId: string;
        topic: string;
        payload: string;
        expiresAt: Date;
        recoveryId: string;
      }[] = [];
      for (const r of pending)
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended('ota-dispatch',0))`,
          );
          await otaDeploymentLock(tx, r.deploymentId);
          const [fresh] = await tx
            .select()
            .from(otaRecoveries)
            .where(eq(otaRecoveries.recoveryId, r.recoveryId));
          if (!fresh || !["WAITING", "RUNNING"].includes(fresh.status)) return;
          const now = await clock(tx),
            c = await view(tx, r.targetId);
          if (now < r.notBefore) return;
          if (c.a.attemptId !== r.attemptId || c.d.status !== "PAUSED") {
            await unavailable(tx, fresh, now, "RECOVERY_STOPPED_OR_SUPERSEDED");
            return;
          }
          let [outbox] = await tx
            .select()
            .from(otaOutbox)
            .where(eq(otaOutbox.commandId, c.a.commandId));
          if (fresh.status === "WAITING") {
            try {
              const g = await gate(
                tx,
                r.targetId,
                r.previousAttemptId,
                c.a.fence,
                r.kind,
                now,
                r.previousBootId,
              );
              if (!options.validate) deny("RECOVERY_VALIDATOR_UNAVAILABLE");
              await options.validate!(
                r.releaseSnapshot!,
                {
                  ...g.inventory.capabilities,
                  ...g.inventory.running.release,
                  bootId: g.inventory.running.bootId,
                },
                r.kind,
                c.d.releaseSnapshot,
              );
              if (now.getTime() + 600000 > r.budgetDeadline.getTime())
                deny("RECOVERY_TIME_BUDGET_EXCEEDED");
              if (g.bytes >= MAX_BYTES) deny("DOWNLOAD_BUDGET_EXCEEDED");
            } catch (error) {
              await unavailable(
                tx,
                fresh,
                now,
                error instanceof OtaControlError
                  ? error.reason
                  : r.kind === "ROLLBACK"
                    ? "ROLLBACK_UNAVAILABLE"
                    : "RELEASE_UNAVAILABLE",
              );
              return;
            }
            const manifest = r.releaseSnapshot!.manifest as Record<
                string,
                unknown
              >,
              expiresAt = new Date(now.getTime() + 300000),
              resultDeadline = new Date(now.getTime() + 600000);
            const payload = otaRequestMessageSchema.parse({
              schemaVersion: 1,
              type: "APPLY_RELEASE",
              purpose: c.a.purpose,
              deviceId: c.t.deviceId,
              deploymentId: r.deploymentId,
              stageId: c.t.stageId,
              targetId: r.targetId,
              attemptId: c.a.attemptId,
              commandId: c.a.commandId,
              fence: c.a.fence.toString(),
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
              recovery: {
                recoveryId: r.recoveryId,
                previousAttemptId: r.previousAttemptId,
                rootAttemptId: r.rootAttemptId,
                kind: r.kind,
                detectedAt: r.detectedAt.toISOString(),
                budgetDeadline: r.budgetDeadline.toISOString(),
                maxDownloadBytes: MAX_BYTES,
              },
            });
            await tx
              .update(otaAttempts)
              .set({
                startedAt: now,
                expiresAt,
                resultDeadline,
                deliveryStatus: "PENDING",
              })
              .where(eq(otaAttempts.attemptId, c.a.attemptId));
            [outbox] = await tx
              .update(otaOutbox)
              .set({
                payload: JSON.stringify(payload),
                status: "PENDING",
                expiresAt,
                nextAttemptAt: now,
              })
              .where(eq(otaOutbox.commandId, c.a.commandId))
              .returning();
            await tx
              .update(otaRecoveries)
              .set({ status: "RUNNING", startedAt: now })
              .where(eq(otaRecoveries.recoveryId, r.recoveryId));
            await appendAudit(tx, {
              action: "deployment.recovery_changed",
              targetKind: "deployment",
              targetId: r.deploymentId,
              system: "ota-worker",
              metadata: { afterStatus: "RUNNING", reason: "APPROVED_RECOVERY" },
            });
          }
          if (now >= r.budgetDeadline) {
            await unavailable(tx, fresh, now, "RECOVERY_TIME_BUDGET_EXCEEDED");
            return;
          }
          if (
            !outbox ||
            !["PENDING", "SENT"].includes(outbox.status) ||
            now >= outbox.expiresAt! ||
            now < outbox.nextAttemptAt! ||
            outbox.attempts >= 5
          )
            return;
          const [last] = await tx
            .select()
            .from(otaDispatches)
            .orderBy(desc(otaDispatches.claimedAt))
            .limit(1);
          if (last && now.getTime() - last.claimedAt.getTime() < 1000) return;
          const [slots] = await tx.execute<{ n: number }>(
            sql`SELECT count(*)::int AS n FROM ota_dispatches d JOIN ota_attempts a USING(attempt_id) WHERE a.evaluation_status<>'SUCCEEDED' AND NOT EXISTS(SELECT 1 FROM ota_stops s WHERE s.attempt_id=a.attempt_id AND s.confirmed_event_id IS NOT NULL) AND NOT(a.evaluation_status='FAILED' AND EXISTS(SELECT 1 FROM ota_events e WHERE e.attempt_id=a.attempt_id AND e.acceptance='ACCEPTED' AND e.payload->>'type'='STATE' AND e.payload->>'state' IN ('FAILED','APPLIED') AND e.payload->'running'<>'null'::jsonb))`,
          );
          if (!outbox.attempts && slots!.n >= 2) return;
          const cap = Math.min(8000, 1000 * 2 ** outbox.attempts);
          await tx
            .update(otaOutbox)
            .set({
              status: "SENT",
              attempts: outbox.attempts + 1,
              nextAttemptAt: new Date(
                now.getTime() + Math.floor(cap / 2 + (Math.random() * cap) / 2),
              ),
            })
            .where(eq(otaOutbox.commandId, outbox.commandId));
          await tx
            .update(otaAttempts)
            .set({ deliveryStatus: "SENT" })
            .where(eq(otaAttempts.attemptId, c.a.attemptId));
          await tx
            .insert(otaDispatches)
            .values({ attemptId: c.a.attemptId, claimedAt: now })
            .onConflictDoUpdate({
              target: otaDispatches.attemptId,
              set: { claimedAt: now },
            });
          sends.push({
            deploymentId: r.deploymentId,
            recoveryId: r.recoveryId,
            commandId: c.a.commandId,
            topic: outbox.topic,
            payload: outbox.payload!,
            expiresAt: outbox.expiresAt!,
          });
        });
      return sends;
    },
    async deliver(
      send: {
        deploymentId: string;
        recoveryId: string;
        commandId: string;
        topic: string;
        payload: string;
        expiresAt: Date;
      },
      publish: (
        topic: string,
        payload: string,
        expiresAt: Date,
      ) => Promise<void>,
    ) {
      await db.transaction(async (tx) => {
        await otaDeploymentLock(tx, send.deploymentId);
        const [r] = await tx
          .select()
          .from(otaRecoveries)
          .where(eq(otaRecoveries.recoveryId, send.recoveryId));
        const now = await clock(tx);
        if (
          !r ||
          r.status !== "RUNNING" ||
          now >= send.expiresAt ||
          now >= r.budgetDeadline
        )
          return;
        const c = await view(tx, r.targetId);
        const [state] = await tx
          .select()
          .from(otaDeviceStates)
          .where(eq(otaDeviceStates.deviceId, c.t.deviceId));
        const [reservation] = await tx
          .select()
          .from(otaReservations)
          .where(eq(otaReservations.deviceId, c.t.deviceId));
        if (
          c.d.status !== "PAUSED" ||
          c.a.commandId !== send.commandId ||
          state?.highestFence !== c.a.fence ||
          reservation?.targetId !== r.targetId
        )
          return;
        await publish(send.topic, send.payload, send.expiresAt);
      });
    },
  };
}
