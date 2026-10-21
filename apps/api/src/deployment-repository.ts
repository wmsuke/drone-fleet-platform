import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  appendAudit,
  devices,
  groups,
  groupMemberships,
  releases,
  otaDeviceStates,
  otaDeployments,
  otaStages,
  otaTargets,
  otaReservations,
  otaAttempts,
  otaOutbox,
  type Database,
} from "@drone-fleet/database";
import {
  canonical,
  envelopeSchema,
  compatibleUpgrade,
  parseTrustStore,
  verifyEnvelope,
  artifactRoot,
  verifyStoredArtifact,
} from "@drone-fleet/releases";
import { createOtaRequestsTopic } from "@drone-fleet/protocol";
import {
  assignStages,
  deploymentPolicy,
  deploymentRequestSchema,
  deploymentResponseSchema,
  otaDeviceSnapshotSchema,
  type DeploymentRequest,
} from "./deployment-schema.js";

export class DeploymentError extends Error {
  constructor(
    public readonly status: 400 | 404 | 409 | 429 | 503,
    public readonly reason: string,
  ) {
    super(reason);
  }
}
export interface DeploymentOptions {
  directory: string;
  trustStorePath: string;
}
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

async function present(
  tx: Transaction,
  row: typeof otaDeployments.$inferSelect,
) {
  const stages = await tx
    .select()
    .from(otaStages)
    .where(eq(otaStages.deploymentId, row.deploymentId))
    .orderBy(asc(otaStages.position));
  // 受付応答は不変の受付事実。進行後の状態をACCEPTEDへ書き戻すものではない。
  return deploymentResponseSchema.parse({
    deploymentId: row.deploymentId,
    status: "ACCEPTED",
    targetCount: row.targetCount,
    createdAt: row.createdAt.toISOString(),
    release: row.releaseSnapshot,
    policy: row.policy,
    stages: stages.map((s) => ({
      stageId: s.stageId,
      position: s.position,
      status: s.position === 0 ? "AWAITING_APPROVAL" : "PENDING",
      deviceIds: s.deviceIds,
    })),
  });
}

