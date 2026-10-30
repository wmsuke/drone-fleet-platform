import { z } from "zod";
import { otaInventoryMessageSchema } from "@drone-fleet/protocol";
import { ApiError } from "./api.js";

export const uuid = z.uuid();
const time = z.iso.datetime();
const nullableTime = time.nullable();
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const object = z.record(z.string(), z.unknown());
const counts = z.record(z.string(), count);
export const reasonCode = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const identity = z.object({
  releaseId: uuid,
  version: z.string(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  buildId: z.string(),
});
const manifest = identity
  .extend({
    application: z.literal("simulator"),
    platform: z.enum(["linux-arm64", "linux-x64"]),
    size: count,
    rollbackCompatible: z.boolean(),
    stateSchemaRange: z.string(),
    nodeRange: z.string(),
    supervisorRange: z.string(),
    otaProtocolRange: z.string(),
  })
  .passthrough();
const envelope = z.object({ manifest }).passthrough();
export const releaseSchema = identity
  .omit({ buildId: true })
  .extend({
    envelope,
    verifiedAt: time,
    platform: z.string(),
    application: z.string(),
    verification: z.literal("VERIFIED"),
  })
  .refine(
    (r) =>
      r.releaseId === r.envelope.manifest.releaseId &&
      r.digest === r.envelope.manifest.digest &&
      r.version === r.envelope.manifest.version &&
      r.platform === r.envelope.manifest.platform,
    "release identity mismatch",
  );
export type Release = z.infer<typeof releaseSchema>;
const evidenceEvent = z.object({
  eventId: uuid,
  acceptance: z.string(),
  reason: z.string().nullable(),
  sequence: z.string().regex(/^\d+$/),
  storedAt: time,
  occurredAt: time,
  receivedAt: time,
  payload: object,
});
const evaluation = z.object({
  evaluationId: uuid,
  revision: count,
  status: z.string(),
  reason: z.string(),
  evaluatedAt: time,
  evidence: z.array(uuid),
});
export const attemptSchema = z.object({
  attemptId: uuid,
  commandId: uuid,
  ordinal: count,
  purpose: z.enum(["APPLY", "ROLLBACK"]),
  previousAttemptId: uuid.nullable(),
  fence: z.string().regex(/^\d+$/),
  deliveryStatus: z.string(),
  applicationStatus: z.string().nullable(),
  evaluationStatus: z.string(),
  startedAt: nullableTime,
  expiresAt: nullableTime,
  resultDeadline: nullableTime,
  freshHealth: z.boolean(),
  stop: z
    .object({
      commandId: uuid,
      attempts: count,
      confirmedEventId: uuid.nullable(),
      resultDeadline: time,
    })
    .nullable(),
  events: z.array(evidenceEvent),
  eventsTruncated: z.boolean(),
  evaluations: z.array(evaluation),
  rejections: z.array(
    z.object({ rejectionId: uuid, reason: z.string(), receivedAt: time }),
  ),
});
export const targetSchema = z.object({
  targetId: uuid,
  stageId: uuid,
  deviceId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  status: z.string(),
  snapshot: object,
  current: identity.extend({ bootId: uuid, observedAt: time }).nullable(),
  observation: z
    .object({ receivedAt: time, payload: otaInventoryMessageSchema })
    .nullable(),
  attempts: z.array(attemptSchema).min(1),
});
const stage = z.object({
  stageId: uuid,
  position: count,
  status: z.string(),
  deviceIds: z.array(z.string()),
  denominator: count,
  counts,
});
const cost = z
  .object({ amount: z.number().nonnegative(), currency: z.string() })
  .nullable();
export const recoverySchema = z.object({
  recoveryId: uuid,
  targetId: uuid,
  previousAttemptId: uuid,
  rootAttemptId: uuid,
  attemptId: uuid.nullable(),
  kind: z.enum(["RETRY", "ROLLBACK"]),
  status: z.string(),
  reason: z.string(),
  failureReason: z.string().nullable(),
  requiredAction: z.string().nullable(),
  detectedAt: time,
  approvedAt: time,
  notBefore: time,
  startedAt: nullableTime,
  finishedAt: nullableTime,
  budgetDeadline: time,
  bytesAtApproval: count.nullable(),
  downloadedBytes: count.nullable(),
  cost,
  evidence: z.array(uuid),
});
const summary = z.object({
  deploymentId: uuid,
  releaseId: uuid,
  status: z.enum([
    "ACCEPTED",
    "RUNNING",
    "STOPPING",
    "PAUSED",
    "WAITING_FOR_HUMAN",
    "COMPLETED",
    "FAILED",
    "CANCELLED",
  ]),
  targetCount: count,
  counts,
  createdAt: time,
});
export const deploymentSchema = summary
  .omit({ counts: true })
  .extend({
    evaluatedAt: time,
    releaseSnapshot: envelope,
    policy: object,
    stages: z.array(stage),
    targets: z.array(targetSchema),
    control: z
      .object({ stoppedAt: nullableTime, stopReason: z.string().nullable() })
      .nullable(),
    recoveries: z.array(recoverySchema),
    interventionSummary: z.object({
      recordedCount: count,
      requiredApprovalCount: count,
      faultResponseCount: count,
      openReviewCount: count,
      legacyOperationCount: count,
      excludesAutonomousCompletion: z.boolean(),
    }),
  })
  .superRefine((d, ctx) => {
    if (
      d.targets.length !== d.targetCount ||
      new Set(d.targets.map((t) => t.deviceId)).size !== d.targetCount ||
      new Set(d.stages.map((s) => s.stageId)).size !== d.stages.length ||
      d.targets.some((t) =>
        t.attempts.some(
          (a, index) =>
            index > 0 && a.ordinal >= t.attempts[index - 1]!.ordinal,
        ),
      ) ||
      new Set(d.targets.map((t) => t.targetId)).size !== d.targetCount ||
      d.stages.reduce((n, s) => n + s.denominator, 0) !== d.targetCount ||
      d.stages.some(
        (s) =>
          s.denominator !== s.deviceIds.length ||
          d.targets.some(
            (t) => t.stageId === s.stageId && !s.deviceIds.includes(t.deviceId),
          ) ||
          d.targets.filter((t) => t.stageId === s.stageId).length !==
            s.denominator,
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "incomplete deployment snapshot",
      });
  });
export type Deployment = z.infer<typeof deploymentSchema>;
export type Target = z.infer<typeof targetSchema>;
export type Attempt = z.infer<typeof attemptSchema>;
const intervention = z.object({
  interventionId: uuid,
  kind: z.string(),
  category: z.string(),
  reason: z.string(),
  actorKind: z.literal("anonymous"),
  actorId: z.null(),
  operationResult: z.string(),
  startedAt: time,
  finishedAt: nullableTime,
  durationMs: count.nullable(),
  durationSource: z.literal("OPERATOR_REPORTED").nullable(),
  cost,
  auditEventId: uuid,
  completionAuditEventId: uuid.nullable(),
  completionReason: z.string().nullable(),
  recoveryId: uuid.nullable(),
  resolutionRecoveryId: uuid.nullable(),
  scope: z.array(z.object({ targetId: uuid, attemptId: uuid })),
  recovery: object.nullable(),
});
export type Intervention = z.infer<typeof intervention>;
const deviceIds = z
  .array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/))
  .min(1)
  .max(100);
