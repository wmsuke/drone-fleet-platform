import { z } from "zod";
import { messageBaseSchema } from "./common.js";

const id = z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const uuid = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
const counter = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const unknown = z
  .object({
    status: z.literal("UNKNOWN"),
    reason: z.enum(["VERSION_UNREPORTED", "IDENTITY_UNAVAILABLE"]),
  })
  .strict();
const unused = z
  .object({
    status: z.literal("NOT_APPLICABLE"),
    reason: z.literal("NOT_USED"),
  })
  .strict();
const component = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("KNOWN"),
      id,
      version: z.enum(["0.2.0", "0.3.0"]),
      releaseDigest: digest,
    })
    .strict(),
  unknown,
]);
const limits = z
  .object({
    minBatteryPercent: z.literal(20),
    maxDistanceMm: z.literal(10000),
    sensorFreshnessMs: z.literal(3000),
    heartbeatTimeoutMs: z.literal(3000),
    positionToleranceMm: z.literal(200),
    stoppedSpeedMmPerSecond: z.literal(50),
    dwellMs: z.literal(1000),
  })
  .strict();
const capabilityProfileBaseSchema = z
  .object({
    profileId: id,
    version: z.literal("1.0.0"),
    model: z.literal("reference_vehicle"),
    operations: z
      .array(
        z
          .object({
            command: z.literal("RETURN_HOME"),
            actionType: z.literal("fleet_bridge_interfaces/action/ReturnHome"),
            actionName: z.literal("return_home"),
          })
          .strict(),
      )
      .min(1)
      .max(1),
    frames: z
      .object({
        position: z.literal("map"),
        velocity: z.literal("base_link"),
        convention: z.literal("ENU"),
        positionUnit: z.literal("m"),
        velocityUnit: z.literal("m/s"),
        angularUnit: z.literal("rad/s"),
      })
      .strict(),
    requiredSensors: z.tuple([
      z.literal("battery"),
      z.literal("odometry"),
      z.literal("runtime_state"),
    ]),
    homeDefinition: z.literal("SERVER_BOOT_REGISTERED_POSE"),
    limits,
  })
  .strict();
export const capabilityProfileSchema = z.discriminatedUnion("version", [
  capabilityProfileBaseSchema,
  capabilityProfileBaseSchema
    .extend({
      version: z.literal("1.1.0"),
      resultCacheMs: z.number().int().min(100).max(900000),
    })
    .strict(),
]);
const policy = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("KNOWN"),
      id,
      version: z.literal("1.0.0"),
      digest,
      definition: limits,
    })
    .strict(),
  unknown,
  unused,
]);
export const adapterConfigurationSchema = z
  .object({
    deviceId: messageBaseSchema.shape.deviceId,
    namespace: z.string().regex(/^\/fleet\/d_[0-9a-f]{2,128}$/),
    serverInstanceId: uuid,
    adapterConfigurationId: digest,
    homeId: id,
    profile: z.object({ digest, definition: capabilityProfileSchema }).strict(),
    adapter: component,
    runtime: z.discriminatedUnion("status", [
      z
        .object({
          status: z.literal("KNOWN"),
          manifestDigest: digest,
          rosDistro: z.literal("jazzy"),
          rmw: z.literal("rmw_fastrtps_cpp"),
          python: z.string().regex(/^3\.12\.\d+$/),
          architecture: z.enum(["arm64", "amd64"]),
        })
        .strict(),
      unknown,
    ]),
    operatingPolicy: policy,
    safetyConfig: policy,
    ai: unused,
  })
  .strict();
export const bridgeConfigurationSchema = adapterConfigurationSchema
  .extend({ bridge: component })
  .strict();
export const bridgeConfigurationEventSchema = z
  .object({
    ...messageBaseSchema.shape,
    kind: z.literal("CONFIGURATION"),
    eventId: uuid,
    sessionId: uuid,
    journalId: uuid,
    sequence: counter,
    configurationId: digest,
    configurationRevision: counter,
    reportSequence: counter,
    configuration: bridgeConfigurationSchema,
  })
  .strict();
const eventBase = z.object({
  ...messageBaseSchema.shape,
  eventId: uuid,
  sessionId: uuid,
  journalId: uuid,
  sequence: counter,
  configurationId: digest,
  commandId: uuid,
  goalId: uuid,
  serverInstanceId: uuid,
});
const metric = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const vector = z
  .object({
    x: z.number().int().safe(),
    y: z.number().int().safe(),
    z: z.number().int().safe(),
  })
  .strict();
