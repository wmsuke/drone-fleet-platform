import { z } from "zod";
import { deviceIdSchema } from "./schema.js";

const uuid = z.uuid().transform((v) => v.toLowerCase());
const ids = z.array(deviceIdSchema).min(1).max(100);
export const deploymentPolicy = {
  evaluationVersion: "ota-health-v1",
  health: {
    startupSeconds: 30,
    intervalSeconds: 5,
    samples: 13,
    durationSeconds: 60,
    maxGapSeconds: 10,
    freshnessSeconds: 15,
  },
  stop: {
    failureRate: 0.1,
    uncertain: "IMMEDIATE",
    integrityFailure: "IMMEDIATE",
    latched: true,
  },
  recovery: {
    automatic: false,
    rollback: "EXPLICIT_APPROVAL",
    maxAttempts: 1,
    budgetSeconds: 900,
    maxDownloadBytes: 268435456,
  },
  startDeadlineSeconds: 300,
  resultDeadlineSeconds: 600,
  maxConcurrentApplications: 2,
  approvalRequired: true,
} as const;
// 初期仕様を弱める入力は受け付けない。省略時も同じ正規化本文になる。
export const deploymentRequestSchema = z
  .object({
    releaseId: uuid,
    deviceIds: z.array(deviceIdSchema).max(100).default([]),
    groupIds: z.array(uuid).max(100).default([]),
    stages: z
      .array(z.object({ deviceIds: ids }).strict())
      .min(1)
      .max(10)
      .optional(),
    evaluationVersion: z.literal("ota-health-v1").default("ota-health-v1"),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.deviceIds.length && !v.groupIds.length)
      ctx.addIssue({ code: "custom", message: "対象が必要です" });
    if (
      new Set(v.deviceIds).size !== v.deviceIds.length ||
      new Set(v.groupIds).size !== v.groupIds.length
    )
      ctx.addIssue({ code: "custom", message: "対象が重複しています" });
  })
  .transform((v) => ({
    ...v,
    deviceIds: [...v.deviceIds].sort(),
    groupIds: [...v.groupIds].sort(),
    ...(v.stages
      ? {
          stages: v.stages.map((s) => ({ deviceIds: [...s.deviceIds].sort() })),
        }
      : {}),
  }));
export type DeploymentRequest = z.infer<typeof deploymentRequestSchema>;

export function assignStages(
  targets: string[],
  requested?: DeploymentRequest["stages"],
) {
  if (requested) {
    const flat = requested.flatMap((s) => s.deviceIds);
    // stage順と各stage内のASCII順を含め、全対象を過不足なく1回ずつ割り当てる。
    if (JSON.stringify(flat) !== JSON.stringify(targets))
      throw new Error("INVALID_STAGES");
    return requested.map((s) => s.deviceIds);
  }
  return [targets.slice(0, 1), targets.slice(1, 4), targets.slice(4)].filter(
    (s) => s.length,
  );
}
const version = z.string().max(64);
export const otaDeviceSnapshotSchema = z
  .object({
    application: z.literal("simulator"),
    platform: z.enum(["linux-arm64", "linux-x64"]),
    nodeVersion: version,
    otaProtocolVersion: version,
    supervisorVersion: version,
    stateSchemaVersion: version,
    releaseId: uuid,
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    version,
    buildId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/),
    bootId: uuid,
    healthContractVersion: z.literal("ota-health-v1"),
  })
  .strict();
export const deploymentResponseSchema = z.object({
  deploymentId: uuid,
  status: z.literal("ACCEPTED"),
  targetCount: z.number().int().min(1).max(100),
  createdAt: z.iso.datetime(),
  release: z.record(z.string(), z.unknown()),
  policy: z.record(z.string(), z.unknown()),
  stages: z.array(
    z.object({
      stageId: uuid,
      position: z.number().int(),
      status: z.enum(["AWAITING_APPROVAL", "PENDING"]),
      deviceIds: ids,
    }),
  ),
});
export type DeploymentResponse = z.infer<typeof deploymentResponseSchema>;
