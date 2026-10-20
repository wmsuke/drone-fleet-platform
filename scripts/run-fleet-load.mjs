import { spawn } from "node:child_process";
import process from "node:process";
import console from "node:console";
import { setTimeout } from "node:timers";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { cpus, totalmem, platform, release, arch } from "node:os";
import { fileURLToPath, URL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const stamp = new Date().toISOString().replace(/[^0-9]/g, "");
const output = resolve(
  root,
  process.env.FLEET_LOAD_OUTPUT ?? `load-results/fleet-${stamp}`,
);
const counts = (process.env.FLEET_LOAD_COUNTS ?? "10,100")
  .split(",")
  .map(Number);
if (counts.some((n) => ![10, 100, 1000].includes(n)))
  throw new Error("台数は10,100,1000で指定する");
const conditions = (
  process.env.FLEET_LOAD_CONDITIONS ?? "success,failure,unresponsive"
).split(",");
if (conditions.some((c) => !["success", "failure", "unresponsive"].includes(c)))
  throw new Error("応答条件が不正");
const trials = Number(process.env.FLEET_LOAD_TRIALS ?? 3);
if (!Number.isSafeInteger(trials) || trials < 1 || trials > 10)
  throw new Error("試行回数は1〜10");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function run(command, args, env = {}, allowFailure = false) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (v) => {
      stdout += v;
    });
    child.stderr.on("data", (v) => {
      stderr += v;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0 && !allowFailure)
        reject(new Error(`${command} failed (${code}): ${stderr}\n${stdout}`));
      else resolvePromise({ code, stdout, stderr });
    });
  });
}
await mkdir(dirname(output), { recursive: true });
// 以前のready/結果を新しい試行と取り違えない。
await mkdir(output);
const environment = {
  startedAt: new Date().toISOString(),
  host: {
    platform: platform(),
    release: release(),
    arch: arch(),
    cpu: cpus()[0]?.model,
    cpuCount: cpus().length,
    memoryBytes: totalmem(),
  },
  docker: JSON.parse(
    (await run("docker", ["info", "--format", "{{json .}}"])).stdout,
  ),
  commit: (await run("git", ["rev-parse", "HEAD"])).stdout.trim(),
  node: process.version,
  counts,
  conditions,
  trials,
};
// docker info全体にはホスト設定を含むため、公開するのは資源上限とversionだけ。
environment.docker = {
  ServerVersion: environment.docker.ServerVersion,
  NCPU: environment.docker.NCPU,
  MemTotal: environment.docker.MemTotal,
  Architecture: environment.docker.Architecture,
};
await writeFile(
  resolve(output, "environment.json"),
  JSON.stringify(environment, null, 2),
);
const results = [];
let active;
const composeArgs = [
  "compose",
  "--env-file",
  "/dev/null",
  "-f",
  "compose.yaml",
  "-f",
  "compose.fleet-load.yaml",
];
const cleanup = async () => {
  if (active)
    await run(
      "docker",
      [
        ...composeArgs,
        "-p",
        active.project,
        "down",
        "--volumes",
        "--remove-orphans",
      ],
      active.env,
      true,
    );
};
process.once("SIGINT", () => {
  void cleanup().then(() => process.exit(130));
});
process.once("SIGTERM", () => {
  void cleanup().then(() => process.exit(143));
});
try {
  for (const count of counts)
    for (const condition of conditions)
      for (let trial = 1; trial <= trials; trial++) {
        const name = `${count}-${condition}-${trial}`;
        const directory = resolve(output, name);
        await mkdir(directory, { recursive: true });
        const project = `fleet-load-${stamp}-${name}`;
        const env = {
          FLEET_LOAD_RESULTS_DIR: directory,
          FLEET_LOAD_DEVICES: String(count),
          FLEET_LOAD_CONDITION: condition,
          FLEET_OPERATION_MAX_TARGETS: String(count),
          API_PORT: process.env.FLEET_LOAD_API_PORT ?? "18146",
          POSTGRES_DB: "drone_fleet",
          POSTGRES_USER: "drone_fleet",
          POSTGRES_PASSWORD: "local-development-only",
          LOAD_RESULTS_DIR: directory,
        };
        active = { project, env };
        const compose = (args, allowFailure = false) =>
          run(
            "docker",
            [...composeArgs, "-p", project, ...args],
            env,
            allowFailure,
          );
        console.log(`開始 ${name}`);
        if (results.length === 0) {
          const built = await compose(["build", "fleet-responder"]);
          await writeFile(
            resolve(output, "build.txt"),
            built.stdout + built.stderr,
          );
        }
        await compose([
          "up",
          "-d",
          "--no-build",
          "--wait",
          "--wait-timeout",
          "120",
          "postgres",
          "mqtt",
          "migrate",
          "api",
          "telemetry-ingestor",
          "alert-evaluator",
        ]);
        await compose(["up", "-d", "--no-build", "fleet-responder"]);
        let ready = false;
        for (let i = 0; i < 120; i++) {
          try {
            await access(resolve(directory, "ready.json"));
            ready = true;
            break;
          } catch {
            await wait(500);
          }
        }
        if (!ready) throw new Error("応答器の全台購読完了を確認できない");
        let sampling = true;
        const stats = [];
        const ids = (
          await compose([
            "ps",
            "-q",
            "postgres",
            "mqtt",
            "api",
            "telemetry-ingestor",
            "alert-evaluator",
            "fleet-responder",
          ])
        ).stdout
          .trim()
          .split(/\s+/);
        const collect = (async () => {
          while (sampling) {
            const s = await run(
              "docker",
              ["stats", "--no-stream", "--format", "{{json .}}", ...ids],
              {},
              true,
            );
            stats.push({
              at: new Date().toISOString(),
              data: s.stdout
                .trim()
                .split("\n")
                .filter(Boolean)
                .map((line) => JSON.parse(line)),
            });
            await wait(500);
          }
        })();
        let measured;
        try {
          measured = await compose(
            ["run", "--rm", "--no-deps", "fleet-probe"],
            true,
          );
        } finally {
          sampling = false;
          await collect;
        }
        await compose(["stop", "fleet-responder"]);
        await writeFile(
          resolve(directory, "container-stats.json"),
          JSON.stringify(stats),
        );
        await writeFile(
          resolve(directory, "probe.txt"),
          measured.stdout + measured.stderr,
        );
        const logs = (
          await compose(["logs", "--no-color", "--no-log-prefix", "api"])
        ).stdout;
        const acceptance = logs
          .split("\n")
          .filter((s) => s.startsWith("{"))
          .map((s) => {
            try {
              return JSON.parse(s);
            } catch {
              return null;
            }
          })
          .filter((v) => v?.event === "fleet.operation.accepted");
        await writeFile(
          resolve(directory, "acceptance.json"),
          JSON.stringify(acceptance, null, 2),
        );
        const report = JSON.parse(
          await readFile(resolve(directory, "trial.json"), "utf8"),
        );
        const responder = JSON.parse(
          await readFile(resolve(directory, "responder.json"), "utf8"),
        );
        const { distribution } =
          await import("../apps/load-report/dist/fleet-load.js");
        const latencies = [];
        for (const row of report.commandTimelines) {
          const ack = responder.events.find(
            (e) =>
              e.commandId === row.command_id && e.status === "ACKNOWLEDGED",
          );
          if (ack && row.acknowledgement_received_at)
            latencies.push(
              Date.parse(row.acknowledgement_received_at) -
                Date.parse(ack.publishedAt),
            );
        }
        const summary = {
          name,
          count,
          condition,
          trial,
          exitCode: measured.code,
          acceptance: acceptance.find(
            (a) => a.operationId === report.operationId,
          ),
          acceptanceMs: report.acceptanceMs,
          api: report.api,
          rows: report.rows,
          publish: report.publish,
          ackReceivedAfterPublishMs: distribution(latencies),
          terminalObservedMs: report.terminalObservedMs,
          operation: report.operation,
          checks: report.checks,
          generator: {
            failures: responder.failures,
            eventLoopDelayMs: responder.eventLoopDelayMs,
            cpuMicros: responder.cpuMicros,
            memoryBytes: responder.memoryBytes,
          },
          connections: report.connections,
        };
        await writeFile(
          resolve(directory, "summary.json"),
          JSON.stringify(summary, null, 2),
        );
        results.push(summary);
        await writeFile(
          resolve(output, "summary.json"),
          JSON.stringify({ schemaVersion: 1, environment, results }, null, 2),
        );
        console.log(
          `完了 ${name}: 受付${report.acceptanceMs.toFixed(1)}ms 詳細p95 ${report.api.timings.p95Ms?.toFixed(1)}ms 終端${report.terminalObservedMs?.toFixed(1)}ms`,
        );
        await cleanup();
        active = undefined;
        if (measured.code !== 0 || responder.failures !== 0)
          throw new Error(
            `${name}の基準またはgenerator確認に失敗。結果を確認してから次の段階へ進む`,
          );
      }
} finally {
  await cleanup();
  if (results.length) {
    const { summarizeFleetLoad } = await import("./summarize-fleet-load.mjs");
    await summarizeFleetLoad(output);
  }
}
console.log(`保存先: ${output}`);
