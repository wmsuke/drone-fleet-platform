import { z } from "zod";
import semver from "semver";
import { isValidDeviceId, parseMqttTopic } from "./topics.js";

const id = z
  .uuid()
  .refine((v) => v === v.toLowerCase(), "lowercase UUID required");
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const time = z.iso.datetime({ precision: 3 });
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const otaFenceSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine(
    (v) => /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n,
    "signed 64-bit fence required",
  );
export const otaReleaseIdentitySchema = z
  .object({
    releaseId: id,
    digest,
    version: z
      .string()
      .max(64)
      .refine((v) => semver.valid(v) === v),
    buildId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  })
  .strict();
const scope = {
  schemaVersion: z.literal(1),
  deviceId: z.string().refine(isValidDeviceId),
  deploymentId: id,
  stageId: id,
  targetId: id,
  attemptId: id,
  fence: otaFenceSchema,
  release: otaReleaseIdentitySchema,
};
const request = {
  ...scope,
  commandId: id,
  createdAt: time,
  expiresAt: time,
  resultDeadline: time,
  evaluationVersion: z.literal("ota-health-v1"),
};
export const otaRequestMessageSchema = z
  .discriminatedUnion("type", [
    z
      .object({
        ...request,
        type: z.literal("APPLY_RELEASE"),
        purpose: z.enum(["APPLY", "ROLLBACK"]),
      })
      .strict(),
    z
      .object({
        ...request,
        type: z.literal("STOP_UPDATE"),
        applyCommandId: id,
      })
      .strict(),
    z
      .object({
        ...request,
        type: z.literal("QUERY_STATE"),
        applyCommandId: id,
        challengeId: id.nullable(),
      })
      .strict(),
  ])
  .superRefine((v, ctx) => {
    const created = Date.parse(v.createdAt);
    const [start, result] =
      v.type === "APPLY_RELEASE"
        ? [300000, 600000]
        : v.type === "STOP_UPDATE"
          ? [30000, 60000]
          : [15000, 15000];
    if (
      Date.parse(v.expiresAt) - created !== start ||
      Date.parse(v.resultDeadline) - created !== result
    )
      ctx.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "OTA v1 deadline does not match request type",
      });
    if (v.type !== "APPLY_RELEASE" && v.commandId === v.applyCommandId)
      ctx.addIssue({
        code: "custom",
        path: ["commandId"],
        message: "control request needs a new commandId",
      });
  });
export type OtaRequestMessage = z.infer<typeof otaRequestMessageSchema>;
export type OtaApplyRequest = Extract<
  OtaRequestMessage,
  { type: "APPLY_RELEASE" }
>;
export const otaProgressStates = [
  "RECEIVED",
  "DOWNLOADING",
  "VERIFIED",
  "QUIESCING",
  "SWITCHING",
  "BOOTING",
  "HEALTH_CHECKING",
  "APPLIED",
  "FAILED",
  "STOPPED",
  "UNCERTAIN",
] as const;
const state = z.enum(otaProgressStates);
const running = z
  .object({ release: otaReleaseIdentitySchema, bootId: id })
  .strict();
