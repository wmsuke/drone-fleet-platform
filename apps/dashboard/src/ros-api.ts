import { z } from "zod";
import {
  bridgeConfigurationSchema,
  bridgeHealthEventSchema,
  bridgeActionEventSchema,
  bridgeCancelEventSchema,
  bridgeCancelRequestSchema,
  rosObservationMessageSchema,
} from "@drone-fleet/protocol";
import { ApiError } from "./api.js";

const time = z.iso.datetime();
const id = z.uuid();
const status = z.enum([
  "NOT_REPORTED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "UNCERTAIN",
  "REJECTED",
  "CANCELLED",
]);
const record = <T extends z.ZodType>(message: T) =>
  z.object({
    eventId: id,
    receivedAt: time,
    disposition: z.string(),
    message,
  });
export const rosConfigurationSchema = z.object({
  reported: z
    .object({
      configurationId: z.string(),
      reportSequence: z.number(),
      receivedAt: time,
      configuration: bridgeConfigurationSchema,
    })
    .nullable(),
  fresh: z.boolean(),
  ready: z.boolean(),
  supportedOperations: z.array(z.string()),
  matchesDesired: z.boolean().nullable(),
  operationReason: z.string(),
});
export const rosHealthSchema = z.object({
  latest: record(bridgeHealthEventSchema).nullable(),
  fresh: z.boolean(),
  ready: z.boolean(),
  humanReviewRequired: z.boolean(),
  physicalStopConfirmed: z.literal(false),
  events: z.array(record(bridgeHealthEventSchema)),
});
export const rosObservationSchema = z.object({
  receivedAt: time,
  message: rosObservationMessageSchema,
});
export const rosExecutionSchema = z.object({
  command: z.object({
    commandId: id,
    deviceId: z.string(),
    status: z.string(),
    executionStatus: status,
  }),
  target: z.object({
    goalId: id.nullable(),
    acceptedAt: time.nullable(),
    stopConfirmed: z.boolean(),
    notStarted: z.boolean(),
    conflicted: z.boolean(),
    resultDeadline: time,
  }),
  configuration: bridgeConfigurationSchema,
  recovery: z.object({
    humanReviewRequired: z.boolean(),
    automaticResubmit: z.literal(false),
    reason: z.string().nullable(),
    evidenceEventId: id.nullable(),
  }),
  events: z.array(record(bridgeActionEventSchema)),
});
export const rosCancelSchema = z.object({
  cancelId: id,
  commandId: id,
  deviceId: z.string(),
  request: bridgeCancelRequestSchema,
  phase: z.enum([
    "REQUESTED",
    "RECEIVED",
    "SEND_INTENT",
    "ACCEPTED",
    "REJECTED",
    "UNCERTAIN",
  ]),
  assessment: z.enum([
    "PENDING",
    "REJECTED",
    "UNCERTAIN",
    "CANCELLED",
    "COMPLETED",
    "FAILED",
  ]),
  terminalStatus: status,
  stopConfirmation: z.enum(["OBSERVED", "NOT_STARTED", "UNKNOWN"]),
  humanReviewRequired: z.boolean(),
  intervention: z.object({
    interventionId: id,
    reason: z.string(),
    actorKind: z.string(),
    startedAt: time,
    finishedAt: time.nullable(),
    durationMs: z.number().nullable(),
    cost: z.null(),
  }),
  events: z.array(record(bridgeCancelEventSchema)),
});
export type RosObservation = z.infer<typeof rosObservationSchema>;
export type RosExecution = z.infer<typeof rosExecutionSchema>;
export type RosCancellation = z.infer<typeof rosCancelSchema>;

async function read<T extends z.ZodType>(
  base: string,
  path: string,
  schema: T,
  signal?: AbortSignal,
  missing = false,
): Promise<z.infer<T> | null> {
  const r = await fetch(`${base}${path}`, {
    signal,
    headers: { Accept: "application/json" },
  });
  if (missing && r.status === 404) return null;
  if (!r.ok) throw new ApiError(r.status);
  return schema.parse(await r.json());
}
const device = (value: string) => `/devices/${encodeURIComponent(value)}`;
export async function fetchRosConfiguration(
  base: string,
  value: string,
  signal?: AbortSignal,
) {
  const result = await read(
    base,
    `${device(value)}/bridge-configuration`,
    rosConfigurationSchema,
    signal,
  );
  if (result?.reported && result.reported.configuration.deviceId !== value)
    throw new TypeError("ROS configuration scope mismatch");
  return result;
}
export async function fetchRosHealth(
  base: string,
  value: string,
  signal?: AbortSignal,
) {
  const result = await read(
    base,
    `${device(value)}/bridge-health?limit=20`,
    rosHealthSchema,
    signal,
  );
  if (
    result &&
    ((result.latest && result.latest.message.deviceId !== value) ||
      result.events.some((e) => e.message.deviceId !== value))
  )
    throw new TypeError("ROS health scope mismatch");
  return result;
}
export async function fetchRosObservations(
  base: string,
  value: string,
  signal?: AbortSignal,
) {
  const result = await read(
    base,
    `${device(value)}/observations?limit=1`,
    z.array(rosObservationSchema),
    signal,
  );
  if (result?.some((e) => e.message.deviceId !== value))
    throw new TypeError("ROS observation scope mismatch");
  return result;
}
export async function fetchRosExecution(
  base: string,
  value: string,
  commandId: string,
  signal?: AbortSignal,
) {
  const result = await read(
    base,
    `/commands/${encodeURIComponent(commandId)}/bridge-execution`,
    rosExecutionSchema,
    signal,
    true,
  );
  if (
    result &&
    (result.command.deviceId !== value ||
      result.command.commandId !== commandId)
  )
    throw new TypeError("ROS execution scope mismatch");
  return result;
}
export async function fetchRosCancel(
  base: string,
  value: string,
  commandId: string,
  signal?: AbortSignal,
) {
  const result = await read(
    base,
    `${device(value)}/commands/${encodeURIComponent(commandId)}/cancel`,
    rosCancelSchema,
    signal,
    true,
  );
  if (result && (result.deviceId !== value || result.commandId !== commandId))
    throw new TypeError("ROS cancellation scope mismatch");
  return result;
}
export async function requestRosCancel(
  base: string,
  value: string,
  commandId: string,
  key: string,
  reason: string,
) {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(reason))
    throw new TypeError("invalid cancellation reason");
  const r = await fetch(
    `${base}${device(value)}/commands/${encodeURIComponent(commandId)}/cancel`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify({ reason }),
    },
  );
  if (!r.ok) throw new ApiError(r.status);
  const result = z
    .object({
      cancelId: id,
      replayed: z.boolean(),
      state: rosCancelSchema.nullable(),
    })
    .parse(await r.json());
  if (
    result.state &&
    (result.state.commandId !== commandId ||
      result.state.deviceId !== value ||
      result.state.request.reason !== reason ||
      result.cancelId !== result.state.cancelId)
  )
    throw new TypeError("ROS cancellation scope mismatch");
  return result;
}
