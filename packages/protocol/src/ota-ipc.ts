import { z } from "zod";
const id = z.uuid();
export const otaChildMessageSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("rpc"),
      id,
      method: z.enum([
        "CONNECT",
        "SUBSCRIBE",
        "PUBLISH",
        "DISCONNECT",
        "RECONNECT",
      ]),
      topic: z.string().max(256).optional(),
      payload: z.string().max(65536).optional(),
      retain: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("inspection"),
      id,
      fence: z.string(),
      bootId: id,
      releaseId: id,
      version: z.string().max(64),
      buildId: z.string().max(64),
      behavior: z.string().max(64),
      ready: z.boolean(),
      measuredAt: z.iso.datetime({ precision: 3 }),
      sequence: z.number().int().nonnegative(),
      receipts: z.number().int().nonnegative(),
      sqlite: z.boolean(),
      commandReady: z.boolean(),
    })
    .strict(),
]);
export const otaParentMessageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reply"), id, ok: z.boolean() }).strict(),
  z
    .object({
      kind: z.literal("delivery"),
      topic: z.string().max(256),
      payload: z.string().max(65536),
      retain: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("connection"),
      event: z.enum(["connect", "close", "offline", "reconnect"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("inspect"),
      id,
      fence: z.string(),
      purpose: z.enum(["PREPARE", "HEALTH", "RESUME", "STOP"]),
    })
    .strict(),
]);
export type OtaChildMessage = z.infer<typeof otaChildMessageSchema>;