export function createDeploymentRepository(
  db: Database,
  options: DeploymentOptions,
) {
  return {
    async create(input: DeploymentRequest, key: string) {
      const request = deploymentRequestSchema.parse(input);
      const requestHash = createHash("sha256")
        .update(canonical(request))
        .digest("hex");
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${"ota:anonymous:" + key}, 0))`,
        );
        const [existing] = await tx
          .select()
          .from(otaDeployments)
          .where(
            and(
              eq(otaDeployments.idempotencyScope, "anonymous"),
              eq(otaDeployments.idempotencyKey, key),
            ),
          );
        if (existing) {
          if (
            existing.requestHash !== requestHash ||
            canonical(existing.request) !== canonical(request)
          )
            throw new DeploymentError(409, "IDEMPOTENCY_CONFLICT");
          await appendAudit(tx, {
            action: "deployment.replayed",
            targetKind: "deployment",
            targetId: existing.deploymentId,
            metadata: { targetCount: existing.targetCount },
          });
          return present(tx, existing);
        }
        // 新規要求のみ全API replica間で1秒に1件。同keyの再送は制限しない。
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended('ota:admission', 0))`,
        );
        const [time] = await tx.execute<{ limited: boolean }>(
          sql`SELECT EXISTS(SELECT 1 FROM ota_deployments WHERE created_at > clock_timestamp() - interval '1 second') AS limited`,
        );
        if (!time || time.limited)
          throw new DeploymentError(429, "DEPLOYMENT_RATE_LIMITED");
        const selected = [...request.deviceIds];
        const groupSnapshots: {
          groupId: string;
          revision: number;
          deviceIds: string[];
        }[] = [];
        for (const groupId of request.groupIds) {
          const [group] = await tx
            .select()
            .from(groups)
            .where(eq(groups.groupId, groupId))
            .for("update");
          if (!group || group.deletedAt)
            throw new DeploymentError(404, "GROUP_NOT_FOUND");
          const members = await tx
            .select({ deviceId: groupMemberships.deviceId })
            .from(groupMemberships)
            .where(eq(groupMemberships.groupId, groupId))
            .orderBy(asc(groupMemberships.deviceId))
            .limit(101);
          if (!members.length) throw new DeploymentError(400, "EMPTY_TARGETS");
          selected.push(...members.map((m) => m.deviceId));
          groupSnapshots.push({
            groupId,
            revision: group.revision,
            deviceIds: members.map((m) => m.deviceId),
          });
        }
        if (selected.length > 100)
          throw new DeploymentError(400, "TARGET_LIMIT_EXCEEDED");
        if (!selected.length) throw new DeploymentError(400, "EMPTY_TARGETS");
        if (new Set(selected).size !== selected.length)
          throw new DeploymentError(400, "DUPLICATE_TARGETS");
        selected.sort();
        let stageMembers: string[][];
        try {
          stageMembers = assignStages(selected, request.stages);
        } catch {
          throw new DeploymentError(400, "INVALID_STAGES");
        }
        // command受付と同じdevice row lock。複数機体はASCII順で取得する。
        const locked = await tx
          .select({ deviceId: devices.deviceId })
          .from(devices)
          .where(inArray(devices.deviceId, selected))
          .orderBy(asc(devices.deviceId))
          .for("update");
        if (locked.length !== selected.length)
          throw new DeploymentError(404, "DEVICE_NOT_FOUND");
        if (
          (
            await tx
              .select()
              .from(otaReservations)
              .where(inArray(otaReservations.deviceId, selected))
              .limit(1)
          ).length
        )
          throw new DeploymentError(409, "DEVICE_RESERVED");
        const [release] = await tx
          .select()
          .from(releases)
          .where(eq(releases.releaseId, request.releaseId));
        if (!release) throw new DeploymentError(404, "RELEASE_NOT_FOUND");
        const envelope = envelopeSchema.parse(release.envelope);
        // 受付時にも現在の信頼根・objectを検証する。replayは元snapshotを返すだけ。
        try {
          verifyEnvelope(
            envelope,
            parseTrustStore(await readFile(options.trustStorePath, "utf8")),
          );
          await verifyStoredArtifact(
            await artifactRoot(options.directory),
            envelope.manifest,
          );
        } catch {
          throw new DeploymentError(409, "RELEASE_UNAVAILABLE");
        }
        const states = await tx
          .select()
          .from(otaDeviceStates)
          .where(inArray(otaDeviceStates.deviceId, selected))
          .for("update");
        const [admissionTime] = await tx.execute<{ now: string }>(
          sql`SELECT clock_timestamp()::text AS now`,
        );
        const createdAt = new Date(admissionTime!.now);
        const snapshots = new Map<string, Record<string, unknown>>();
        for (const deviceId of selected) {
          const state = states.find((s) => s.deviceId === deviceId);
          const parsed = otaDeviceSnapshotSchema.safeParse(state?.snapshot);
          if (
            !state ||
            !parsed.success ||
            state.observedAt > createdAt ||
            createdAt.getTime() - state.observedAt.getTime() >= 15000 ||
            state.highestFence >= 9223372036854775807n
          )
            throw new DeploymentError(409, "DEVICE_OTA_UNCONFIRMED");
          const current = parsed.data;
          const [previous] = await tx
            .select()
            .from(releases)
            .where(eq(releases.releaseId, current.releaseId));
          const previousEnvelope = envelopeSchema.safeParse(previous?.envelope);
          if (
            !previousEnvelope.success ||
            previousEnvelope.data.manifest.digest !== current.digest ||
            previousEnvelope.data.manifest.version !== current.version ||
            previousEnvelope.data.manifest.buildId !== current.buildId ||
            previousEnvelope.data.manifest.application !==
              current.application ||
            previousEnvelope.data.manifest.platform !== current.platform ||
            !compatibleUpgrade(envelope.manifest, current)
          )
            throw new DeploymentError(409, "INCOMPATIBLE_DEVICE");
          snapshots.set(deviceId, {
            ...current,
            observedAt: state.observedAt.toISOString(),
          });
        }
        const deploymentId = randomUUID();
        const [deployment] = await tx
          .insert(otaDeployments)
          .values({
            deploymentId,
            idempotencyScope: "anonymous",
            idempotencyKey: key,
            requestHash,
            request,
            releaseId: release.releaseId,
            releaseSnapshot: envelope,
            policy: { ...deploymentPolicy, groups: groupSnapshots },
            targetCount: selected.length,
            createdAt,
          })
          .returning();
        if (!deployment) throw new Error("deployment insert failed");
        for (const [position, deviceIds] of stageMembers.entries()) {
          const stageId = randomUUID();
          await tx.insert(otaStages).values({
            stageId,
            deploymentId,
            position,
            status: position === 0 ? "AWAITING_APPROVAL" : "PENDING",
            deviceIds,
          });
          for (const deviceId of deviceIds) {
            const targetId = randomUUID(),
              attemptId = randomUUID(),
              commandId = randomUUID();
            const state = states.find((s) => s.deviceId === deviceId)!;
            const fence = state.highestFence + 1n;
            await tx.insert(otaTargets).values({
              targetId,
              deploymentId,
              stageId,
              deviceId,
              snapshot: snapshots.get(deviceId)!,
            });
            await tx.insert(otaReservations).values({ deviceId, targetId });
            await tx
              .insert(otaAttempts)
              .values({ attemptId, targetId, commandId, fence });
            await tx
              .insert(otaOutbox)
              .values({ commandId, topic: createOtaRequestsTopic(deviceId) });
            await tx
              .update(otaDeviceStates)
              .set({ highestFence: fence })
              .where(eq(otaDeviceStates.deviceId, deviceId));
          }
        }
        await appendAudit(tx, {
          action: "deployment.accepted",
          targetKind: "deployment",
          targetId: deploymentId,
          metadata: { targetCount: selected.length, afterStatus: "ACCEPTED" },
        });
        return present(tx, deployment);
      });
    },
  };
}
export type DeploymentRepository = ReturnType<
  typeof createDeploymentRepository
>;
