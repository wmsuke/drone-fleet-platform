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

// ROS用受付を有効にするまでは既存配送のunionに加えない。
export const rosCommandMessageSchema = z
  .object({
    ...messageBaseSchema.shape,
    schemaVersion: z.literal(3),
    commandId: z
      .string()
      .regex(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
    type: z.literal("RETURN_HOME"),
    targetKind: z.literal("ROS2"),
    expectedConfigurationId: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: messageBaseSchema.shape.timestamp,
    resultDeadline: messageBaseSchema.shape.timestamp,
  })
  .strict()
  .superRefine((message, context) => {
    const start = Date.parse(message.timestamp);
    if (Date.parse(message.expiresAt) !== start + 30_000)
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message:
          "ROS command start deadline must be 30 seconds after acceptance",
      });
    if (Date.parse(message.resultDeadline) !== start + 120_000)
      context.addIssue({
        code: "custom",
        path: ["resultDeadline"],
        message:
          "ROS command result deadline must be 120 seconds after acceptance",
      });
  });

export type RosCommandMessage = z.infer<typeof rosCommandMessageSchema>;

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
export const commandAcknowledgementV3MessageSchema =
  commandAcknowledgementV1MessageSchema
    .extend({
      schemaVersion: z.literal(3),
      status: z.enum([
        "ACKNOWLEDGED",
        "REJECTED_EXPIRED",
        "RUNNING",
        "SUCCEEDED",
        "FAILED",
        "UNCERTAIN",
      ]),
      startedAt: messageBaseSchema.shape.timestamp.optional(),
    })
    .superRefine((value, context) => {
      const execution = !["ACKNOWLEDGED", "REJECTED_EXPIRED"].includes(
        value.status,
      );
      if (
        execution &&
        (!value.startedAt ||
          Date.parse(value.timestamp) < Date.parse(value.startedAt))
      )
        context.addIssue({
          code: "custom",
          path: ["startedAt"],
          message: "execution requires startedAt at or before timestamp",
        });
      if (!execution && value.startedAt !== undefined)
        context.addIssue({
          code: "custom",
          path: ["startedAt"],
          message: "receipt must not contain an execution start",
        });
    });
export const commandAcknowledgementMessageSchema = z.discriminatedUnion(
  "schemaVersion",
  [
    commandAcknowledgementV1MessageSchema,
    commandAcknowledgementV2MessageSchema,
    commandAcknowledgementV3MessageSchema,
  ],
);

export type CommandAcknowledgementMessage = z.infer<
  typeof commandAcknowledgementMessageSchema
>;
