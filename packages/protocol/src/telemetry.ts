import { z } from "zod";

import { messageBaseSchema } from "./common.js";

const finiteNumberSchema = z
  .number()
  .refine(Number.isFinite, "number must be finite");

const telemetryV1MessageSchema = z
  .object({
    ...messageBaseSchema.shape,
    sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
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

export const telemetryV2MessageSchema = telemetryV1MessageSchema.extend({
  schemaVersion: z.literal(2),
  sessionId: z
    .string()
    .regex(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      "sessionId must be a canonical lowercase UUID v4",
    ),
});

export const telemetryMessageSchema = z.discriminatedUnion("schemaVersion", [
  telemetryV1MessageSchema,
  telemetryV2MessageSchema,
]);

export type TelemetryMessage = z.infer<typeof telemetryMessageSchema>;
export type TelemetryV2Message = z.infer<typeof telemetryV2MessageSchema>;
