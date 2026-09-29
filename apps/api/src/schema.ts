import { z } from "zod";

export const deviceListItemSchema = z.object({
  deviceId: z.string(),
  connectionStatus: z.enum(["ONLINE", "OFFLINE"]),
  battery: z.number().min(0).max(100).nullable(),
  flightStatus: z.enum(["IDLE", "FLYING", "RETURNING_HOME"]).nullable(),
  lastReceivedAt: z.iso.datetime().nullable(),
});

export const deviceListResponseSchema = z.array(deviceListItemSchema);

export type DeviceListItem = z.infer<typeof deviceListItemSchema>;
