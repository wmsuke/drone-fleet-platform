import { z } from "zod";
import { messageBaseSchema } from "./common.js";
import { telemetryV2MessageSchema } from "./telemetry.js";

export const telemetryReceiptMessageSchema = z
  .object({
    ...messageBaseSchema.shape,
    sessionId: telemetryV2MessageSchema.shape.sessionId,
    sequence: telemetryV2MessageSchema.shape.sequence,
    status: z.literal("STORED"),
  })
  .strict();

export type TelemetryReceiptMessage = z.infer<
  typeof telemetryReceiptMessageSchema
>;
