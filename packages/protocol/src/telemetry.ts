import { z } from "zod";

import { isValidDeviceId } from "./topics.js";

const finiteNumberSchema = z
  .number()
  .refine(Number.isFinite, "number must be finite");

export const telemetryMessageSchema = z
  .object({
    schemaVersion: z.literal(1),
    deviceId: z
      .string()
      .refine(isValidDeviceId, "deviceId has an invalid format"),
    sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    timestamp: z.iso.datetime({ offset: false, local: false }),
    payload: z
      .object({
        battery: z.number().min(0).max(100),
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        altitude: finiteNumberSchema.min(0),
        temperature: finiteNumberSchema,
        status: z.enum(["IDLE", "FLYING", "RETURNING_HOME"]),
      })
      .strip(),
  })
  .strip();

export type TelemetryMessage = z.infer<typeof telemetryMessageSchema>;
