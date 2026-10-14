import { z } from "zod";
export const fleetOperationRequestSchema = z
  .object({
    groupId: z.uuid().transform((id) => id.toLowerCase()),
    type: z.enum(["RETURN_HOME", "REBOOT"]),
  })
  .strict();
export const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const fleetOperationResponseSchema = z.object({
  operationId: z.uuid(),
  groupId: z.uuid(),
  type: z.enum(["RETURN_HOME", "REBOOT"]),
  status: z.literal("ACCEPTED"),
  targetCount: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  resultDeadline: z.iso.datetime(),
});
export type FleetOperationRequest = z.infer<typeof fleetOperationRequestSchema>;
export type FleetOperationResponse = z.infer<
  typeof fleetOperationResponseSchema
>;
