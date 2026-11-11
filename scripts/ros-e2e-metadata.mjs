import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
const run = (cmd, args) =>
  execFileSync(cmd, args, { encoding: "utf8", timeout: 10000 }).trim();
const docker = JSON.parse(run("docker", ["info", "--format", "{{json .}}"]));
writeFileSync(
  join(process.argv[2], "metadata.json"),
  JSON.stringify(
    {
      startedAt: new Date().toISOString(),
      commit: run("git", ["rev-parse", "HEAD"]),
      worktree: run("git", [
        "status",
        "--short",
        "--",
        "ros",
        "scripts",
        "apps/dashboard",
        "compose.ros-commands.yaml",
      ]),
      host: {
        platform: process.platform,
        architecture: process.arch,
        node: process.version,
      },
      docker: {
        version: docker.ServerVersion,
        architecture: docker.Architecture,
        os: docker.OSType,
        cpus: docker.NCPU,
        memoryBytes: docker.MemTotal,
      },
      reference: {
        configuredBatches: Object.fromEntries(
          ["commands", "cancels", "recovery"].map((name) => [
            name,
            JSON.parse(readFileSync(`ros/config/${name}.json`, "utf8")).devices
              .length,
          ]),
        ),
        maxDevicesPerBatch: 10,
        maxActiveBridges: 2,
        odometryHz: 10,
        sensorsHz: 1,
        runtimeHz: 1,
        heartbeatHz: 1,
        feedbackHzMax: 1,
        qos: {
          sensors: "BEST_EFFORT / VOLATILE / KEEP_LAST 5",
          runtime: "RELIABLE / VOLATILE / KEEP_LAST 1",
          mqtt: 1,
        },
        actionRetries: 0,
        getResultMaxQueries: 5,
        getResultBudgetMs: 30000,
      },
      testAttempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? 1),
      awsExecuted: false,
    },
    null,
    2,
  ) + "\n",
);
