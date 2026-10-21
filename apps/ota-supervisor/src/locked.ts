import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { readConfig } from "./config.js";
import { prepareDirectories } from "./supervisor.js";
async function main() {
  if (process.platform !== "linux" || process.getuid?.() !== 0)
    throw new Error("Linux root supervisor required");
  const [path, ...args] = process.argv.slice(2);
  if (!path) throw new Error("config required");
  const config = await readConfig(path);
  await prepareDirectories(config);
  const child = spawn(
    "flock",
    [
      "-n",
      "-F",
      join(config.root, "private/device.lock"),
      process.execPath,
      fileURLToPath(new URL("./index.js", import.meta.url)),
      path,
      ...args,
    ],
    { stdio: "inherit" },
  );
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.once(signal, () => child.kill(signal));
  child.once("exit", (code) => {
    process.exitCode = code ?? 1;
  });
  child.once("error", () => {
    console.error("OTA機体lockを取得できません");
    process.exitCode = 1;
  });
}
void main().catch(() => {
  console.error(
    "OTA supervisorを起動できません。設定・権限・journalを確認してください",
  );
  process.exitCode = 1;
});
