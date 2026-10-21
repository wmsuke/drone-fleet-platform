import { readFile } from "node:fs/promises";
import { z } from "zod";
const source = z
  .object({
    origin: z.string(),
    allowedCidrs: z.array(z.string()).min(1).max(16),
    localHttp: z.boolean(),
  })
  .strict();
export const supervisorConfigSchema = z
  .object({
    deviceId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    root: z.string().startsWith("/"),
    data: z.string().startsWith("/"),
    trustPath: z.string().startsWith("/"),
    metadataSource: source,
    artifactSource: source,
    clockTrusted: z.literal(true),
    telemetryIntervalMs: z.number().int().min(1).max(5000),
  })
  .strict();
export async function readConfig(path: string) {
  return supervisorConfigSchema.parse(JSON.parse(await readFile(path, "utf8")));
}