const event = {
  ...scope,
  eventId: id,
  sequence: count,
  timestamp: time,
  applyCommandId: id,
  supervisorBootId: id,
};
const failureReason = z.enum([
  "INVALID_SIGNATURE",
  "UNTRUSTED_KEY",
  "DIGEST_MISMATCH",
  "SIZE_MISMATCH",
  "INCOMPATIBLE_RELEASE",
  "INVALID_ARCHIVE",
  "DOWNLOAD_FAILED",
  "CAPACITY_EXCEEDED",
  "CLOCK_UNTRUSTED",
  "FENCE_CONFLICT",
  "COMMAND_CONFLICT",
  "DEVICE_BUSY",
  "BOOT_FAILED",
  "HEALTH_FAILED",
  "JOURNAL_CORRUPT",
  "RESULT_UNKNOWN",
  "ROLLBACK_UNAVAILABLE",
]);
const check = z.enum(["PASSED", "FAILED"]);
const progress = z
  .object({
    ...event,
    type: z.literal("PROGRESS"),
    requestType: z.enum(["APPLY_RELEASE", "STOP_UPDATE"]),
    state,
    commandId: id,
    downloadedBytes: count.max(256 * 1024 * 1024),
    reason: failureReason.nullable(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (["FAILED", "UNCERTAIN"].includes(v.state) !== (v.reason !== null))
      ctx.addIssue({
        code: "custom",
        path: ["reason"],
        message: "only failure/uncertainty requires a reason",
      });
    if (
      v.requestType === "APPLY_RELEASE" &&
      (v.commandId !== v.applyCommandId || v.state === "STOPPED")
    )
      ctx.addIssue({
        code: "custom",
        path: ["commandId"],
        message:
          "apply progress must refer to applyCommandId and cannot confirm a stop",
      });
    if (
      v.requestType === "STOP_UPDATE" &&
      (v.commandId === v.applyCommandId ||
        !["RECEIVED", "STOPPED", "FAILED", "UNCERTAIN"].includes(v.state))
    )
      ctx.addIssue({
        code: "custom",
        path: ["commandId"],
        message:
          "stop progress needs its own commandId and a receipt/stop/failure state",
      });
  });
export const otaEventMessageSchema = z.discriminatedUnion("type", [
  progress,
  z.object({ ...event, type: z.literal("VERSION"), running }).strict(),
  z
    .object({
      ...event,
      type: z.literal("HEALTH"),
      running,
      queryCommandId: id,
      challengeId: id,
      measuredAt: time,
      sampleMonotonicMs: count,
      sampleAgeMs: count.max(5000),
      checks: z
        .object({
          eventLoop: check,
          telemetry: check,
          sqlite: check,
          commandReady: check,
          mqtt: check,
          subscriptions: check,
          receipts: check,
        })
        .strict(),
    })
    .strict()
    .superRefine((v, ctx) => {
      const age = Date.parse(v.timestamp) - Date.parse(v.measuredAt);
      if (age < 0 || age > 5000)
        ctx.addIssue({
          code: "custom",
          path: ["measuredAt"],
          message:
            "health must be measured within five seconds before reporting",
        });
      if (v.queryCommandId === v.applyCommandId)
        ctx.addIssue({
          code: "custom",
          path: ["queryCommandId"],
          message: "health needs a query request",
        });
    }),
  z
    .object({
      ...event,
      type: z.literal("STATE"),
      queryCommandId: id,
      state,
      running: running.nullable(),
    })
    .strict()
    .refine(
      (v) => v.queryCommandId !== v.applyCommandId,
      "state needs a query request",
    ),
]);
export type OtaEventMessage = z.infer<typeof otaEventMessageSchema>;
// 初回deploymentより前の実稼働構成。attemptの進捗・成功証拠ではない。
export const otaInventoryMessageSchema = z
  .object({
    schemaVersion: z.literal(1),
    type: z.literal("INVENTORY"),
    deviceId: z.string().refine(isValidDeviceId),
    eventId: id,
    sequence: count,
    supervisorBootId: id,
    timestamp: time,
    measuredAt: time,
    sampleAgeMs: count.max(5000),
    running,
    capabilities: z
      .object({
        application: z.literal("simulator"),
        platform: z.enum(["linux-arm64", "linux-x64"]),
        nodeVersion: z
          .string()
          .max(64)
          .refine((v) => semver.valid(v) === v),
        otaProtocolVersion: z.literal("1.0.0"),
        supervisorVersion: z.literal("1.0.0"),
        stateSchemaVersion: z.literal("1.0.0"),
        healthContractVersion: z.literal("ota-health-v1"),
      })
      .strict(),
  })
  .strict()
  .refine((v) => {
    const age = Date.parse(v.timestamp) - Date.parse(v.measuredAt);
    return age >= 0 && age <= 5000;
  }, "inventory must be fresh when measured");
export type OtaInventoryMessage = z.infer<typeof otaInventoryMessageSchema>;
export const otaInventoryReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    type: z.literal("INVENTORY"),
    deviceId: z.string().refine(isValidDeviceId),
    eventId: id,
    payloadHash: digest,
    status: z.literal("STORED"),
    receivedAt: time,
    storedAt: time,
  })
  .strict()
  .refine((v) => Date.parse(v.storedAt) >= Date.parse(v.receivedAt));
