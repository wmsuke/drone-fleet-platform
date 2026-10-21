import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { z } from "zod";
export const bundleIdentitySchema = z
  .object({
    releaseId: z.uuid(),
    version: z.string(),
    buildId: z.string(),
    behavior: z.string().max(64),
    temperatureOffset: z.number().min(-10).max(10),
  })
  .strict();
export async function bundleSimulator(
  identity: z.infer<typeof bundleIdentitySchema>,
): Promise<Uint8Array> {
  const root = fileURLToPath(new URL("../../simulator/src/", import.meta.url));
  const result = await build({
    entryPoints: [`${root}ota-child.ts`],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    write: false,
    define: {
      __OTA_BUILD__: JSON.stringify(bundleIdentitySchema.parse(identity)),
    },
    alias: { mqtt: `${root}ipc-mqtt-stub.ts` },
    metafile: true,
  });
  for (const output of Object.values(result.metafile!.outputs))
    for (const entry of output.imports)
      if (entry.external && !entry.path.startsWith("node:"))
        throw new Error("bundle has external imports");
  return result.outputFiles![0]!.contents;
}
