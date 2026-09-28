import { z } from "zod";

import { messageBaseSchema } from "./common.js";

const connectionStatusPayloadSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ONLINE"),
      reason: z.literal("CONNECTED"),
    })
    .strip(),
  z
    .object({
      status: z.literal("OFFLINE"),
      reason: z.enum(["SHUTDOWN", "CONNECTION_LOST"]),
    })
    .strip(),
]);

export const connectionStatusMessageSchema = z
  .object({
    ...messageBaseSchema.shape,
    payload: connectionStatusPayloadSchema,
  })
  .strip();

export type ConnectionStatusMessage = z.infer<
  typeof connectionStatusMessageSchema
>;