export type OtaInventoryReceipt = z.infer<typeof otaInventoryReceiptSchema>;
export const otaReceiptMessageSchema = z
  .object({
    ...scope,
    eventId: id,
    payloadHash: digest,
    status: z.literal("STORED"),
    receivedAt: time,
    storedAt: time,
  })
  .strict()
  .refine(
    (v) => Date.parse(v.storedAt) >= Date.parse(v.receivedAt),
    "storedAt must not precede server receivedAt",
  );
export type OtaReceiptMessage = z.infer<typeof otaReceiptMessageSchema>;
// サーバー受信時刻は端末に自己申告させず、backendで付ける。
export const receivedOtaEventSchema = z
  .object({ event: otaEventMessageSchema, receivedAt: time })
  .strict();
export type ReceivedOtaEvent = z.infer<typeof receivedOtaEventSchema>;
export const otaMqttOptions = { qos: 1, retain: false } as const;
export function parseOtaMessage(
  topic: string,
  input: unknown,
  packet: { qos: number; retain: boolean },
) {
  if (packet.qos !== 1 || packet.retain !== false)
    throw new TypeError("OTA requires QoS 1 without retain");
  const parsed = parseMqttTopic(topic);
  const schema =
    parsed?.kind === "ota-requests"
      ? otaRequestMessageSchema
      : parsed?.kind === "ota-events"
        ? z.union([otaEventMessageSchema, otaInventoryMessageSchema])
        : parsed?.kind === "ota-receipts"
          ? z.union([otaReceiptMessageSchema, otaInventoryReceiptSchema])
          : null;
  if (!schema) throw new TypeError("not an OTA topic");
  const message = schema.parse(input);
  if (message.deviceId !== parsed!.deviceId)
    throw new TypeError("topic/deviceId mismatch");
  return message;
}
// consumerはこのUTF-8 bytesのSHA-256をpayloadHashへ保存する。
export function serializeOtaEvent(input: OtaEventMessage): string {
  return serializeSorted(otaEventMessageSchema.parse(input));
}
export function serializeOtaInventory(input: OtaInventoryMessage): string {
  return serializeSorted(otaInventoryMessageSchema.parse(input));
}
function serializeSorted(input: unknown): string {
  const sorted = (value: unknown): unknown => {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(sorted);
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, sorted(item)]),
    );
  };
  return JSON.stringify(sorted(input));
}
// 永続状態・期限・challengeの消費は#170。不変scopeと報告版だけを照合する。
export function otaEventContextError(
  event: OtaEventMessage,
  apply: OtaApplyRequest,
): "ATTEMPT_MISMATCH" | "RELEASE_MISMATCH" | null {
  if (
    event.deviceId !== apply.deviceId ||
    event.deploymentId !== apply.deploymentId ||
    event.stageId !== apply.stageId ||
    event.targetId !== apply.targetId ||
    event.attemptId !== apply.attemptId ||
    event.fence !== apply.fence ||
    event.applyCommandId !== apply.commandId
  )
    return "ATTEMPT_MISMATCH";
  const sameRelease = (left: z.infer<typeof otaReleaseIdentitySchema>) =>
    Object.keys(apply.release).every(
      (key) =>
        left[key as keyof typeof left] ===
        apply.release[key as keyof typeof left],
    );
  if (!sameRelease(event.release)) return "RELEASE_MISMATCH";
  if (
    (event.type === "VERSION" || event.type === "HEALTH") &&
    !sameRelease(event.running.release)
  )
    return "RELEASE_MISMATCH";
  return null;
}
