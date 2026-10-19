import { z } from "zod";
import { deviceIdSchema } from "./schema.js";

export const alertQuerySchema = z
  .object({
    status: z.enum(["ACTIVE", "RESOLVED"]).optional(),
    severity: z.literal("warning").optional(),
    kind: z.enum(["OFFLINE", "LOW_BATTERY", "COMMAND_OUTCOME"]).optional(),
    acknowledged: z.enum(["true", "false"]).optional(),
    deviceId: deviceIdSchema.optional(),
    groupId: z.uuid().optional(),
    operationId: z.uuid().optional(),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
    limit: z
      .string()
      .regex(/^\d+$/)
      .transform(Number)
      .pipe(z.number().int().min(1).max(100))
      .default(20),
    offset: z
      .string()
      .regex(/^\d+$/)
      .transform(Number)
      .pipe(z.number().int().min(0).max(1000000))
      .default(0),
  })
  .strict()
  .refine(
    (v) => !v.from || !v.to || Date.parse(v.from) <= Date.parse(v.to),
    "期間が不正です",
  );
export type AlertQuery = z.infer<typeof alertQuerySchema>;
export const alertSchema = z.object({
  alertId: z.uuid(),
  deviceId: deviceIdSchema,
  commandId: z.uuid().nullable(),
  kind: z.enum(["OFFLINE", "LOW_BATTERY", "COMMAND_OUTCOME"]),
  status: z.enum(["ACTIVE", "RESOLVED"]),
  severity: z.literal("warning"),
  reason: z.string(),
  occurredAt: z.iso.datetime(),
  lastObservedAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),
  acknowledgedAt: z.iso.datetime().nullable(),
  acknowledgedActorKind: z.string().nullable(),
  acknowledgedActorId: z.string().nullable(),
  ruleVersion: z.string(),
  parameters: z.record(z.string(), z.number()),
  evidence: z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
  relatedGroups: z.array(z.object({ groupId: z.uuid(), name: z.string() })),
  operationId: z.uuid().nullable(),
});
export type Alert = z.infer<typeof alertSchema>;
export const alertListSchema = z.object({
  items: z.array(alertSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int(),
  offset: z.number().int(),
});
