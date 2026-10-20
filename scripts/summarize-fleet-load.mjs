import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import console from "node:console";
import {
  summarizeResources,
  firstVisibleMs,
} from "../apps/load-report/dist/fleet-observations.js";
export async function summarizeFleetLoad(directory) {
  const read = async (path) =>
    JSON.parse(await readFile(resolve(directory, path), "utf8"));
  const summary = await read("summary.json");
  for (const result of summary.results) {
    const trial = await read(`${result.name}/trial.json`);
    const resources = await read(`${result.name}/container-stats.json`);
    const expected =
      result.condition === "unresponsive" ? result.count * 0.9 : result.count;
    result.resources = summarizeResources(resources);
    result.ackAllVisibleFromPostMs = firstVisibleMs(
      trial.samples,
      trial.startedAt,
      expected,
      "acknowledged",
    );
    result.executionAllVisibleFromPostMs = firstVisibleMs(
      trial.samples,
      trial.startedAt,
      expected,
      "finished",
    );
    result.database = {
      maxObservedConnections: Math.max(
        ...trial.samples.map((s) => s.connections),
      ),
      maxObservedWaitingLocks: Math.max(
        ...trial.samples.map((s) => s.waiting_locks),
      ),
      maxObservedBacklog: Math.max(...trial.samples.map((s) => s.backlog)),
      lastBacklog: trial.samples.at(-1)?.backlog,
      tableCounts: trial.tableCounts,
      runtime: trial.runtime,
      plan: trial.plan,
    };
    // page本体はtrial.jsonに保持し、集約レポートは全体状態と件数に絞る。
    const { targets, ...operation } = result.operation;
    result.operation = operation;
    result.targetPage = {
      total: targets.total,
      limit: targets.limit,
      offset: targets.offset,
    };
  }
  await writeFile(
    resolve(directory, "report.json"),
    JSON.stringify(summary, null, 2) + "\n",
  );
  console.log(`集約結果: ${directory}/report.json`);
  return summary;
}
if (process.argv[1]?.endsWith("summarize-fleet-load.mjs"))
  await summarizeFleetLoad(process.argv[2]);