const create = z
  .object({
    releaseId: uuid,
    deviceIds: z.array(z.string()).max(100),
    groupIds: z.array(uuid).max(100),
    stages: z.array(z.object({ deviceIds }).strict()).min(1).max(10),
  })
  .strict();
const reason = z.object({ reason: reasonCode }).strict();
const completion = z
  .object({
    reason: reasonCode,
    outcome: z.enum(["KEEP_STOPPED", "ESCALATED", "RECOVERY_REQUESTED"]),
    recoveryId: uuid.optional(),
    durationMs: count.optional(),
  })
  .strict();
export const intentSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("CREATE"), body: create }).strict(),
  z
    .object({
      action: z.literal("APPROVE"),
      deploymentId: uuid,
      stageId: uuid,
      body: reason,
    })
    .strict(),
  z
    .object({
      action: z.enum(["STOP", "RESUME", "START_REVIEW"]),
      deploymentId: uuid,
      body: reason,
    })
    .strict(),
  z
    .object({
      action: z.enum(["RETRY", "ROLLBACK"]),
      deploymentId: uuid,
      targetId: uuid,
      body: reason,
    })
    .strict(),
  z
    .object({
      action: z.literal("COMPLETE_REVIEW"),
      deploymentId: uuid,
      interventionId: uuid,
      body: completion,
    })
    .strict(),
]);
export type Intent = z.infer<typeof intentSchema>;
export const pendingSchema = z
  .object({ version: z.literal(1), key: uuid, intent: intentSchema })
  .strict();
export type Pending = z.infer<typeof pendingSchema>;
export const actionLabels: Record<Intent["action"], string> = {
  CREATE: "配信受付",
  APPROVE: "段階承認",
  STOP: "配信停止",
  RESUME: "配信再開",
  RETRY: "再試行承認",
  ROLLBACK: "rollback承認",
  START_REVIEW: "判断対応開始",
  COMPLETE_REVIEW: "判断対応終了",
};
export class OtaError extends ApiError {
  constructor(
    status: number,
    public readonly code: string | null,
  ) {
    super(status);
  }
}
async function request(
  base: string,
  path: string,
  signal?: AbortSignal,
  pending?: Pending,
): Promise<unknown> {
  const response = await fetch(`${base}${path}`, {
    method: pending ? "POST" : "GET",
    headers: {
      Accept: "application/json",
      ...(pending
        ? { "Content-Type": "application/json", "Idempotency-Key": pending.key }
        : {}),
    },
    signal,
    ...(pending
      ? {
          body: JSON.stringify(
            pending.intent.action === "RETRY" ||
              pending.intent.action === "ROLLBACK"
              ? { ...pending.intent.body, kind: pending.intent.action }
              : pending.intent.body,
          ),
        }
      : {}),
  });
  const value: unknown = await response.json();
  if (!response.ok) {
    const denied = z
      .object({
        recoveryId: uuid,
        deploymentId: uuid,
        interventionId: uuid,
        targetId: uuid,
        kind: z.enum(["RETRY", "ROLLBACK"]),
        status: z.literal("UNAVAILABLE"),
        failureReason: reasonCode,
      })
      .safeParse(value);
    if (
      response.status === 409 &&
      pending &&
      (pending.intent.action === "RETRY" ||
        pending.intent.action === "ROLLBACK") &&
      denied.success &&
      denied.data.deploymentId === pending.intent.deploymentId &&
      denied.data.targetId === pending.intent.targetId &&
      denied.data.kind === pending.intent.action
    )
      return denied.data;
    const parsed = z.object({ error: reasonCode }).safeParse(value);
    throw new OtaError(
      response.status,
      parsed.success ? parsed.data.error : null,
    );
  }
  return value;
}
export const fetchReleases = async (base: string, signal?: AbortSignal) =>
  z
    .object({ items: z.array(releaseSchema), limit: count })
    .parse(await request(base, "/releases", signal));
