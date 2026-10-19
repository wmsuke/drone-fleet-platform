import { z } from "zod";
import type { AuditEvent } from "@drone-fleet/database";
type AuditAction = AuditEvent["action"];
import { deviceIdSchema } from "./schema.js";
export const auditActions = [
  "group.created",
  "group.updated",
  "group.deleted",
  "membership.added",
  "membership.removed",
  "command.accepted",
  "operation.accepted",
  "operation.replayed",
  "alert.acknowledged",
  "command.acknowledged",
  "command.expired",
  "command.execution_changed",
  "command.conflict",
  "alert.raised",
  "alert.resolved",
  "alert.reason_changed",
  "operation.status_changed",
] as const satisfies readonly AuditAction[];
const uuid = z.uuid().transform((v) => v.toLowerCase());
const targetId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const code = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const timestamp = z.iso
  .datetime()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/);
const precise = (value: string) =>
  value.replace(
    /(?:\.(\d+))?Z$/,
    (_match, fraction: string | undefined) =>
      `.${(fraction ?? "").padEnd(6, "0")}Z`,
  );
export const publicMetadataSchema = z
  .object({
    beforeName: z.string().max(100),
    afterName: z.string().max(100),
    descriptionChanged: z.boolean(),
    memberDeviceId: deviceIdSchema,
    commandType: z.enum(["REBOOT", "RETURN_HOME"]),
    targetCount: z.number().int().nonnegative(),
    beforeStatus: code.nullable(),
    afterStatus: code,
    beforeReason: code,
    reason: code,
    statusCode: z.number().int().min(400).max(599),
  })
  .partial()
  .strict();
type Metadata = z.infer<typeof publicMetadataSchema>;
const allowed: Record<AuditAction, readonly (keyof Metadata)[]> = {
  "group.created": ["afterName"],
  "group.updated": ["beforeName", "afterName", "descriptionChanged"],
  "group.deleted": [],
  "membership.added": ["memberDeviceId"],
  "membership.removed": ["memberDeviceId"],
  "command.accepted": ["commandType"],
  "operation.accepted": ["commandType", "targetCount", "afterStatus"],
  "operation.replayed": ["commandType", "targetCount"],
  "alert.acknowledged": [],
  "command.acknowledged": ["beforeStatus", "afterStatus"],
  "command.expired": ["beforeStatus", "afterStatus"],
  "command.execution_changed": ["beforeStatus", "afterStatus"],
  "command.conflict": ["reason", "beforeStatus", "afterStatus"],
  "alert.raised": ["afterStatus", "reason"],
  "alert.resolved": ["beforeStatus", "afterStatus", "reason"],
  "alert.reason_changed": ["beforeReason", "reason"],
  "operation.status_changed": ["beforeStatus", "afterStatus"],
};
export function publicMetadata(
  action: AuditAction,
  result: string,
  input: Record<string, unknown>,
): Metadata {
  const keys =
    result === "SUCCEEDED" || action === "command.conflict"
      ? allowed[action]
      : (["statusCode", "reason"] as const);
  const projected: Record<string, unknown> = {};
  for (const key of keys) {
    const parsed = publicMetadataSchema.shape[key].safeParse(input[key]);
    if (parsed.success && parsed.data !== undefined)
      projected[key] = parsed.data;
  }
  return publicMetadataSchema.parse(projected);
}
export const auditQuerySchema = z
  .object({
    from: timestamp.optional(),
    to: timestamp.optional(),
    actorKind: z.enum(["anonymous", "system"]).optional(),
    actorId: z
      .enum(["telemetry-ingestor", "alert-evaluator", "operation-evaluator"])
      .optional(),
    action: z.enum(auditActions).optional(),
    targetKind: z
      .enum(["group", "device", "command", "operation", "alert"])
      .optional(),
    targetId: targetId.optional(),
    result: z.enum(["SUCCEEDED", "REJECTED", "FAILED"]).optional(),
    requestId: uuid.optional(),
    groupId: uuid.optional(),
    operationId: uuid.optional(),
    commandId: uuid.optional(),
    alertId: uuid.optional(),
    limit: z
      .string()
      .regex(/^\d+$/)
      .transform(Number)
      .pipe(z.number().int().min(1).max(100))
      .default(20),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict()
  .refine(
    (v) => !v.from || !v.to || precise(v.from) <= precise(v.to),
    "期間が不正です",
  );
export type AuditQuery = z.infer<typeof auditQuerySchema>;
const cursorSchema = z
  .object({ time: z.iso.datetime({ precision: 6 }), id: uuid })
  .strict();
export function decodeAuditCursor(value: string) {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
    return cursorSchema.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
  } catch {
    return null;
  }
}
export function encodeAuditCursor(time: string, id: string) {
  return Buffer.from(JSON.stringify(cursorSchema.parse({ time, id }))).toString(
    "base64url",
  );
}
export const auditItemSchema = z.object({
  eventId: z.uuid(),
  schemaVersion: z.literal(1),
  occurredAt: z.iso.datetime({ precision: 6 }),
  actorKind: z.enum(["anonymous", "system"]),
  actorId: z.string().nullable(),
  action: z.enum(auditActions),
  targetKind: z.enum(["group", "device", "command", "operation", "alert"]),
  targetId: targetId.nullable(),
  result: z.enum(["SUCCEEDED", "REJECTED", "FAILED"]),
  requestId: z.uuid().nullable(),
  groupId: z.uuid().nullable(),
  operationId: z.uuid().nullable(),
  commandId: z.uuid().nullable(),
  alertId: z.uuid().nullable(),
  deviceId: deviceIdSchema.nullable(),
  metadata: publicMetadataSchema,
});
export type AuditItem = z.infer<typeof auditItemSchema>;
export const auditPageSchema = z.object({
  items: z.array(auditItemSchema),
  limit: z.number().int().min(1).max(100),
  nextCursor: z.string().nullable(),
});
