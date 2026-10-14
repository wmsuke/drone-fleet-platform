import { z } from "zod";
import { commandResponseSchema, deviceIdSchema } from "./schema.js";
export const fleetOperationRequestSchema = z
  .object({
    groupId: z.uuid().transform((id) => id.toLowerCase()),
    type: z.enum(["RETURN_HOME", "REBOOT"]),
  })
  .strict();
export const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const fleetOperationResponseSchema = z.object({
  operationId: z.uuid(),
  groupId: z.uuid(),
  type: z.enum(["RETURN_HOME", "REBOOT"]),
  status: z.literal("ACCEPTED"),
  targetCount: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  resultDeadline: z.iso.datetime(),
});
export type FleetOperationRequest = z.infer<typeof fleetOperationRequestSchema>;
export type FleetOperationResponse = z.infer<
  typeof fleetOperationResponseSchema
>;

export const operationStatusSchema = z.enum([
  "ACCEPTED",
  "IN_PROGRESS",
  "COMPLETED",
  "PARTIALLY_FAILED",
  "FAILED",
]);
export const targetStatusSchema = z.enum([
  "PENDING",
  "SENT",
  "ACKNOWLEDGED",
  "RUNNING",
  "SUCCEEDED",
  "EXECUTION_FAILED",
  "DELIVERY_FAILED",
  "EXPIRED",
  "UNRESPONSIVE",
  "UNCERTAIN",
]);
const count = z.number().int().nonnegative();
export const operationCountsSchema = z.object({
  PENDING: count,
  SENT: count,
  ACKNOWLEDGED: count,
  RUNNING: count,
  SUCCEEDED: count,
  EXECUTION_FAILED: count,
  DELIVERY_FAILED: count,
  EXPIRED: count,
  UNRESPONSIVE: count,
  UNCERTAIN: count,
});
export const operationSummarySchema = fleetOperationResponseSchema.extend({
  groupName: z.string(),
  groupRevision: z.number().int().positive(),
  status: operationStatusSchema,
  counts: operationCountsSchema,
  succeededCount: count,
  unsuccessfulCount: count,
  inProgressCount: count,
  acknowledgedCount: count,
  updatedAt: z.iso.datetime(),
});
export const operationTargetSchema = z.object({
  deviceId: deviceIdSchema,
  commandId: z.uuid(),
  status: targetStatusSchema,
  commandStatus: commandResponseSchema.shape.status,
  executionStatus: z.enum([
    "NOT_REPORTED",
    "RUNNING",
    "SUCCEEDED",
    "FAILED",
    "UNCERTAIN",
  ]),
  outboxState: z
    .enum([
      "PENDING",
      "WAITING_ACK",
      "ACKNOWLEDGED",
      "FAILED",
      "EXPIRED",
      "TIMED_OUT",
    ])
    .nullable(),
  attempts: count,
  failures: count,
  sentAt: z.iso.datetime().nullable(),
  acknowledgementReceivedAt: z.iso.datetime().nullable(),
  executionStartedAt: z.iso.datetime().nullable(),
  executionStartedReceivedAt: z.iso.datetime().nullable(),
  executionResultAt: z.iso.datetime().nullable(),
  executionResultReceivedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
});
const limitSchema = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .pipe(z.number().int().max(100));
const offsetSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .transform(Number)
  .pipe(z.number().int().max(1_000_000));
export const operationListQuerySchema = z
  .object({
    limit: limitSchema.default(20),
    offset: offsetSchema.default(0),
    groupId: z
      .uuid()
      .transform((id) => id.toLowerCase())
      .optional(),
    type: fleetOperationRequestSchema.shape.type.optional(),
    status: operationStatusSchema.optional(),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
  })
  .strict()
  .refine((v) => !v.from || !v.to || Date.parse(v.from) <= Date.parse(v.to), {
    message: "from must not exceed to",
  });
export const operationTargetQuerySchema = z
  .object({
    limit: limitSchema.default(100),
    offset: offsetSchema.default(0),
    status: targetStatusSchema.optional(),
    deviceId: deviceIdSchema.optional(),
  })
  .strict();
const pagination = { total: count, limit: count, offset: count };
export const operationListResponseSchema = z.object({
  items: z.array(operationSummarySchema),
  ...pagination,
  evaluatedAt: z.iso.datetime(),
});
export const operationDetailResponseSchema = operationSummarySchema.extend({
  targets: z.object({ items: z.array(operationTargetSchema), ...pagination }),
  evaluatedAt: z.iso.datetime(),
});
export type OperationListQuery = z.infer<typeof operationListQuerySchema>;
export type OperationTargetQuery = z.infer<typeof operationTargetQuerySchema>;
export type OperationListResponse = z.infer<typeof operationListResponseSchema>;
export type OperationDetailResponse = z.infer<
  typeof operationDetailResponseSchema
>;
