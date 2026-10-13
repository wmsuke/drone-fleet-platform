import { z } from "zod";
import { deviceIdSchema } from "./schema.js";

export const groupIdSchema = z.uuid();
const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((name) =>
    [...name].every(
      (character) =>
        character.codePointAt(0)! > 31 && character.codePointAt(0) !== 127,
    ),
  );
const descriptionSchema = z
  .string()
  .max(1000)
  .refine((value) => !value.includes(String.fromCharCode(0)))
  .nullable();
export const createGroupSchema = z
  .object({ name: nameSchema, description: descriptionSchema.optional() })
  .strict();
export const updateGroupSchema = z
  .object({
    name: nameSchema.optional(),
    description: descriptionSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);
export const groupMemberSchema = z
  .object({ deviceId: deviceIdSchema })
  .strict();
export const groupResponseSchema = z.object({
  groupId: groupIdSchema,
  name: z.string(),
  description: z.string().nullable(),
  revision: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deviceCount: z.number().int().nonnegative(),
  deviceIds: z.array(deviceIdSchema),
});
export type Group = z.infer<typeof groupResponseSchema>;
export type CreateGroup = z.infer<typeof createGroupSchema>;
export type UpdateGroup = z.infer<typeof updateGroupSchema>;
