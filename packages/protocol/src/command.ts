import { z } from "zod";

import { messageBaseSchema } from "./common.js";

const commandIdSchema = z.uuid();

const commandV1MessageSchema = z
  .object({
    ...messageBaseSchema.shape,
    commandId: commandIdSchema,
    type: z.enum(["RETURN_HOME", "REBOOT"]),
  })
  .strip();

export type CommandMessage = z.infer<typeof commandMessageSchema>;

export const commandV2MessageSchema = commandV1MessageSchema
  .extend({
    schemaVersion: z.literal(2),
    expiresAt: messageBaseSchema.shape.timestamp,
  })
  .refine(
    (message) => Date.parse(message.expiresAt) > Date.parse(message.timestamp),
    "expiresAt must be after timestamp",
  );
export const commandMessageSchema = z.union([
  commandV2MessageSchema,
  commandV1MessageSchema,
]);

const commandAcknowledgementV1MessageSchema = z
  .object({
    ...messageBaseSchema.shape,
    commandId: commandIdSchema,
    status: z.literal("ACKNOWLEDGED"),
  })
  .strip();

export const commandAcknowledgementV2MessageSchema =
  commandAcknowledgementV1MessageSchema.extend({
    schemaVersion: z.literal(2),
    status: z.enum(["ACKNOWLEDGED", "REJECTED_EXPIRED"]),
  });
export const commandAcknowledgementMessageSchema = z.discriminatedUnion(
  "schemaVersion",
  [
    commandAcknowledgementV1MessageSchema,
    commandAcknowledgementV2MessageSchema,
  ],
);

export type CommandAcknowledgementMessage = z.infer<
  typeof commandAcknowledgementMessageSchema
>;
