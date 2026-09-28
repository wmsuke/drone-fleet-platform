import { z } from "zod";

import { isValidDeviceId } from "./topics.js";

export const messageBaseSchema = z.object({
  schemaVersion: z.literal(1),
  deviceId: z
    .string()
    .refine(isValidDeviceId, "deviceId has an invalid format"),
  timestamp: z.iso.datetime({ offset: false, local: false }),
});