export const bridgeReasonSchema = z.enum([
  "GOAL_ACCEPTED",
  "ACTION_REJECTED",
  "EXECUTION_STARTED",
  "FEEDBACK",
  "HOME_REACHED",
  "INJECTED_FAILURE",
  "BRIDGE_WATCHDOG",
  "SENSOR_STALE",
  "LOW_BATTERY",
  "POLICY_REJECTED",
  "REJECTED_EXPIRED",
  "CANCELLED",
  "SERVER_SHUTDOWN",
  "GOAL_ID_MISMATCH",
  "INVALID_GOAL",
  "RESULT_INVALID",
  "RESULT_UNKNOWN",
  "SERVER_CHANGED",
  "RESULT_TIMEOUT",
  "RESULT_CACHE_UNAVAILABLE",
  "RESULT_DEADLINE",
  "BRIDGE_RESTART",
  "CONFIGURATION_MISMATCH",
  "DEVICE_BUSY",
  "STOP_OBSERVED",
]);
export const bridgeResultEvidenceSchema = z
  .object({
    cdr: z
      .string()
      .regex(/^[A-Za-z0-9+/]+={0,2}$/)
      .max(8192),
    hash: digest,
    rosStatus: z.union([z.literal(4), z.literal(5), z.literal(6)]),
    started: z.boolean(),
    startedAt: messageBaseSchema.shape.timestamp.nullable(),
    finishedAt: messageBaseSchema.shape.timestamp,
    poseFrame: z.string().max(192),
    velocityFrame: z.string().max(192),
    homeId: id,
    poseMm: vector,
    velocityMmPerSecond: vector,
    homeDistanceMm: metric,
    speedMmPerSecond: metric,
    stableDurationMs: metric,
  })
  .strict();
const executionBase = eventBase.extend({
  kind: z.literal("EXECUTION"),
  reason: bridgeReasonSchema,
  startedAt: messageBaseSchema.shape.timestamp.optional(),
  result: bridgeResultEvidenceSchema.optional(),
  rawResult: z
    .object({
      hash: digest,
      bytes: metric,
      cdr: z
        .string()
        .regex(/^[A-Za-z0-9+/]+={0,2}$/)
        .max(8192)
        .optional(),
    })
    .strict()
    .optional(),
});
export const bridgeActionEventSchema = z.union([
  eventBase
    .extend({
      kind: z.literal("GOAL_ACCEPTED"),
      reason: z.literal("GOAL_ACCEPTED"),
    })
    .strict(),
  eventBase
    .extend({
      kind: z.literal("GOAL_REJECTED"),
      reason: z.literal("ACTION_REJECTED"),
    })
    .strict(),
  eventBase
    .extend({
      kind: z.literal("FEEDBACK"),
      reason: z.literal("FEEDBACK"),
      startedAt: messageBaseSchema.shape.timestamp,
      distanceMm: metric,
    })
    .strict(),
  executionBase
    .extend({
      status: z.literal("RUNNING"),
      startedAt: messageBaseSchema.shape.timestamp,
    })
    .strict(),
  ...(["SUCCEEDED", "FAILED", "CANCELLED"] as const).map((status) =>
    executionBase
      .extend({
        status: z.literal(status),
        startedAt: messageBaseSchema.shape.timestamp,
        result: bridgeResultEvidenceSchema,
      })
      .strict(),
  ),
  executionBase.extend({ status: z.literal("UNCERTAIN") }).strict(),
  executionBase
    .extend({ status: z.literal("REJECTED"), startedAt: z.never().optional() })
    .strict(),
  eventBase
    .extend({
      kind: z.literal("STOP_OBSERVATION"),
      reason: z.literal("STOP_OBSERVED"),
      terminalEventId: uuid,
      flightStatus: z.literal("IDLE"),
      speedMmPerSecond: metric,
      dwellMs: metric,
      poseFrame: z.string().max(192),
      firstSampleAt: messageBaseSchema.shape.timestamp,
      lastSampleAt: messageBaseSchema.shape.timestamp,
    })
    .strict(),
]);
export const bridgeEventMessageSchema = z.union([
  bridgeConfigurationEventSchema,
  bridgeActionEventSchema,
]);
export type BridgeActionEvent = z.infer<typeof bridgeActionEventSchema>;
export type BridgeConfigurationEvent = z.infer<
  typeof bridgeConfigurationEventSchema
>;
export const bridgeReceiptMessageSchema = z
  .object({
    ...messageBaseSchema.shape,
    eventId: uuid,
    payloadHash: digest,
    status: z.literal("STORED"),
  })
  .strict();
export const bridgeDesiredSchema = z
  .object({ revision: counter, configurationId: digest })
  .strict();

// 構成にはsafe integerのみを使う。Pythonと同じキー順・UTF-8で識別する。
export function canonicalBridgeJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value))
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(canonicalBridgeJson).join(",")}]`;
  if (typeof value === "object")
    return `{${Object.entries(value!)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalBridgeJson(v)}`)
      .join(",")}}`;
  throw new TypeError("configuration contains unsupported JSON value");
}
export function supportsBridgeOperation(
  configuration: BridgeConfiguration,
  operation: string,
): boolean {
  return (
    configuration.bridge.status === "KNOWN" &&
    configuration.adapter.status === "KNOWN" &&
    configuration.runtime.status === "KNOWN" &&
    configuration.operatingPolicy.status === "KNOWN" &&
    configuration.safetyConfig.status === "KNOWN" &&
    configuration.profile.definition.operations.some(
      (o) => o.command === operation,
    )
  );
}
export type BridgeConfiguration = z.infer<typeof bridgeConfigurationSchema>;
export type BridgeEventMessage = z.infer<typeof bridgeEventMessageSchema>;
export type BridgeReceiptMessage = z.infer<typeof bridgeReceiptMessageSchema>;
