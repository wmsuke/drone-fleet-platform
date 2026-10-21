import { readFile, writeFile } from "node:fs/promises";
import { bundleIdentitySchema, bundleSimulator } from "./bundle.js";
const [config, output] = process.argv.slice(2);
if (!config || !output) throw new Error("bundle metadata/output required");
const bytes = await bundleSimulator(
  bundleIdentitySchema.parse(JSON.parse(await readFile(config, "utf8"))),
);
await writeFile(output, bytes, { flag: "wx" });
