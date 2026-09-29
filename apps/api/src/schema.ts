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
