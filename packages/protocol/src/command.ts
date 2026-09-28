import { z } from "zod";

import { messageBaseSchema } from "./common.js";

const commandIdSchema = z.uuid();

export const commandMessageSchema = z
  .object({
    ...messageBaseSchema.shape,
    commandId: commandIdSchema,
    type: z.enum(["RETURN_HOME", "REBOOT"]),
  })
  .strip();

export type CommandMessage = z.infer<typeof commandMessageSchema>;

export const commandAcknowledgementMessageSchema = z
  .object({
    ...messageBaseSchema.shape,
    commandId: commandIdSchema,
    status: z.literal("ACKNOWLEDGED"),
  })
  .strip();

export type CommandAcknowledgementMessage = z.infer<
  typeof commandAcknowledgementMessageSchema
>;