export const fetchDeployments = async (
  base: string,
  before?: string,
  beforeId?: string,
  signal?: AbortSignal,
) =>
  z
    .object({
      items: z.array(summary),
      nextBefore: nullableTime,
      nextBeforeId: uuid.nullable(),
      limit: count,
    })
    .parse(
      await request(
        base,
        `/deployments?limit=20${before ? `&before=${encodeURIComponent(before)}` : ""}${beforeId ? `&beforeId=${uuid.parse(beforeId)}` : ""}`,
        signal,
      ),
    );
export const fetchDeployment = async (
  base: string,
  id: string,
  signal?: AbortSignal,
) => {
  const data = deploymentSchema.parse(
    await request(base, `/deployments/${uuid.parse(id)}?eventLimit=20`, signal),
  );
  if (data.deploymentId !== id) throw new TypeError("deployment ID mismatch");
  return data;
};
export const fetchInterventions = async (
  base: string,
  id: string,
  cursor?: { startedAt: string; interventionId: string },
  signal?: AbortSignal,
) =>
  z
    .object({
      items: z.array(intervention),
      nextCursor: z
        .object({ startedAt: time, interventionId: uuid })
        .nullable(),
      limit: count,
    })
    .parse(
      await request(
        base,
        `/deployments/${uuid.parse(id)}/interventions?limit=20${cursor ? `&before=${encodeURIComponent(cursor.startedAt)}&beforeId=${uuid.parse(cursor.interventionId)}` : ""}`,
        signal,
      ),
    );
export async function sendIntent(base: string, saved: Pending) {
  const pending = pendingSchema.parse(saved),
    i = pending.intent;
  const path =
    i.action === "CREATE"
      ? "/deployments"
      : `/deployments/${i.deploymentId}/${i.action === "APPROVE" ? `stages/${i.stageId}/approve` : i.action === "RETRY" || i.action === "ROLLBACK" ? `targets/${i.targetId}/recover` : i.action === "START_REVIEW" ? "interventions" : i.action === "COMPLETE_REVIEW" ? `interventions/${i.interventionId}/complete` : i.action.toLowerCase()}`;
  const data = z
    .object({
      deploymentId: uuid,
      status: z.string().optional(),
      interventionId: uuid.optional(),
      actionId: uuid.optional(),
      recoveryId: uuid.optional(),
      targetId: uuid.optional(),
      kind: z.enum(["RETRY", "ROLLBACK"]).optional(),
      failureReason: z.string().nullable().optional(),
      startedAt: time.optional(),
      finishedAt: time.optional(),
      outcome: z.string().optional(),
    })
    .parse(await request(base, path, undefined, pending));
  if (
    (i.action !== "CREATE" && data.deploymentId !== i.deploymentId) ||
    (i.action === "CREATE" && data.status !== "ACCEPTED") ||
    (i.action !== "CREATE" && !data.interventionId && !data.recoveryId)
  )
    throw new TypeError("acceptance response mismatch");
  if (
    (i.action === "RETRY" || i.action === "ROLLBACK") &&
    (data.targetId !== i.targetId ||
      data.kind !== i.action ||
      !data.recoveryId ||
      !data.interventionId ||
      !["WAITING", "UNAVAILABLE"].includes(data.status ?? ""))
  )
    throw new TypeError("recovery acceptance mismatch");
  if (
    ["APPROVE", "STOP", "RESUME"].includes(i.action) &&
    (!data.actionId ||
      !data.interventionId ||
      data.status !== (i.action === "STOP" ? "STOPPING" : "RUNNING"))
  )
    throw new TypeError("control acceptance mismatch");
  if (i.action === "START_REVIEW" && (!data.interventionId || !data.startedAt))
    throw new TypeError("review acceptance mismatch");
  if (
    i.action === "COMPLETE_REVIEW" &&
    (data.interventionId !== i.interventionId ||
      !data.finishedAt ||
      data.outcome !== i.body.outcome)
  )
    throw new TypeError("review completion mismatch");
  return data;
}
