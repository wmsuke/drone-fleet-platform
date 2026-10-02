/* global console, process */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const directory = process.argv[2];
if (!directory) throw new TypeError("results directory is required");
const readJson = async (name) =>
  JSON.parse(await readFile(join(directory, name), "utf8"));
const [trial, report, api] = await Promise.all([
  readJson("trial.json"),
  readJson("report.json"),
  readJson("api.json"),
]);
const stats = (
  await readFile(join(directory, "container-stats.ndjson"), "utf8")
)
  .trim()
  .split("\n")
  .filter(Boolean)
  .map(JSON.parse);
const percent = (value) => Number.parseFloat(String(value).replace("%", ""));
const bytes = (value) => {
  const match = String(value).match(/^([\d.]+)([KMG]iB)$/);
  if (!match) return null;
  return (
    Number(match[1]) * { KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 }[match[2]]
  );
};
const resources = Object.values(
  stats.reduce((result, sample) => {
    const name = sample.Name;
    const memory = bytes(String(sample.MemUsage).split(" / ")[0]);
    const current = result[name] ?? {
      name,
      maxCpuPercent: 0,
      maxMemoryBytes: 0,
    };
    current.maxCpuPercent = Math.max(
      current.maxCpuPercent,
      percent(sample.CPUPerc),
    );
    current.maxMemoryBytes = Math.max(current.maxMemoryBytes, memory ?? 0);
    result[name] = current;
    return result;
  }, {}),
);
const criteria = {
  missingRateBelowOnePercent: report.counters.missingRate < 0.01,
  receiveLatencyP95BelowTwoSeconds:
    report.timings.deviceTimestampToMqttReceiveMs.p95Ms !== null &&
    report.timings.deviceTimestampToMqttReceiveMs.p95Ms < 2000,
  apiLatencyP95Below500Ms:
    api.timings.p95Ms !== null && api.timings.p95Ms < 500,
  apiErrorRateBelowOnePercent: api.errorRate < 0.01,
};
const summary = {
  schemaVersion: 1,
  ...trial,
  endedAt: new Date().toISOString(),
  counters: report.counters,
  timings: report.timings,
  api,
  resources,
  criteria,
  passed: Object.values(criteria).every(Boolean),
};
await writeFile(
  join(directory, "summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
console.log(
  `判定=${summary.passed ? "PASS" : "FAIL"} missing=${summary.counters.missingRate} receiveP95=${summary.timings.deviceTimestampToMqttReceiveMs.p95Ms}ms apiP95=${api.timings.p95Ms}ms apiError=${api.errorRate}`,
);
