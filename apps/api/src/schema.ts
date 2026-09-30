import { z } from "zod";
import { isValidDeviceId } from "@drone-fleet/protocol";

export const deviceIdSchema = z
  .string()
  .refine(isValidDeviceId, "deviceId has an invalid format");

export const deviceListItemSchema = z.object({
  deviceId: z.string(),
  connectionStatus: z.enum(["ONLINE", "OFFLINE"]),
  battery: z.number().min(0).max(100).nullable(),
  flightStatus: z.enum(["IDLE", "FLYING", "RETURNING_HOME"]).nullable(),
  lastReceivedAt: z.iso.datetime().nullable(),
});

export const deviceListResponseSchema = z.array(deviceListItemSchema);

export const latestTelemetrySchema = z.object({
  sequence: z.number().int().nonnegative(),
  deviceTimestamp: z.iso.datetime(),
  receivedAt: z.iso.datetime(),
  battery: z.number().min(0).max(100),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  altitude: z.number().nonnegative(),
  temperature: z.number(),
  flightStatus: z.enum(["IDLE", "FLYING", "RETURNING_HOME"]),
});

export const telemetryHistoryResponseSchema = z.array(latestTelemetrySchema);

export const telemetryLimitSchema = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .pipe(z.number().int().min(1).max(1000));

export const commandRequestSchema = z
  .object({ type: z.enum(["RETURN_HOME", "REBOOT"]) })
  .strict();

export const commandResponseSchema = z.object({
  commandId: z.uuid(),
  deviceId: deviceIdSchema,
  type: z.enum(["RETURN_HOME", "REBOOT"]),
  status: z.enum(["PENDING", "SENT", "ACKNOWLEDGED", "FAILED", "TIMED_OUT"]),
  createdAt: z.iso.datetime(),
  sentAt: z.iso.datetime().nullable(),
});

export const commandHistoryItemSchema = commandResponseSchema.extend({
  acknowledgementReceivedAt: z.iso.datetime().nullable(),
  timedOutAt: z.iso.datetime().nullable(),
});

export const commandHistoryResponseSchema = z.array(commandHistoryItemSchema);

export const deviceDetailSchema = z.object({
  deviceId: deviceIdSchema,
  model: z.string().nullable(),
  softwareVersion: z.string().nullable(),
  connectionStatus: z.enum(["ONLINE", "OFFLINE"]),
  lastReceivedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  latestTelemetry: latestTelemetrySchema.nullable(),
});

export type DeviceListItem = z.infer<typeof deviceListItemSchema>;
export type DeviceDetail = z.infer<typeof deviceDetailSchema>;
export type TelemetryHistoryItem = z.infer<typeof latestTelemetrySchema>;
export type CommandRequest = z.infer<typeof commandRequestSchema>;
export type CommandResponse = z.infer<typeof commandResponseSchema>;
export type CommandHistoryItem = z.infer<typeof commandHistoryItemSchema>;
