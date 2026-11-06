import { z } from "zod";

import { DEVICE_ID_PATTERN } from "./topics.js";

export const messageBaseSchema = z.object({
  schemaVersion: z.literal(1),
  deviceId: z
    .string()
    .regex(DEVICE_ID_PATTERN, "deviceId has an invalid format"),
  timestamp: z.iso.datetime({ offset: false, local: false }),
});
